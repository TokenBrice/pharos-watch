#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_INTERVALS } from "../../shared/lib/cron-jobs.ts";
import { isRecord } from "../../shared/lib/type-guards.ts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { evaluateFirstExecutionAcceptance, type FirstExecutionAcceptanceResult } from "../lib/first-execution-acceptance.mts";
import { selectWorkerActivationAt, type ActiveWorkerDeployment, type ListedWorkerDeployment } from "./verify-worker-deployment.ts";

const WORKER_JOBS = {
  "stablecoin-api": ["sync-stablecoins"],
  "stablecoin-heavy": ["sync-dex-liquidity", "compute-safety-score-v9"],
} as const;
const GRACE_SEC = 15 * 60;
const ROW_LIMIT = 200;

type Worker = keyof typeof WORKER_JOBS;
type Job = (typeof WORKER_JOBS)[Worker][number];
type Deployment = { deploySha: string | null; workerVersion: string; activationAtSec: number };
type JobVerdict = FirstExecutionAcceptanceResult & {
  worker: Worker;
  job: Job;
  deployment: Deployment | null;
};
type Verdict = { status: "skip" | "pending" | "passed" | "failed"; jobs: JobVerdict[] };

interface MonitorInput {
  deployments: unknown;
  cronRuns: unknown;
  publishedStablecoins: unknown;
  nowSec: number;
  lookbackSec: number;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 8.64e12;
}

function readActiveDeployment(history: unknown): Deployment | null {
  if (!Array.isArray(history) || !isRecord(history[0])) return null;
  const active: ActiveWorkerDeployment = history[0];
  const version = active.versions?.[0];
  if (typeof active.id !== "string" || !Array.isArray(active.versions) || active.versions.length !== 1 ||
      version?.percentage !== 100 || typeof version.version_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version.version_id)) return null;
  const workerVersion = version.version_id;
  const { activationAtSec } = selectWorkerActivationAt({
    deploymentId: active.id, deployments: history as ListedWorkerDeployment[], workerVersion,
  });
  if (!isTimestamp(activationAtSec)) return null;
  const message = active.annotations?.["workers/message"];
  const deploySha = typeof message === "string" ? /^GitHub Actions deploy ([0-9a-f]{40})$/.exec(message)?.[1] : undefined;
  return { deploySha: deploySha ?? null, workerVersion, activationAtSec };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function readCronRuns(rows: unknown) {
  // A full page can be truncated. It cannot prove all matching attempts were read.
  if (!Array.isArray(rows) || rows.length >= ROW_LIMIT) return null;
  const runs = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.job !== "string" || !isTimestamp(row.started_at) ||
        typeof row.duration_ms !== "number" || !Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0 ||
        typeof row.status !== "string" || !row.status.trim()) return null;
    const metadata = typeof row.metadata === "string" ? parseJson(row.metadata) : row.metadata;
    if (row.metadata !== null && !isRecord(metadata)) return null;
    const fields = isRecord(metadata) ? metadata : {};
    const workerVersion = row.worker_version ?? fields.workerVersion;
    runs.push({
      job: row.job, startedAt: row.started_at, durationMs: row.duration_ms, status: row.status,
      metadata: {
        workerVersion, reason: fields.reason, syncStartSec: fields.syncStartSec,
        cacheWriteMode: fields.cacheWriteMode, cacheWriteSucceeded: fields.cacheWriteSucceeded,
      },
    });
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

type CronRun = NonNullable<ReturnType<typeof readCronRuns>>[number];

function evaluateJob(input: MonitorInput, job: Job, deployment: Deployment, runs: CronRun[]): FirstExecutionAcceptanceResult {
  const { workerVersion, activationAtSec } = deployment;
  const attempts = runs.filter((run) => run.job === job && run.startedAt >= activationAtSec &&
    run.metadata.workerVersion === workerVersion);
  const evaluate = (run: CronRun | undefined, requirePublication = false) => evaluateFirstExecutionAcceptance({
    job, workerVersion, notBefore: activationAtSec,
    status: { timestamp: input.nowSec, job, cron: { runs: run ? [run] : [] } },
    ...(requirePublication ? { requirePublication, publishedStablecoins: input.publishedStablecoins } : {}),
  });
  for (const attempt of attempts) {
    const verdict = evaluate(attempt);
    if (verdict.outcome === "failed") return verdict;
  }
  // A V9 deployment-only recapture is admission deferral. It still needs a completed execution after recapture.
  const first = attempts.find((attempt) => !(job === "compute-safety-score-v9" && attempt.status === "skipped_neutral" &&
    (attempt.metadata.reason === "v9-evaluator-changed-recapture-pending" || attempt.metadata.reason === "v9-capture-advanced")))
    ?? attempts[0];
  if (job !== "sync-stablecoins") return evaluate(first);

  const payload = input.publishedStablecoins;
  const generation = isRecord(payload) && isRecord(payload._meta) ? payload._meta.updatedAt : null;
  if (!isTimestamp(generation) || generation > input.nowSec) {
    return { outcome: "failed", reason: "publication-input-unavailable" };
  }
  const publication = evaluate(first, true);
  const firstGeneration = first?.metadata.syncStartSec;
  if (publication.reason !== "publication-generation-unconfirmed" ||
      !isTimestamp(firstGeneration) || firstGeneration < activationAtSec || generation <= firstGeneration) return publication;
  // The hourly reader can see a later generation from the same version.
  const publisher = attempts.find((attempt) => attempt.metadata.syncStartSec === generation);
  return publisher ? evaluate(publisher, true) : publication;
}

export function evaluatePostDeployFirstExecutions(input: MonitorInput): Verdict {
  const jobs: JobVerdict[] = [];
  const runs = readCronRuns(input.cronRuns);
  for (const [worker, trackedJobs] of Object.entries(WORKER_JOBS) as [Worker, readonly Job[]][]) {
    const deployment = readActiveDeployment(isRecord(input.deployments) ? input.deployments[worker] : null);
    const validClock = isTimestamp(input.nowSec) && Number.isSafeInteger(input.lookbackSec) &&
      input.lookbackSec >= Math.max(...trackedJobs.map((job) => CRON_INTERVALS[job])) + GRACE_SEC;
    const eligible = validClock && deployment && deployment.activationAtSec <= input.nowSec;
    if (eligible && input.nowSec - deployment.activationAtSec > input.lookbackSec) continue;

    for (const job of trackedJobs) {
      let verdict: FirstExecutionAcceptanceResult;
      if (!validClock) verdict = { outcome: "failed", reason: "watch-window-unavailable" };
      else if (!eligible || !deployment.deploySha) verdict = { outcome: "failed", reason: "deployment-input-unavailable" };
      else if (!runs) verdict = { outcome: "failed", reason: "cron-runs-input-unavailable" };
      else {
        verdict = evaluateJob(input, job, deployment, runs);
        if (verdict.outcome === "pending" && input.nowSec >= deployment.activationAtSec + CRON_INTERVALS[job] + GRACE_SEC) {
          verdict = { ...verdict, outcome: "failed" };
        }
      }
      jobs.push({ worker, job, deployment, ...verdict });
    }
  }
  const status = jobs.some(({ outcome }) => outcome === "failed") ? "failed"
    : jobs.some(({ outcome }) => outcome === "pending") ? "pending"
    : jobs.length > 0 ? "passed" : "skip";
  return { status, jobs };
}

export function renderPostDeployFirstExecutionSummary(verdict: Verdict, nowSec: number): string {
  const lines = [`Post-deploy first-execution verdict: **${verdict.status}**`, ""];
  if (verdict.status === "failed") {
    const shas = [...new Set(verdict.jobs.flatMap(({ deployment }) => deployment?.deploySha ? [deployment.deploySha] : []))];
    lines.push(
      `Due: ${new Date((nowSec + 86_400) * 1000).toISOString().slice(0, 10)}`,
      `Origin: ${shas.length ? shas.map((sha) => `\`${sha}\``).join(", ") : "Worker deploy SHA unavailable"}`,
      "Check: Run Post-deploy First Execution on main and review the per-job verdicts.",
      "Done when: The monitor confirms the tracked first executions on the active Worker versions.",
      "",
    );
  }
  if (verdict.jobs.length > 0) {
    lines.push(
      "| Worker | Version | Deploy SHA | Activation (UTC) | Job | Outcome | Reason |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...verdict.jobs.map(({ worker, deployment, job, outcome, reason }) =>
        `| ${worker} | ${deployment?.workerVersion ?? "—"} | ${deployment?.deploySha ?? "—"} | ` +
        `${deployment ? new Date(deployment.activationAtSec * 1000).toISOString() : "—"} | ${job} | ${outcome} | \`${reason}\` |`),
      "",
    );
  }
  return lines.join("\n");
}

export function runPostDeployFirstExecutionCheck(directory: string): void {
  const read = (file: string): unknown => {
    try { return parseJson(readFileSync(join(directory, file), "utf8")); } catch { return null; }
  };
  const cloudflare = read("cloudflare.json");
  const evidence = isRecord(cloudflare) ? cloudflare : {};
  const nowSec = Math.floor(Date.now() / 1000);
  const verdict = evaluatePostDeployFirstExecutions({
    deployments: evidence.deployments,
    cronRuns: evidence.cronRuns,
    publishedStablecoins: read("stablecoins.json"),
    nowSec,
    lookbackSec: typeof evidence.lookbackSec === "number" ? evidence.lookbackSec : Number.NaN,
  });
  console.log(JSON.stringify({
    ...verdict,
    summary: renderPostDeployFirstExecutionSummary(verdict, nowSec),
    recoveryComment: verdict.status === "passed" ?
      "Recovered. The monitor confirmed the tracked executions on the active Worker versions." : undefined,
  }));
}

runDirectCli(import.meta.url, () => runPostDeployFirstExecutionCheck(process.env.POST_DEPLOY_EVIDENCE_DIR ?? "."));
