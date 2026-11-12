import { STATUS_DEPEG_DETECTION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { DEX_FRESHNESS_SEC, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD, DEPEG_DEX_PROTOCOL_CORROBORATION_MIN } from "@shared/lib/depeg-config";
import { DepegDeadBandReceiptSchema } from "@shared/types/depeg-notice";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { parseObjectMetadata } from "./json-metadata";
import { DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT } from "../cron/depeg-detection/types";
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
const DEPEG_LEDGER_CLOCK_READ_LIMIT = Math.ceil((24 * 3600) / CRON_INTERVALS["sync-stablecoins"]);

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
export function parseDepegObservationCensus(parsed: unknown): DepegObservationCensus | null {
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
  const assets: unknown = record.unavailableAssets;
  const unavailableAssets = Array.isArray(assets) && assets.length <= DEPEG_CENSUS_UNAVAILABLE_ID_LIMIT
    && (assets as unknown[]).every((entry) => {
      if (entry == null || typeof entry !== "object") return false;
      const asset = entry as Record<string, unknown>;
      return typeof asset.id === "string" && asset.id.trim().length > 0
        && (CENSUS_GAP_REASONS as readonly unknown[]).includes(asset.reason)
        && typeof asset.reviewedNominalReference === "boolean";
    })
    ? assets as NonNullable<DepegObservationCensus["unavailableAssets"]> : undefined;
  return {
    deadBandNotices: DepegDeadBandReceiptSchema.array().safeParse(record.deadBandNotices).data,
    deadBandNoticesShownCount: isCount(record.deadBandNoticesShownCount) ? record.deadBandNoticesShownCount : undefined,
    deadBandNoticesOmittedCount: isCount(record.deadBandNoticesOmittedCount) ? record.deadBandNoticesOmittedCount : undefined,
    scope: record.scope,
    evaluatedAt: record.evaluatedAt,
    eligibleCount: record.eligibleCount,
    observedCount: record.observedCount,
    unavailableCount: record.unavailableCount,
    belowFloorCount: record.belowFloorCount,
    reasonCounts,
    unavailableAssets,
    unavailableIdsTruncated: typeof record.unavailableIdsTruncated === "boolean" ? record.unavailableIdsTruncated : undefined,
    unavailableIdsDropped: record.unavailableIdsDropped === undefined ? undefined : record.unavailableIdsDropped !== false,
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
    census: parseDepegObservationCensus(parseObjectMetadata(row.census_json)),
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

/** Re-admit persisted notices at the consumer clock; publication never renews observations. */
export function freshDepegDeadBandNotices(value: unknown, nowSec: number) {
  const parsed = DepegDeadBandReceiptSchema.array().safeParse(value);
  if (!parsed.success || new Set(parsed.data.map((receipt) => receipt.eventId)).size !== parsed.data.length) return [];
  const fresh = (clock: number, budget: number, inclusive = false) => clock <= nowSec &&
    (inclusive ? nowSec - clock <= budget : nowSec - clock < budget);
  return parsed.data.filter((receipt) =>
    fresh(receipt.evaluatedAt, CRON_INTERVALS[DEPEG_CENSUS_PRODUCER_JOB] * STATUS_DEPEG_DETECTION_THRESHOLDS.ledgerMaxAgeIntervals, true) &&
    fresh(receipt.publishedAt, DEX_FRESHNESS_SEC) && fresh(receipt.aggregateObservedAt, DEX_FRESHNESS_SEC) &&
    receipt.pricedTvlUsd >= DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD &&
    new Set(receipt.contributors.map((source) => source.family)).size >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN &&
    receipt.contributors.every((source) => fresh(source.observedAt, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC, true) &&
      fresh(source.aggregateObservedAt, DEX_FRESHNESS_SEC, true)));
}
