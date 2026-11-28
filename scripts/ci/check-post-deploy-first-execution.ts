#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_INTERVALS, CRON_SCHEDULE_DEFINITIONS, V9_PUBLICATION_SECOND_CHANCE } from "../../shared/lib/cron-jobs.ts";
import { isRecord } from "../../shared/lib/type-guards.ts";
import { runDirectCli } from "../lib/cli-args.mjs";
import { evaluateFirstExecutionAcceptance, type FirstExecutionAcceptanceResult } from "../lib/first-execution-acceptance.mts";
import { fetchWorkerDeployments } from "./verify-worker-deployment.ts";

const WORKER_JOBS = {
  "stablecoin-api": ["sync-stablecoins"],
  "stablecoin-heavy": ["sync-dex-liquidity", "compute-safety-score-v9"],
} as const;
const LOOKBACK_SEC = 6 * 3600;
const GRACE_SEC = 15 * 60;
const ROW_LIMIT = 100;

type Worker = keyof typeof WORKER_JOBS;
type Job = (typeof WORKER_JOBS)[Worker][number];
const workers = Object.entries(WORKER_JOBS) as [Worker, readonly Job[]][];
const scopedJobs = workers.flatMap(([worker, jobs]) => jobs.map((job) => ({ worker, job, key: `${worker}:${job}` })));
const minimumLookbackSec = Math.max(...scopedJobs.map(({ job }) => CRON_INTERVALS[job])) + GRACE_SEC;

type Deployment = { deploySha: string | null; workerVersion: string; activationAtSec: number };
type ServingWindow = { deployment: Deployment; until: number; active: boolean };
type ExecutionVerdict = { outcome: FirstExecutionAcceptanceResult["outcome"] | "unavailable" | "skip" | "recovered"; reason: string };
type JobVerdict = ExecutionVerdict & { worker: Worker; job: Job; deployment: Deployment | null; active: boolean };
type Issue = { jobs: Job[]; due: string | null };
type Verdict = {
  status: "skip" | "pending" | "passed" | "failed" | "unavailable";
  jobs: JobVerdict[];
  reason?: string;
  issue?: Issue;
  canCloseIssue?: boolean;
};

interface MonitorInput {
  deployments: unknown;
  cronRuns: unknown;
  publishedStablecoins: unknown;
  nowSec: number;
  lookbackSec: number;
  openIssue?: unknown;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 8.64e12;
}

function readOpenIssue(input: unknown): Issue | null {
  if (input === null || input === undefined) return { jobs: [], due: null };
  if (!isRecord(input) || typeof input.number !== "number" || !Number.isSafeInteger(input.number) ||
      input.number < 1 || typeof input.body !== "string") return null;
  const body = input.body;
  const marker = /^<!-- post-deploy-failed-jobs: ([^\r\n]*) -->\r?$/m.exec(body);
  const legacyRows = /^\| (stablecoin-(?:api|heavy)) \| [^|\r\n]* \| [^|\r\n]* \| [^|\r\n]* \| ([\w-]+) \| failed \|/gm;
  const keys = marker ? marker[1].split(" ") : Array.from(body.matchAll(legacyRows), ([, worker, job]) => `${worker}:${job}`);
  const jobs = keys.map((key) => scopedJobs.find((entry) => entry.key === key)?.job);
  if (!jobs.length || jobs.some((job) => job === undefined)) return null;
  return { jobs: jobs.filter((job) => job !== undefined), due: /^Due: (\d{4}-\d{2}-\d{2})\r?$/m.exec(body)?.[1] ?? null };
}

function activationTime(entry: unknown): number {
  return isRecord(entry) && typeof entry.created_on === "string" ? Math.floor(Date.parse(entry.created_on) / 1000) : NaN;
}

function readServingWindows(history: unknown, since: number, nowSec: number): ServingWindow[] | null {
  if (!Array.isArray(history) || !history.length) return null;
  const entries = history.map((entry: unknown) => ({ entry, activationAtSec: activationTime(entry) }));
  const [active, ...previous] = entries;
  if (entries.some(({ activationAtSec }) => !isTimestamp(activationAtSec) || activationAtSec > active.activationAtSec) ||
      active.activationAtSec > nowSec) return null;
  const windows: ServingWindow[] = [];
  let until = nowSec + 1;
  for (const { entry, activationAtSec } of [active, ...previous.sort((a, b) => b.activationAtSec - a.activationAtSec)]) {
    if (windows.length && activationAtSec < since) break;
    if (!isRecord(entry) || typeof entry.id !== "string") return null;
    const versions = Array.isArray(entry.versions) ? entry.versions : [];
    const version = versions[0];
    if (versions.length !== 1 || !isRecord(version) || version.percentage !== 100 || typeof version.version_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version.version_id)) return null;
    const message = isRecord(entry.annotations) ? entry.annotations["workers/message"] : null;
    const deploySha = typeof message === "string" ? /^GitHub Actions deploy ([0-9a-f]{40})$/.exec(message)?.[1] : undefined;
    windows.push({ deployment: { deploySha: deploySha ?? null, workerVersion: version.version_id, activationAtSec }, until, active: !windows.length });
    until = activationAtSec;
  }
  return windows;
}

function readCronRuns(input: unknown, job: Job) {
  const rows = isRecord(input) ? input[job] : null;
  // A full page can be truncated. It cannot prove all matching attempts were read.
  if (!Array.isArray(rows) || rows.length >= ROW_LIMIT) return null;
  const runs = [];
  for (const row of rows) {
    if (!isRecord(row) || row.job !== job || !isTimestamp(row.started_at) ||
        typeof row.duration_ms !== "number" || !Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0 ||
        typeof row.status !== "string" || !row.status.trim()) return null;
    const metadata: unknown = typeof row.metadata === "string" ? parseJson(row.metadata) : row.metadata;
    if (row.metadata !== null && !isRecord(metadata)) return null;
    const fields = isRecord(metadata) ? metadata : {};
    const workerVersion = row.worker_version ?? fields.workerVersion;
    if (workerVersion != null && typeof workerVersion !== "string") return null;
    runs.push({
      job, startedAt: row.started_at, durationMs: row.duration_ms, status: row.status,
      metadata: {
        workerVersion, reason: fields.reason, syncStartSec: fields.syncStartSec,
        cacheWriteMode: fields.cacheWriteMode, cacheWriteSucceeded: fields.cacheWriteSucceeded,
      },
      queueSeed: job === "compute-safety-score-v9" && (fields.mode === "queue-seed" || fields.productive === false ||
        row.productive === 0 || typeof fields.runId === "string" || typeof fields.queueRunId === "string"),
      queueRun: { state: row.v9_state, version: row.v9_worker_version, generation: row.v9_generation, finishedAt: row.v9_finished_at },
    });
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

type CronRun = NonNullable<ReturnType<typeof readCronRuns>>[number];

function neutralSkip(run: CronRun): boolean {
  if (run.job === "sync-stablecoins") return run.status === "skipped_locked";
  const { reason } = run.metadata;
  if (run.job === "compute-safety-score-v9" && run.status === "ok" &&
      reason === "v9-public-materialization-retry-materialized") return true;
  if (run.status !== "skipped_neutral") return false;
  if (run.job === "sync-dex-liquidity") return reason === "liquidity-cadence-reuse" || reason === "scoring-stage-producer-running";
  return typeof reason === "string" && [
    "v9-publication-hourly-already-accepted", "v9-evaluator-changed-recapture-pending", "v9-capture-advanced",
    "v9-capture-already-accepted", "v9-slot-window-too-short", "v9-core-slot-not-ready", "v9-competing-slot-active",
    "v9-memory-lane-active", "v9-public-materialization-already-selected", "v9-public-materialization-retry-superseded",
    "v9-public-materialization-retry-already-failed",
  ].includes(reason);
}

function firstScheduledOpportunity(job: Job, from: number): number {
  const schedule = job === "sync-stablecoins" ? CRON_SCHEDULE_DEFINITIONS.quarterHourly
    : job === "sync-dex-liquidity" ? CRON_SCHEDULE_DEFINITIONS.halfHourlyChartsOffset
    : CRON_SCHEDULE_DEFINITIONS.v9PublicationOffset;
  const next = (offset: number) => Math.ceil((from - offset) / schedule.intervalSec) * schedule.intervalSec + offset;
  return job === "compute-safety-score-v9"
    ? Math.min(next(schedule.offsetSec), next(V9_PUBLICATION_SECOND_CHANCE.offsetSec))
    : next(schedule.offsetSec);
}

function evaluateJob(input: MonitorInput, job: Job, window: ServingWindow, runs: CronRun[], since: number): ExecutionVerdict {
  const { workerVersion, activationAtSec } = window.deployment;
  const recovering = activationAtSec < since;
  const attempts = runs.filter((run) => run.startedAt >= Math.max(activationAtSec, since) && run.startedAt < window.until &&
    (run.metadata.workerVersion === workerVersion || !run.metadata.workerVersion)).filter((run) => !neutralSkip(run));
  const evaluate = (run: CronRun | undefined, requirePublication = false) => evaluateFirstExecutionAcceptance({
    job, workerVersion, notBefore: activationAtSec,
    status: { timestamp: input.nowSec, job, cron: { runs: run ? [run] : [] } },
    ...(requirePublication ? { requirePublication, publishedStablecoins: input.publishedStablecoins } : {}),
  });
  const inspect = (run: CronRun): ExecutionVerdict => {
    if (!run.metadata.workerVersion && ["error", "failed", "degraded"].includes(run.status)) {
      return { outcome: "failed", reason: "unattributed-post-activation-failure" };
    }
    const verdict = evaluate(run);
    if (verdict.reason === "run-not-successful" && run.status.startsWith("skipped")) {
      return { outcome: "failed", reason: "unexpected-run-skip" };
    }
    if (verdict.outcome !== "passed" || !run.queueSeed) return verdict;
    const terminal = run.queueRun;
    if (terminal.version === workerVersion && terminal.state === "active") {
      return { outcome: "pending", reason: "v9-queue-publication-pending" };
    }
    if (terminal.version !== workerVersion || !isTimestamp(terminal.finishedAt) ||
        terminal.finishedAt < run.startedAt || terminal.finishedAt > input.nowSec) {
      return { outcome: "pending", reason: "v9-queue-publication-unconfirmed" };
    }
    return terminal.state === "completed" && typeof terminal.generation === "string" && terminal.generation.length > 0
      ? { outcome: "passed", reason: "v9-queue-publication-confirmed" }
      : { outcome: "failed", reason: "v9-queue-publication-failed" };
  };
  // Recent activations retain failures anywhere in their serving window. An old
  // activation is revisited only for an open issue, using its latest execution.
  const candidates = recovering ? attempts.slice(-1) : attempts;
  const inspected = candidates.map(inspect);
  const failure = inspected.find(({ outcome }) => outcome === "failed");
  if (failure) return failure;
  const first = candidates.find((run) => run.metadata.workerVersion === workerVersion);
  let verdict = first ? inspect(first) : evaluate(undefined);
  if (first && verdict.outcome === "passed" && job === "sync-stablecoins") {
    const payload = input.publishedStablecoins;
    const generation = isRecord(payload) && isRecord(payload._meta) ? payload._meta.updatedAt : null;
    if (!isTimestamp(generation) || generation > input.nowSec) {
      return { outcome: "unavailable", reason: "publication-input-unavailable" };
    }
    verdict = evaluate(first, true);
    const firstGeneration = first.metadata.syncStartSec;
    if (verdict.reason === "publication-generation-unconfirmed" && isTimestamp(firstGeneration) &&
        firstGeneration >= activationAtSec && generation > firstGeneration) {
      // The hourly reader can see a later generation from the same version.
      const publisher = attempts.find((attempt) => attempt.metadata.syncStartSec === generation && attempt.status === "ok" &&
        attempt.metadata.workerVersion === workerVersion);
      if (publisher) verdict = evaluate(publisher, true);
      else if (!window.active) return { outcome: "skip", reason: "superseded-publication-advanced" };
    }
  }
  if (verdict.outcome !== "pending") return verdict;
  if (!window.active && !first && window.until <= firstScheduledOpportunity(job, activationAtSec)) {
    return { outcome: "skip", reason: "superseded-before-first-slot" };
  }
  const observedUntil = window.active ? input.nowSec : window.until;
  if (!recovering && verdict.reason !== "v9-queue-publication-pending" &&
      observedUntil >= activationAtSec + CRON_INTERVALS[job] + GRACE_SEC) {
    return { ...verdict, outcome: "failed" };
  }
  return window.active ? verdict : { outcome: "skip", reason: "superseded-before-confirmation" };
}

export function evaluatePostDeployFirstExecutions(input: MonitorInput): Verdict {
  const jobs: JobVerdict[] = [];
  if (!isRecord(input.deployments)) return { status: "unavailable", reason: "deployment-input-unavailable", jobs };
  if (!isTimestamp(input.nowSec) || !Number.isSafeInteger(input.lookbackSec) ||
      input.lookbackSec < minimumLookbackSec) {
    return { status: "unavailable", reason: "watch-window-unavailable", jobs };
  }
  const issue = readOpenIssue(input.openIssue);
  if (!issue) return { status: "unavailable", reason: "issue-input-unavailable", jobs };
  const since = input.nowSec - input.lookbackSec;
  for (const [worker, trackedJobs] of workers) {
    const windows = readServingWindows(input.deployments[worker], since, input.nowSec);
    if (!windows) {
      for (const job of trackedJobs) jobs.push({ worker, job, deployment: null, active: true,
        outcome: "unavailable", reason: "deployment-input-unavailable" });
      continue;
    }
    const workerJobs: JobVerdict[] = [];
    for (const job of trackedJobs) {
      const applicable = windows.filter(({ deployment }) => deployment.activationAtSec >= since || issue.jobs.includes(job));
      if (!applicable.length) continue;
      const runs = readCronRuns(input.cronRuns, job);
      for (const window of applicable) {
        const verdict = runs ? evaluateJob(input, job, window, runs, since)
          : { outcome: "unavailable" as const, reason: "cron-runs-input-unavailable" };
        workerJobs.push({ worker, job, deployment: window.deployment, active: window.active, ...verdict });
      }
    }
    const activeJobs = workerJobs.filter(({ active }) => active);
    const recovered = activeJobs.length === trackedJobs.length && activeJobs.every(({ outcome }) => outcome === "passed");
    jobs.push(...workerJobs.map((job): JobVerdict => recovered && !job.active && job.outcome === "failed"
      ? { ...job, outcome: "recovered" } : job));
  }
  const status = jobs.some(({ outcome }) => outcome === "unavailable") ? "unavailable"
    : jobs.some(({ outcome }) => outcome === "failed") ? "failed"
    : jobs.some(({ outcome }) => outcome === "pending") ? "pending"
    : jobs.some(({ outcome }) => outcome === "passed") ? "passed" : "skip";
  const canCloseIssue = status !== "unavailable" && status !== "failed" && issue.jobs.length > 0 &&
    issue.jobs.every((job) => jobs.some((entry) => entry.active && entry.job === job && entry.outcome === "passed"));
  return { status, jobs, issue, canCloseIssue };
}

export function renderPostDeployFirstExecutionSummary(verdict: Verdict, nowSec: number): string {
  const lines = [`Post-deploy first-execution verdict: **${verdict.status}**`, ""];
  if (verdict.reason) lines.push(`Reason: \`${verdict.reason}\``, "");
  if (verdict.status === "failed") {
    const failures = verdict.jobs.filter(({ outcome }) => outcome === "failed");
    const failedJobs = new Set([...(verdict.issue?.jobs ?? []), ...failures.map(({ job }) => job)]);
    const shas = [...new Set(failures.map(({ deployment }) => deployment?.deploySha))];
    lines.push(
      `Due: ${verdict.issue?.due ?? new Date((nowSec + 86_400) * 1000).toISOString().slice(0, 10)}`,
      `Origin: ${shas.map((sha) => sha ? `\`${sha}\`` : "Worker deploy SHA unavailable").join(", ")}`,
      "Check: Run Post-deploy First Execution on main and review the per-job verdicts.",
      "Done when: The monitor confirms the tracked executions for the affected jobs on the active Worker versions.",
      `<!-- post-deploy-failed-jobs: ${scopedJobs.filter(({ job }) => failedJobs.has(job)).map(({ key }) => key).join(" ")} -->`,
      "",
    );
  }
  if (verdict.jobs.length > 0) {
    lines.push(
      "| Worker | Version | Deploy SHA | Activation (UTC) | Job | Outcome | Reason |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...verdict.jobs.map(({ worker, deployment, job, outcome, reason }) =>
        `| ${worker} | ${deployment?.workerVersion ?? "—"} | ` +
        `${deployment ? deployment.deploySha ?? "Worker deploy SHA unavailable" : "—"} | ` +
        `${deployment ? new Date(deployment.activationAtSec * 1000).toISOString() : "—"} | ${job} | ${outcome} | \`${reason}\` |`),
      "",
    );
  }
  return lines.join("\n");
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function readJson(directory: string, file: string): unknown {
  try { return parseJson(readFileSync(join(directory, file), "utf8")); } catch { return undefined; }
}

export async function collectPostDeployCloudflareEvidence(directory: string): Promise<void> {
  const fetchRead: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const histories = await Promise.all(workers.map(async ([worker]) =>
    [worker, await fetchWorkerDeployments(process.env, fetchRead, worker).catch(() => null)] as const));
  const nowSec = Math.floor(Date.now() / 1000);
  const since = nowSec - LOOKBACK_SEC;
  const issue = readOpenIssue(readJson(directory, "issue.json") ?? null);
  const cronRuns: Partial<Record<Job, unknown>> = {};
  try {
    const config = readFileSync("worker/wrangler.toml", "utf8");
    const bindings = config.split(/^\[\[d1_databases\]\]\s*$/m).slice(1).map((section) => section.split(/^\[/m, 1)[0]);
    const db = bindings.find((section) => /^binding\s*=\s*"DB"\s*$/m.test(section));
    const id = db?.match(/^database_id\s*=\s*"([0-9a-f-]+)"\s*$/m)?.[1];
    if (id) {
      const account = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
      await Promise.all(histories.flatMap(([worker, history]) => {
        const windows = readServingWindows(history, since, nowSec);
        if (!windows) return [];
        const oldest = windows[windows.length - 1].deployment.activationAtSec;
        return WORKER_JOBS[worker].filter((job) => oldest >= since || issue?.jobs.includes(job)).map(async (job) => {
          try {
            const v9 = job === "compute-safety-score-v9";
            const response = await fetchRead(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`, {
              method: "POST",
              headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                sql: "SELECT c.job, c.started_at, c.duration_ms, c.status, c.metadata, c.worker_version, c.productive"
                  + (v9 ? ", v.state AS v9_state, v.worker_version AS v9_worker_version, v.publication_generation_id AS v9_generation,"
                    + " v.finished_at AS v9_finished_at FROM cron_runs c LEFT JOIN v9_eval_runs v ON v.run_id = CASE WHEN json_valid(c.metadata)"
                    + " THEN coalesce(json_extract(c.metadata, '$.runId'), json_extract(c.metadata, '$.queueRunId')) END"
                    : " FROM cron_runs c")
                  + " WHERE c.job = ? AND c.started_at >= ? ORDER BY c.started_at ASC, c.id ASC LIMIT ?",
                params: [job, String(Math.max(oldest, since)), String(ROW_LIMIT)],
              }),
            });
            const payload = response.ok ? await response.json() : null;
            const query = payload?.result?.[0];
            if (payload?.success === true && query?.success === true && Array.isArray(query.results)) cronRuns[job] = query.results;
          } catch {
            // Missing results are graded without exposing provider errors.
          }
        });
      }));
    }
  } catch {
    // A missing binding leaves the required D1 evidence unavailable.
  }
  writeFileSync(join(directory, "cloudflare.json"), JSON.stringify({
    deployments: Object.fromEntries(histories), cronRuns, lookbackSec: LOOKBACK_SEC,
  }));
}

export function runPostDeployFirstExecutionCheck(directory: string): void {
  const cloudflare = readJson(directory, "cloudflare.json");
  const evidence = isRecord(cloudflare) ? cloudflare : {};
  const nowSec = Math.floor(Date.now() / 1000);
  const openIssue = readJson(directory, "issue.json");
  const verdict = evaluatePostDeployFirstExecutions({
    deployments: evidence.deployments,
    cronRuns: evidence.cronRuns,
    publishedStablecoins: readJson(directory, "stablecoins.json"),
    nowSec,
    lookbackSec: typeof evidence.lookbackSec === "number" ? evidence.lookbackSec : Number.NaN,
    openIssue: openIssue === undefined ? {} : openIssue,
  });
  console.log(JSON.stringify({
    ...verdict,
    summary: renderPostDeployFirstExecutionSummary(verdict, nowSec),
    recoveryComment: verdict.canCloseIssue ?
      "Recovered. The monitor confirmed the tracked executions for the affected jobs on the active Worker versions." : undefined,
  }));
}

runDirectCli(import.meta.url, () => runPostDeployFirstExecutionCheck(process.env.POST_DEPLOY_EVIDENCE_DIR ?? "."));
