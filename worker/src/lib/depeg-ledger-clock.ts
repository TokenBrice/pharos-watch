import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "./d1-overload-retry";
import type {
  DepegObservationCensus,
  DepegObservationGapReason,
} from "../cron/depeg-detection/types";

/**
 * The stablecoins sync run owns the detection pass, so its `cron_runs` row
 * carries the only per-run evidence that a depeg ledger update actually
 * completed: `capabilities.depegPipeline` plus the observation census.
 */
export const DEPEG_CENSUS_PRODUCER_JOB = "sync-stablecoins";

/** Canary window: the newest run plus its predecessors for consecutive-run comparisons. */
const DEPEG_CENSUS_RUN_READ_LIMIT = 4;
/**
 * Status clock window: a held or failing detection pass can outlast the canary
 * window, and the newest completed census is exactly the age the operator
 * needs. One day of producer runs stays a bounded index read.
 */
export const DEPEG_LEDGER_CLOCK_READ_LIMIT = Math.ceil((24 * 3600) / CRON_INTERVALS["sync-stablecoins"]);

const CENSUS_GAP_REASONS: readonly DepegObservationGapReason[] = [
  "asset-absent",
  "primary-unusable",
  "supply-unavailable",
  "non-authoritative-reference",
  "invalid-reference",
  "invalid-price",
  "native-quote-unavailable",
  "native-quote-implausible",
];

/** One producer run's detection evidence, decoded from `cron_runs.metadata`. */
export interface DepegCensusRun {
  runStartedAt: number;
  /** `capabilities.depegPipeline`: the detection pass completed instead of held or failed. */
  pipelineSucceeded: boolean;
  census: DepegObservationCensus | null;
  unavailableReason: string | null;
}

interface DepegCensusRow {
  started_at: number;
  census_json: string | null;
  pipeline_succeeded: number | null;
  unavailable_reason: string | null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseReasonCounts(value: unknown): Partial<Record<DepegObservationGapReason, number>> | null {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const counts: Partial<Record<DepegObservationGapReason, number>> = {};
  for (const [reason, count] of Object.entries(value as Record<string, unknown>)) {
    // Reasons are an additive vocabulary: a newer producer code is skipped, not
    // allowed to invalidate the counts this reader does understand.
    if (!CENSUS_GAP_REASONS.includes(reason as DepegObservationGapReason)) continue;
    if (!isCount(count)) return null;
    counts[reason as DepegObservationGapReason] = count;
  }
  return counts;
}

/** A malformed census is unavailable evidence, never a measured zero (R2). */
function parseCensus(value: string | null): DepegObservationCensus | null {
  if (value == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const reasonCounts = parseReasonCounts(record.reasonCounts);
  if (
    record.scope !== "psi-non-nav-before-supply-floor"
    || !isCount(record.evaluatedAt)
    || !isCount(record.eligibleCount)
    || !isCount(record.observedCount)
    || !isCount(record.unavailableCount)
    || !isCount(record.belowFloorCount)
    || reasonCounts == null
  ) {
    return null;
  }
  return {
    scope: record.scope,
    evaluatedAt: record.evaluatedAt,
    eligibleCount: record.eligibleCount,
    observedCount: record.observedCount,
    unavailableCount: record.unavailableCount,
    belowFloorCount: record.belowFloorCount,
    reasonCounts,
  };
}

/** Newest runs first; the projection keeps the 64 KiB metadata row off the wire. */
export async function loadDepegCensusRuns(
  db: D1Database,
  limit = DEPEG_CENSUS_RUN_READ_LIMIT,
): Promise<DepegCensusRun[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* pharos:depeg-census-runs */
           started_at,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.quality.depegObservation') END AS census_json,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.capabilities.depegPipeline') END AS pipeline_succeeded,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.quality.depegObservationUnavailableReason') END AS unavailable_reason
         FROM cron_runs
         WHERE job = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(DEPEG_CENSUS_PRODUCER_JOB, limit)
      .all<DepegCensusRow>(),
  );
  return (rows.results ?? []).map((row) => ({
    runStartedAt: row.started_at,
    pipelineSucceeded: row.pipeline_succeeded === 1,
    census: parseCensus(row.census_json),
    unavailableReason: typeof row.unavailable_reason === "string" ? row.unavailable_reason : null,
  }));
}

/** Newest run that published a completed census; the depeg ledger's output clock. */
export function latestDepegLedgerRun(runs: readonly DepegCensusRun[]): DepegCensusRun | null {
  return runs.find((run) => run.pipelineSucceeded && run.census != null) ?? null;
}

/** Status clock: the newest completed census across the longer clock read window. */
export async function loadLatestDepegLedgerRunAt(db: D1Database): Promise<number | null> {
  const runs = await loadDepegCensusRuns(db, DEPEG_LEDGER_CLOCK_READ_LIMIT);
  return latestDepegLedgerRun(runs)?.runStartedAt ?? null;
}
