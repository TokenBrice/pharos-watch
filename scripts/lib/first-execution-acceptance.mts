import { readFileSync } from "node:fs";
import { isRecord } from "@shared/lib/type-guards";
import { parseStrictCliArgs } from "./cli-args.mjs";
import { runAsCli } from "./source-files.mts";
import type { PostDeployAcceptanceOutcome } from "./post-deploy-acceptance.mts";

export interface FirstExecutionAcceptanceInput {
  /** Saved /api/status payload, including crons[job].lastRun. */
  status: unknown;
  job: string;
  workerVersion: string;
  notBefore: number;
  /** Saved /api/stablecoins payload; generation must match run metadata.syncStartSec. */
  publishedStablecoins?: unknown;
  requirePublication?: boolean;
}

export interface FirstExecutionAcceptanceResult {
  outcome: PostDeployAcceptanceOutcome;
  reason: string;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Evaluate existing collected evidence, without fetching, polling or changing state.
 * The collector retains the first relevant observation; lastRun alone cannot prove
 * that no earlier execution failed or that the selected execution was the first.
 */
export function evaluateFirstExecutionAcceptance(input: FirstExecutionAcceptanceInput): FirstExecutionAcceptanceResult {
  const { status, job, workerVersion, notBefore } = input;
  if (!job.trim() || !workerVersion.trim() || !isTimestamp(notBefore)) {
    throw new Error("Acceptance requires an explicit job, Worker version and positive Unix not-before time.");
  }
  if (!isRecord(status) || !isTimestamp(status.timestamp)) return { outcome: "pending", reason: "status-time-unavailable" };
  const cron = isRecord(status.crons) ? status.crons[job] : null;
  const run = isRecord(cron) && isRecord(cron.lastRun) ? cron.lastRun : null;
  if (!run) return { outcome: "pending", reason: "run-missing" };
  const metadata = isRecord(run.metadata) ? run.metadata : null;
  if (!metadata?.workerVersion) return { outcome: "pending", reason: "worker-version-missing" };
  if (metadata.workerVersion !== workerVersion) return { outcome: "pending", reason: "worker-version-mismatch" };
  if (!isTimestamp(run.startedAt) || typeof run.durationMs !== "number" ||
      !Number.isSafeInteger(run.durationMs) || run.durationMs < 0 ||
      Math.floor(run.startedAt + run.durationMs / 1000) > status.timestamp) {
    return { outcome: "pending", reason: "incomplete-or-invalid-run-time" };
  }
  if (run.startedAt < notBefore) return { outcome: "pending", reason: "run-before-activation" };
  if (run.status === "error" || run.status === "failed") return { outcome: "failed", reason: "run-failed" };
  if (run.status === "degraded") return { outcome: "failed", reason: "run-degraded" };
  if (run.status !== "ok") return { outcome: "pending", reason: "run-not-successful" };
  const checkPublication = input.requirePublication || input.publishedStablecoins !== undefined;
  if (checkPublication) {
    if (job !== "sync-stablecoins") return { outcome: "pending", reason: "publication-contract-unsupported" };
    if (metadata.cacheWriteMode !== "published" || metadata.cacheWriteSucceeded === false) {
      return { outcome: "pending", reason: "publication-write-unconfirmed" };
    }
    const payload = input.publishedStablecoins;
    const generation = isRecord(payload) && isRecord(payload._meta) ? payload._meta.updatedAt : null;
    if (!isTimestamp(metadata.syncStartSec) || !isTimestamp(generation) ||
        generation !== metadata.syncStartSec || generation < notBefore || generation > status.timestamp) {
      return { outcome: "pending", reason: "publication-generation-unconfirmed" };
    }
  }
  return { outcome: "passed", reason: checkPublication ? "execution-and-publication-confirmed" : "execution-confirmed" };
}

/** Evaluate saved files only; no new collector, network requests or production access. */
export function runFirstExecutionAcceptanceCli(argv: readonly string[]): number {
  const { values } = parseStrictCliArgs(argv, { options: {
    status: { type: "string" }, job: { type: "string" }, "worker-version": { type: "string" },
    "not-before": { type: "string" }, stablecoins: { type: "string" }, "require-publication": { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node --import tsx scripts/lib/first-execution-acceptance.mts --status <saved.json> --job <job> --worker-version <version> --not-before <unix-seconds> [--stablecoins <saved.json>] [--require-publication]");
    return 0;
  }
  for (const key of ["status", "job", "worker-version", "not-before"] as const) {
    if (typeof values[key] !== "string" || !values[key].trim()) throw new Error(`Missing required --${key}.`);
  }
  const result = evaluateFirstExecutionAcceptance({
    status: JSON.parse(readFileSync(values.status as string, "utf8")),
    job: values.job as string, workerVersion: values["worker-version"] as string,
    notBefore: Number(values["not-before"]),
    requirePublication: values["require-publication"] === true,
    ...(typeof values.stablecoins === "string" ? { publishedStablecoins: JSON.parse(readFileSync(values.stablecoins, "utf8")) } : {}),
  });
  console.log(JSON.stringify(result));
  return result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
}

runAsCli(import.meta.url, () => {
  try {
    return runFirstExecutionAcceptanceCli(process.argv.slice(2));
  } catch {
    // JSON parse failures can contain fragments of the saved authenticated response.
    console.error("Acceptance input is invalid or unreadable. Use --help for required arguments.");
    return 2;
  }
});
