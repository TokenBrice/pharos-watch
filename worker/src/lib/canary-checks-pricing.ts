import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getActiveAssetServiceBreadthThreshold } from "@shared/lib/status-thresholds";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { CanaryCheckResult } from "./canary-checks";
import type { CanaryCheckContext, CanaryCheckDefinition } from "./canary-checks";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { boundedJson, parseObjectMetadata } from "./json-metadata";

/**
 * Pricing and FX canaries read the producer's already-persisted cron metadata
 * instead of re-reading payloads: one indexed `cron_runs` row (bounded LIMIT)
 * per measurement, and the counts the producer itself published. They close the
 * "producer reports ok while the priced or depeg-observed cohort is partial"
 * gap without adding an outbound fetch or a new table. Only a published
 * generation carries coverage evidence: a newer lease/priority skip, blocked
 * payload or stale-slot reconciliation row must not outrank it (ADR-29).
 */

type CanaryFinding = Omit<CanaryCheckResult, "checkId" | "label" | "description" | "observedAt" | "durationMs">;

const MAX_CANARY_METADATA_JSON_CHARS = 4_000;
const MAX_CANARY_ERROR_CHARS = 800;
/** Two producer intervals: older evidence is not a current measurement (R3). */
const STABLECOINS_RUN_MAX_AGE_SEC = CRON_INTERVALS["sync-stablecoins"] * 2;

interface StablecoinsRunRow {
  started_at: number;
  status: string | null;
  metadata: string | null;
}

interface DepegObservationCensusSnapshot {
  eligibleCount: number;
  observedCount: number;
  unavailableCount: number;
  belowFloorCount: number;
  reasonCounts: Record<string, number>;
}

function boundedText(value: string, maxChars = MAX_CANARY_ERROR_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function okResult(metadata?: Record<string, unknown>): CanaryFinding {
  return { status: "ok", severity: "info", executionStatus: "completed", executionFailureReason: null, metadata };
}

function degradedResult(error: string, metadata?: Record<string, unknown>): CanaryFinding {
  return { status: "degraded", severity: "warning", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function errorResult(error: string, metadata?: Record<string, unknown>): CanaryFinding {
  return { status: "error", severity: "error", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function failedResult(reason: string, metadata?: Record<string, unknown>): CanaryFinding {
  return { ...errorResult(reason, metadata), executionStatus: "failed", executionFailureReason: reason };
}

function unavailableResult(error: unknown): CanaryFinding {
  return failedResult("canary-source-unavailable", { error: boundedText(toErrorMessage(error)) });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedSourceDistribution(value: unknown): Record<string, unknown> | undefined {
  const distribution = asRecord(value);
  if (!distribution) return undefined;
  return parseObjectMetadata(boundedJson(distribution, MAX_CANARY_METADATA_JSON_CHARS / 2));
}

async function loadRecentStablecoinsRuns(
  db: D1Database,
  limit: number,
  signal?: AbortSignal,
): Promise<StablecoinsRunRow[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* canary-stablecoins-pricing-runs */
           started_at, status, metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND metadata IS NOT NULL
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
      )
      .bind(limit)
      .all<StablecoinsRunRow>(),
    undefined,
    signal,
  );
  return (rows.results ?? []).slice(0, limit);
}

/** Only a published generation wrote coverage; every other status is an attempt. */
function isPublishedStablecoinsRun(row: StablecoinsRunRow): boolean {
  return parseObjectMetadata(row.metadata)?.cacheWriteMode === "published";
}

/**
 * Newest published generations inside the producer's own freshness budget. The
 * time bound keeps this an indexed `(job, started_at)` range seek even when a
 * long run of attempts never publishes.
 */
async function loadPublishedStablecoinsRuns(
  db: D1Database,
  observedAt: number,
  limit: number,
  signal?: AbortSignal,
): Promise<StablecoinsRunRow[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* canary-stablecoins-published-runs */
           started_at, status, metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND metadata IS NOT NULL
          AND started_at >= ?
          AND CASE WHEN json_valid(metadata)
                THEN json_extract(metadata, '$.cacheWriteMode') END = 'published'
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
      )
      .bind(observedAt - STABLECOINS_RUN_MAX_AGE_SEC, limit)
      .all<StablecoinsRunRow>(),
    undefined,
    signal,
  );
  return (rows.results ?? []).slice(0, limit).filter(isPublishedStablecoinsRun);
}

type StablecoinsMeasurementRows =
  | { ok: true; rows: StablecoinsRunRow[] }
  | { ok: false; finding: CanaryFinding };

/**
 * Rows a pricing canary may grade. The newest attempt still owns the stale
 * verdict, but a non-publishing attempt is not coverage evidence: the last
 * published generation inside the two-interval budget is graded instead. When
 * none exists, the measurement fails closed rather than reporting a cohort the
 * producer never published.
 */
async function loadStablecoinsMeasurementRows(
  db: D1Database,
  observedAt: number,
  signal?: AbortSignal,
): Promise<StablecoinsMeasurementRows> {
  const recent = await loadRecentStablecoinsRuns(db, 2, signal);
  const newestAttempt = recent[0];
  if (!newestAttempt) {
    return { ok: false, finding: failedResult("sync-stablecoins-run-unavailable") };
  }
  const staleReason = staleRunReason(newestAttempt, observedAt);
  if (staleReason) {
    return {
      ok: false,
      finding: failedResult(staleReason, runTimeMetadata(newestAttempt, observedAt)),
    };
  }
  if (recent.every(isPublishedStablecoinsRun)) return { ok: true, rows: recent };
  const published = await loadPublishedStablecoinsRuns(db, observedAt, 2, signal);
  if (published.length === 0) {
    return {
      ok: false,
      finding: failedResult(
        "sync-stablecoins-run-unavailable",
        runTimeMetadata(newestAttempt, observedAt),
      ),
    };
  }
  return { ok: true, rows: published };
}

function runTimeMetadata(row: StablecoinsRunRow, observedAt: number): Record<string, unknown> {
  return {
    producer: "sync-stablecoins",
    runStartedAt: row.started_at,
    runStatus: row.status,
    runAgeSec: Math.max(0, observedAt - row.started_at),
    maxAgeSec: STABLECOINS_RUN_MAX_AGE_SEC,
  };
}

function staleRunReason(row: StablecoinsRunRow, observedAt: number): string | null {
  return observedAt - row.started_at > STABLECOINS_RUN_MAX_AGE_SEC ? "sync-stablecoins-run-stale" : null;
}

/**
 * Published priced-cohort coverage: an empty cohort is an error, and a missing
 * share at the shared 5% active-asset breadth is degraded. Both thresholds come
 * from the status authority; the check adds a named cohort entry, not a new
 * band. The producer-side collapse rule is separate (`stablecoin-price-coverage-collapse`).
 */
async function checkStablecoinsActivePriceCoverage(
  db: D1Database,
  observedAt: number,
  _context: CanaryCheckContext,
  signal?: AbortSignal,
): Promise<CanaryFinding> {
  try {
    // The latest published generation plus its predecessor for the diagnostic
    // baseline. Both checks share one bounded read path; the published-only
    // select runs only when a newer attempt did not publish.
    const measurement = await loadStablecoinsMeasurementRows(db, observedAt, signal);
    if (!measurement.ok) return measurement.finding;
    const row = measurement.rows[0];
    if (!row) return failedResult("sync-stablecoins-run-unavailable");
    const previousRow = measurement.rows[1];
    const metadata = parseObjectMetadata(row.metadata);
    const coverage = asRecord(metadata?.activePriceCoverage);
    const expectedActiveCount = integerOrNull(coverage?.expectedActiveCount);
    const pricedActiveCount = integerOrNull(coverage?.pricedActiveCount);
    const missingPriceCount = integerOrNull(coverage?.missingPriceCount);
    const nominalReferenceCount = integerOrNull(coverage?.nominalReferenceCount);
    const priceSourceHealth = asRecord(metadata?.priceSourceHealth);
    const finding = {
      ...runTimeMetadata(row, observedAt),
      expectedActiveCount,
      pricedActiveCount,
      missingPriceCount,
      nominalReferenceCount,
      previousPricedActiveCount: integerOrNull(
        asRecord(parseObjectMetadata(previousRow?.metadata)?.activePriceCoverage)?.pricedActiveCount,
      ),
      sourceDistribution: boundedSourceDistribution(
        asRecord(priceSourceHealth?.active)?.sourceDistribution ?? priceSourceHealth?.sourceDistribution,
      ),
    };
    const staleReason = staleRunReason(row, observedAt);
    if (staleReason) return failedResult(staleReason, finding);
    if (expectedActiveCount == null || pricedActiveCount == null || missingPriceCount == null) {
      return failedResult("active-price-coverage-unreported", finding);
    }
    if (expectedActiveCount <= 0) return failedResult("active-price-coverage-cohort-unknown", finding);
    if (nominalReferenceCount != null
      && pricedActiveCount + missingPriceCount + nominalReferenceCount !== expectedActiveCount) {
      return degradedResult(
        `active price coverage counts do not add up: priced ${pricedActiveCount} + missing ${missingPriceCount} ` +
        `+ nominal ${nominalReferenceCount} != expected ${expectedActiveCount}`,
        finding,
      );
    }
    if (pricedActiveCount === 0) {
      return errorResult(`priced active cohort is empty (${expectedActiveCount} expected)`, finding);
    }
    const breadth = getActiveAssetServiceBreadthThreshold(expectedActiveCount);
    if (breadth != null && missingPriceCount >= breadth) {
      return degradedResult(
        `${missingPriceCount}/${expectedActiveCount} active assets are unpriced (breadth ${breadth})`,
        finding,
      );
    }
    return okResult(finding);
  } catch (error) {
    return unavailableResult(error);
  }
}

function parseCensus(value: unknown): DepegObservationCensusSnapshot | null {
  const census = asRecord(value);
  if (!census) return null;
  const eligibleCount = integerOrNull(census.eligibleCount);
  const observedCount = integerOrNull(census.observedCount);
  const unavailableCount = integerOrNull(census.unavailableCount);
  const belowFloorCount = integerOrNull(census.belowFloorCount);
  if (eligibleCount == null || observedCount == null || unavailableCount == null || belowFloorCount == null) {
    return null;
  }
  const reasonCounts: Record<string, number> = {};
  for (const [reason, count] of Object.entries(asRecord(census.reasonCounts) ?? {})) {
    const parsed = integerOrNull(count);
    if (parsed != null && parsed > 0) reasonCounts[reason] = parsed;
  }
  return { eligibleCount, observedCount, unavailableCount, belowFloorCount, reasonCounts };
}

function reasonDelta(
  previous: DepegObservationCensusSnapshot,
  current: DepegObservationCensusSnapshot,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [reason, count] of Object.entries(current.reasonCounts)) {
    const increase = count - (previous.reasonCounts[reason] ?? 0);
    if (increase > 0) delta[reason] = increase;
  }
  return delta;
}

/**
 * Depeg observation coverage: a held or failed detection stage has no census
 * and is named; a census that stops observing previously observed assets (for
 * example a non-USD fiat peg losing its authoritative FX reference) is a
 * machine-readable shrunken cohort. Comparing against the previous published
 * generation keeps permanent exclusions (VAR/OTHER, reviewed gaps) out of the
 * finding instead of inventing an expected reason baseline.
 */
async function checkDepegObservationCoverage(
  db: D1Database,
  observedAt: number,
  _context: CanaryCheckContext,
  signal?: AbortSignal,
): Promise<CanaryFinding> {
  try {
    const measurement = await loadStablecoinsMeasurementRows(db, observedAt, signal);
    if (!measurement.ok) return measurement.finding;
    const rows = measurement.rows;
    const row = rows[0];
    if (!row) return failedResult("sync-stablecoins-run-unavailable");
    const metadata = parseObjectMetadata(row.metadata);
    const quality = asRecord(metadata?.quality);
    const reason = typeof quality?.depegObservationUnavailableReason === "string"
      ? quality.depegObservationUnavailableReason
      : null;
    const censusValue = quality ? quality.depegObservation : undefined;
    const finding = {
      ...runTimeMetadata(row, observedAt),
      censusScope: asRecord(censusValue)?.scope ?? null,
      eligibleCount: null as number | null,
      observedCount: null as number | null,
      unavailableCount: null as number | null,
      belowFloorCount: null as number | null,
      reasonCounts: null as Record<string, number> | null,
      baselineAvailable: false,
      unavailableReason: reason,
    };
    const staleReason = staleRunReason(row, observedAt);
    if (staleReason) return failedResult(staleReason, finding);

    if (censusValue === null || censusValue === undefined) {
      // A held or failed depeg stage publishes `depegObservation: null` plus a
      // reason; an absent field means the producer did not report at all (R2).
      if (reason && "depegObservation" in (quality ?? {})) {
        return degradedResult(`depeg observation census unavailable: ${reason}`, finding);
      }
      return failedResult("depeg-observation-unreported", finding);
    }
    const census = parseCensus(censusValue);
    if (!census) return failedResult("depeg-observation-census-invalid", finding);
    if (census.eligibleCount <= 0) return failedResult("depeg-observation-cohort-unknown", finding);
    Object.assign(finding, {
      eligibleCount: census.eligibleCount,
      observedCount: census.observedCount,
      unavailableCount: census.unavailableCount,
      belowFloorCount: census.belowFloorCount,
      reasonCounts: census.reasonCounts,
    });
    if (census.observedCount + census.unavailableCount + census.belowFloorCount !== census.eligibleCount) {
      return degradedResult(
        `depeg observation census counts do not add up: observed ${census.observedCount} + unavailable ` +
        `${census.unavailableCount} + below-floor ${census.belowFloorCount} != eligible ${census.eligibleCount}`,
        finding,
      );
    }
    if (census.observedCount === 0) {
      return errorResult(`depeg observation observed 0 of ${census.eligibleCount} eligible assets`, finding);
    }
    const previous = rows[1] ? parseCensus(asRecord(parseObjectMetadata(rows[1].metadata)?.quality)?.depegObservation) : null;
    if (!previous) return okResult(finding);
    finding.baselineAvailable = true;
    if (census.unavailableCount > previous.unavailableCount) {
      const delta = reasonDelta(previous, census);
      const reasons = Object.entries(delta).map(([name, count]) => `${name}+${count}`).join(",") || "no-reason";
      return degradedResult(
        `depeg observation cohort shrank: unavailable ${previous.unavailableCount} -> ${census.unavailableCount} ` +
        `(${reasons})`,
        { ...finding, unavailableDelta: census.unavailableCount - previous.unavailableCount, reasonDelta: delta },
      );
    }
    return okResult(finding);
  } catch (error) {
    return unavailableResult(error);
  }
}

export const PRICING_CANARY_CHECKS: readonly CanaryCheckDefinition[] = [
  {
    checkId: "stablecoins-active-price-coverage",
    label: "Stablecoins active price coverage",
    description: "The latest sync-stablecoins run reports a non-empty priced active cohort and keeps unpriced active assets below the shared 5% breadth share.",
    run: checkStablecoinsActivePriceCoverage,
  },
  {
    checkId: "depeg-observation-coverage",
    label: "Depeg observation coverage",
    description: "The latest sync-stablecoins run reports a complete depeg observation census whose unavailable cohort did not grow against the previous generation.",
    run: checkDepegObservationCoverage,
  },
] as const;
