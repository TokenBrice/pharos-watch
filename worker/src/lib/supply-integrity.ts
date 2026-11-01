import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import {
  STATUS_SUPPLY_VALUE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getCache, setCache } from "./db-cache";
import {
  STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE,
  classifyStablecoinPublicationGap,
  type StablecoinPublicationGapBand,
} from "./stablecoin-publication-coverage";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
} from "./stablecoins-cache";
import { getCompletedSupplySnapshot } from "./supply-snapshot-completion";

/** Confirmation memory for the operator watchdog: a finding must persist across two runs. */
export const SUPPLY_INTEGRITY_CONFIRM_KEY = "cron-staleness-watchdog:supply-confirm:v1";
const SUPPLY_INTEGRITY_CONFIRM_RUNS = 2;
const MAX_REPORTED_IDS = 20;

export interface SupplyValueDriftFinding {
  stablecoinId: string;
  currentUsd: number;
  previousUsd: number;
  ratio: number;
}

export interface SupplyValueIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  checkedCount: number;
  excludedCount: number;
  driftFindings: SupplyValueDriftFinding[];
  aggregateCurrentUsd: number | null;
  aggregatePreviousUsd: number | null;
  aggregateRatio: number | null;
  frozen: boolean;
  carryIds: string[];
  carryOldestAgeSec: number | null;
  carryUnclockedCount: number;
  expectedActiveCount: number;
  cacheUpdatedAt: number | null;
  historyFromDate: number | null;
}

export interface SupplyAvailabilityIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  observedCount: number | null;
  unavailableCount: number | null;
  share: number | null;
  consecutiveGenerations: number;
  latestRunStartedAt: number | null;
  charts: {
    status: "ok" | "unknown" | "truncated";
    reason: string | null;
    runStartedAt: number | null;
    codes: string[];
  };
}

export interface SupplySnapshotIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  expectedDate: number;
  snapshotDate: number | null;
  due: boolean;
  current: boolean;
  identityVerified: boolean;
  expectedActiveCount: number | null;
  accountedActiveCount: number | null;
  writtenRows: number | null;
  persistedRows: number | null;
  unavailableActiveIds: string[] | null;
  band: StablecoinPublicationGapBand | null;
}

export interface SupplyIntegrityReport {
  observedAt: number;
  value: SupplyValueIntegrityReport;
  availability: SupplyAvailabilityIntegrityReport;
  snapshot: SupplySnapshotIntegrityReport;
}

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
  supply_provenance: string | null;
}

interface SyncStablecoinsRunRow {
  started_at: number;
  status: string;
  metadata: string | null;
}

interface ChartsRunRow {
  started_at: number;
  status: string;
  metadata: string | null;
}

interface ChartsContinuityEvidence {
  status: "ok" | "unknown" | "truncated";
  reason: string | null;
  runStartedAt: number | null;
  codes: string[];
}

function parseChartsRun(row: ChartsRunRow | undefined): ChartsContinuityEvidence {
  if (!row) return { status: "unknown", reason: "sync-stablecoin-charts-run-unavailable", runStartedAt: null, codes: [] };
  let parsed: unknown;
  try {
    parsed = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    return { status: "unknown", reason: "sync-stablecoin-charts-metadata-unreadable", runStartedAt: row.started_at, codes: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: "unknown", reason: "sync-stablecoin-charts-metadata-unavailable", runStartedAt: row.started_at, codes: [] };
  }
  const metadata = parsed as {
    reason?: unknown;
    cacheWriteMode?: unknown;
    lastWriteAdvanced?: unknown;
    quality?: { reason?: unknown; codes?: unknown };
  };
  const reason = typeof metadata.reason === "string"
    ? metadata.reason
    : typeof metadata.quality?.reason === "string" ? metadata.quality.reason : null;
  const codes = Array.isArray(metadata.quality?.codes)
    ? metadata.quality.codes.filter((code): code is string => typeof code === "string").slice(0, 10)
    : [];
  if (reason === "chart-history-truncated") {
    return { status: "truncated", reason, runStartedAt: row.started_at, codes };
  }
  // Only a run that actually published (or confirmed a newer canonical cache)
  // is recovery evidence. A cadence skip, error, or unconfirmed CAS skip is
  // unknown, never a healthy chart generation (R2).
  const published = metadata.cacheWriteMode === "published" || metadata.lastWriteAdvanced === true;
  if ((row.status === "ok" || row.status === "degraded") && published) {
    return { status: "ok", reason: null, runStartedAt: row.started_at, codes };
  }
  return {
    status: "unknown",
    reason: row.status === "error" ? "sync-stablecoin-charts-run-error" : "sync-stablecoin-charts-no-publication-evidence",
    runStartedAt: row.started_at,
    codes,
  };
}

function unknownValueIntegrity(reason: string): SupplyValueIntegrityReport {
  return {
    status: "unknown",
    reason,
    checkedCount: 0,
    excludedCount: 0,
    driftFindings: [],
    aggregateCurrentUsd: null,
    aggregatePreviousUsd: null,
    aggregateRatio: null,
    frozen: false,
    carryIds: [],
    carryOldestAgeSec: null,
    carryUnclockedCount: 0,
    expectedActiveCount: ACTIVE_IDS.size,
    cacheUpdatedAt: null,
    historyFromDate: null,
  };
}

function unknownAvailabilityIntegrity(reason: string): SupplyAvailabilityIntegrityReport {
  return {
    status: "unknown",
    reason,
    observedCount: null,
    unavailableCount: null,
    share: null,
    consecutiveGenerations: 0,
    latestRunStartedAt: null,
    charts: { status: "unknown", reason: null, runStartedAt: null, codes: [] },
  };
}

function unknownSnapshotIntegrity(reason: string, expectedDate: number, due: boolean): SupplySnapshotIntegrityReport {
  return {
    status: "unknown",
    reason,
    expectedDate,
    snapshotDate: null,
    due,
    current: false,
    identityVerified: false,
    expectedActiveCount: null,
    accountedActiveCount: null,
    writtenRows: null,
    persistedRows: null,
    unavailableActiveIds: null,
    band: null,
  };
}

/**
 * Compare each active cached `circulating` value with the latest daily
 * `supply_history` row. Only rows with matching, non-repair provenance enter
 * the comparison; carried and repaired values are counted as exclusions, never
 * as observed drift (ADR-8 / ADR-28).
 */
async function loadSupplyValueIntegrity(
  db: D1Database,
  nowSec: number,
): Promise<SupplyValueIntegrityReport> {
  const cache = await loadStablecoinsCache(db, { mode: "lenient" });
  if (!hasUsableStablecoinsPayload(cache)) {
    return unknownValueIntegrity(`stablecoins-cache-${cache.reason}`);
  }

  const today = startOfUtcDaySec(new Date(nowSec * 1000));
  const fromDate = today - STATUS_SUPPLY_VALUE_THRESHOLDS.historyWindowDays * 24 * 3600;
  let previousByAsset: Map<string, SupplyHistoryRow> | null = null;
  try {
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* supply-integrity-previous-rows */
                  stablecoin_id, snapshot_date, circulating_usd, supply_provenance
             FROM (
               SELECT stablecoin_id, snapshot_date, circulating_usd, supply_provenance,
                      ROW_NUMBER() OVER (PARTITION BY stablecoin_id ORDER BY snapshot_date DESC) AS row_number
                 FROM supply_history
                WHERE snapshot_date >= ? AND snapshot_date < ?
             )
            WHERE row_number = 1`,
        )
        .bind(fromDate, today)
        .all<SupplyHistoryRow>(),
    );
    previousByAsset = new Map((rows.results ?? []).map((row) => [row.stablecoin_id, row]));
  } catch {
    // The carry signal comes from the cache and survives a history read
    // failure; the value comparison itself stays unknown (R2/R7).
  }

  const report = unknownValueIntegrity("stablecoins-cache-usable");
  report.status = "ok";
  report.reason = null;
  report.cacheUpdatedAt = cache.updatedAt;
  const driftFindings: SupplyValueDriftFinding[] = [];
  const carryIds: string[] = [];
  let carryOldestAgeSec: number | null = null;
  let carryUnclockedCount = 0;
  let checkedCount = 0;
  let excludedCount = 0;
  let currentSum = 0;
  let previousSum = 0;

  for (const asset of cache.payload.peggedAssets) {
    if (!ACTIVE_IDS.has(asset.id)) continue;

    if (asset.supplyRestored === true) {
      carryIds.push(asset.id);
      const observedAt = asset.supplyObservedAt;
      if (typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt > 0) {
        const ageSec = Math.max(0, nowSec - observedAt);
        carryOldestAgeSec = carryOldestAgeSec == null ? ageSec : Math.max(carryOldestAgeSec, ageSec);
      } else {
        carryUnclockedCount++;
      }
    }

    const currentUsd = getCirculatingRawOrNull(asset);
    const previous = previousByAsset?.get(asset.id);
    if (currentUsd === null || previous == null) {
      excludedCount++;
      continue;
    }
    if (asset.supplyRestored === true || asset.supplyGapFill != null || asset.supplyChainGuard != null
      || asset.supplyUnavailableReason != null) {
      excludedCount++;
      continue;
    }
    if (typeof asset.supplySource !== "string" || asset.supplySource.length === 0) {
      excludedCount++;
      continue;
    }
    const parsedProvenance = parseSupplyObservationProvenance(previous.supply_provenance);
    const provenance = parsedProvenance.provenance;
    if (parsedProvenance.invalid || provenance == null || provenance.supplyChainGuard != null
      || provenance.supplySource !== asset.supplySource) {
      excludedCount++;
      continue;
    }
    const previousUsd = previous.circulating_usd;
    if (!Number.isFinite(previousUsd) || previousUsd <= 0) {
      excludedCount++;
      continue;
    }

    checkedCount++;
    currentSum += currentUsd;
    previousSum += previousUsd;
    const ratio = currentUsd / previousUsd;
    if (ratio < STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor
      || ratio > STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling) {
      driftFindings.push({ stablecoinId: asset.id, currentUsd, previousUsd, ratio });
    }
  }

  driftFindings.sort((a, b) => a.ratio - b.ratio || a.stablecoinId.localeCompare(b.stablecoinId));
  carryIds.sort();
  report.checkedCount = checkedCount;
  report.excludedCount = excludedCount;
  report.driftFindings = driftFindings;
  report.carryIds = carryIds;
  report.carryOldestAgeSec = carryOldestAgeSec;
  report.carryUnclockedCount = carryUnclockedCount;
  report.historyFromDate = fromDate;
  if (previousByAsset == null) {
    report.status = "unknown";
    report.reason = "supply-history-read-failed";
    return report;
  }
  if (checkedCount < STATUS_SUPPLY_VALUE_THRESHOLDS.minComparableAssets || previousSum <= 0) {
    report.status = "unknown";
    report.reason = "insufficient-comparable-history";
    return report;
  }
  report.aggregateCurrentUsd = currentSum;
  report.aggregatePreviousUsd = previousSum;
  report.aggregateRatio = currentSum / previousSum;
  // A whole-feed freeze is only meaningful when most of the active cohort is
  // comparable; a small static remainder can legitimately repeat.
  report.frozen = checkedCount >= Math.ceil(
    ACTIVE_IDS.size * STATUS_SUPPLY_VALUE_THRESHOLDS.frozenMinComparableShare,
  ) && Math.abs(currentSum - previousSum)
    <= previousSum * STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateFrozenTolerance;
  return report;
}

function parseActiveSupplyCoverage(metadata: string | null): { observed: number; unavailable: number } | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    priceSourceHealth?: { active?: { supplyCoverage?: unknown; totalAssets?: unknown }; supplyCoverage?: unknown };
    supplyChainGuard?: { quarantinedAssetCount?: unknown; unavailableAssetCount?: unknown };
  };
  const coverage = record.priceSourceHealth?.active?.supplyCoverage
    ?? record.priceSourceHealth?.supplyCoverage;
  if (!coverage || typeof coverage !== "object") return null;
  const { observedCount, unavailableCount } = coverage as { observedCount?: unknown; unavailableCount?: unknown };
  if (!Number.isInteger(observedCount) || !Number.isInteger(unavailableCount)
    || Number(observedCount) < 0 || Number(unavailableCount) < 0) {
    return null;
  }
  const guard = record.supplyChainGuard;
  const guardCount = [guard?.quarantinedAssetCount, guard?.unavailableAssetCount]
    .filter((value): value is number => Number.isInteger(value) && Number(value) >= 0)
    .reduce((sum, value) => sum + Number(value), 0);
  return {
    observed: Number(observedCount),
    unavailable: Math.max(Number(unavailableCount), guardCount),
  };
}

/**
 * Read the last two published `sync-stablecoins` generations and grade the
 * active supply-unavailable share. Two consecutive generations above the
 * routine band are required before this is an operator condition.
 */
async function loadSupplyAvailabilityIntegrity(
  db: D1Database,
): Promise<SupplyAvailabilityIntegrityReport> {
  // Sibling reads are independent: a failed charts read must not discard valid
  // supply-coverage evidence, and vice versa (R2/R7).
  const [rows, chartsRows] = await Promise.all([
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT started_at, status, metadata
             FROM cron_runs
            WHERE job = 'sync-stablecoins'
            ORDER BY started_at DESC, id DESC
            LIMIT 2`,
        )
        .all<SyncStablecoinsRunRow>(),
    ).catch(() => null),
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT started_at, status, metadata
             FROM cron_runs
            WHERE job = 'sync-stablecoin-charts'
            ORDER BY started_at DESC, id DESC
            LIMIT 1`,
        )
        .all<ChartsRunRow>(),
    ).catch(() => null),
  ]);
  const charts = chartsRows == null
    ? { status: "unknown" as const, reason: "sync-stablecoin-charts-read-failed", runStartedAt: null, codes: [] }
    : parseChartsRun(chartsRows.results?.[0]);
  if (rows == null) return { ...unknownAvailabilityIntegrity("sync-stablecoins-runs-read-failed"), charts };
  const runs = rows.results ?? [];
  const latest = runs[0];
  if (!latest) return { ...unknownAvailabilityIntegrity("sync-stablecoins-runs-unavailable"), charts };
  const latestCoverage = parseActiveSupplyCoverage(latest.metadata);
  if (!latestCoverage || latestCoverage.observed + latestCoverage.unavailable <= 0) {
    return { ...unknownAvailabilityIntegrity("sync-stablecoins-supply-coverage-unavailable"), charts };
  }
  const total = latestCoverage.observed + latestCoverage.unavailable;
  const share = latestCoverage.unavailable / total;
  const previous = runs[1];
  const previousCoverage = previous ? parseActiveSupplyCoverage(previous.metadata) : null;
  const previousShare = previousCoverage && previousCoverage.observed + previousCoverage.unavailable > 0
    ? previousCoverage.unavailable / (previousCoverage.observed + previousCoverage.unavailable)
    : null;
  const threshold = STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold;
  const consecutiveGenerations = share < threshold
    ? 0
    : previousShare != null && previousShare >= threshold ? 2 : 1;
  return {
    status: "ok",
    reason: null,
    observedCount: latestCoverage.observed,
    unavailableCount: latestCoverage.unavailable,
    share,
    consecutiveGenerations,
    latestRunStartedAt: latest.started_at,
    charts,
  };
}

async function loadSupplySnapshotIntegrity(
  db: D1Database,
  nowSec: number,
): Promise<SupplySnapshotIntegrityReport> {
  const expectedDate = startOfUtcDaySec(new Date(nowSec * 1000));
  const due = nowSec - expectedDate >= STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec;
  const marker = await getCompletedSupplySnapshot(db);
  if (!marker) {
    // Absence cannot distinguish a fresh deployment from a stopped producer;
    // it stays unknown rather than claiming an overdue generation. A marker
    // dated before today is positive evidence the producer ran and stopped.
    return unknownSnapshotIntegrity("snapshot-completion-marker-missing", expectedDate, due);
  }
  const current = marker.snapshotDate === expectedDate;
  const report: SupplySnapshotIntegrityReport = {
    status: "ok",
    reason: null,
    expectedDate,
    snapshotDate: marker.snapshotDate,
    due,
    current,
    identityVerified: marker.coverageIdentityVerified,
    expectedActiveCount: marker.expectedActiveCount,
    accountedActiveCount: marker.accountedActiveCount,
    writtenRows: marker.ownedRowIds?.length ?? null,
    persistedRows: null,
    unavailableActiveIds: marker.unavailableActiveIds,
    band: null,
  };
  if (!current) return report;

  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?")
      .bind(marker.snapshotDate)
      .first<{ count: number | null }>(),
  );
  if (row?.count == null || !Number.isInteger(row.count) || row.count < 0) {
    return { ...report, status: "unknown", reason: "supply-history-row-count-unavailable" };
  }
  report.persistedRows = row.count;
  if (report.unavailableActiveIds != null && report.expectedActiveCount != null) {
    report.band = classifyStablecoinPublicationGap({
      expectedActiveCount: report.expectedActiveCount,
      missingActiveIds: report.unavailableActiveIds,
    });
  }
  return report;
}

export interface SupplyIntegrityReadOptions {
  signal?: AbortSignal;
}

async function settle<T>(
  load: () => Promise<T>,
  fallback: (reason: string) => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

/** Load every supply-integrity dimension independently; a failed read stays unknown. */
export async function loadSupplyIntegrityReport(
  db: D1Database,
  nowSec: number,
  options: SupplyIntegrityReadOptions = {},
): Promise<SupplyIntegrityReport> {
  const expectedDate = startOfUtcDaySec(new Date(nowSec * 1000));
  const [value, availability, snapshot] = await Promise.all([
    settle(() => loadSupplyValueIntegrity(db, nowSec), unknownValueIntegrity, options.signal),
    settle(() => loadSupplyAvailabilityIntegrity(db), unknownAvailabilityIntegrity, options.signal),
    settle(
      () => loadSupplySnapshotIntegrity(db, nowSec),
      (reason) => unknownSnapshotIntegrity(
        reason,
        expectedDate,
        nowSec - expectedDate >= STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec,
      ),
      options.signal,
    ),
  ]);
  return { observedAt: nowSec, value, availability, snapshot };
}

export type SupplyIntegrityConditionId =
  | "value-drift"
  | "availability"
  | "carry"
  | "snapshot-overdue"
  | "snapshot-partial"
  | "charts-history";

export interface SupplyIntegrityCondition {
  id: SupplyIntegrityConditionId;
  label: string;
  active: boolean;
  unknown: boolean;
  /** Stable across runs while the same finding persists; confirmation resets when it changes. */
  signature: string;
}

function formatIds(ids: readonly string[]): string {
  return ids.slice(0, 3).join(", ") + (ids.length > 3 ? `, +${ids.length - 3} more` : "");
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function isoDay(seconds: number | null): string {
  return seconds == null ? "none" : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Translate a read report into operator-watch conditions. `unknown` marks a
 * detector whose own evidence could not be read; the transition machine keeps
 * its prior state instead of treating that as recovery (R2).
 */
export function buildSupplyIntegrityConditions(report: SupplyIntegrityReport): SupplyIntegrityCondition[] {
  const value = report.value;
  const valueDrift = value.driftFindings;
  const aggregateBreached = value.aggregateRatio != null
    && (value.aggregateRatio < STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor
      || value.aggregateRatio > STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling);
  const valueActive = valueDrift.length > 0 || value.frozen || aggregateBreached;
  const valueLabel = [
    valueDrift.length > 0
      ? `${valueDrift.length} asset(s) outside ${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling}x (${formatIds(valueDrift.map((finding) => `${finding.stablecoinId} ${finding.ratio.toFixed(2)}x`))})`
      : null,
    aggregateBreached && value.aggregateRatio != null
      ? `total ${value.aggregateRatio.toFixed(2)}x outside ${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling}x`
      : null,
    value.frozen ? "cohort total unchanged across generations" : null,
  ].filter((part): part is string => part != null).join("; ");
  const expectedActive = value.expectedActiveCount;
  const carryThreshold = Math.max(
    1,
    Math.ceil(expectedActive * STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold),
  );
  const carryActive = value.carryIds.length >= carryThreshold
    || (value.carryOldestAgeSec != null && value.carryOldestAgeSec > STATUS_SUPPLY_VALUE_THRESHOLDS.carryStaleAfterSec);
  const carryLabel = [
    `${value.carryIds.length} carried asset(s)`,
    value.carryOldestAgeSec != null ? `oldest ${Math.floor(value.carryOldestAgeSec / 3600)}h` : null,
    value.carryUnclockedCount > 0 ? `${value.carryUnclockedCount} without an observation clock` : null,
    value.carryIds.length > 0 ? formatIds(value.carryIds) : null,
  ].filter((part): part is string => part != null).join(", ");

  const availability = report.availability;
  const availabilityActive = availability.status === "ok" && availability.consecutiveGenerations >= 2;
  const availabilityLabel = availability.status === "ok" && availability.share != null
    ? `${formatShare(availability.share)} unavailable (${availability.unavailableCount}/${(availability.observedCount ?? 0) + (availability.unavailableCount ?? 0)}) `
      + `for ${availability.consecutiveGenerations} generation(s); budget ${formatShare(STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold)}; `
      + `producer sync-stablecoins, generation ${availability.latestRunStartedAt != null ? new Date(availability.latestRunStartedAt * 1000).toISOString() : "unknown"}`
    : "supply availability evidence unavailable";

  const snapshot = report.snapshot;
  const snapshotOverdue = snapshot.status === "ok" && snapshot.due && !snapshot.current;
  const snapshotRowsMissing = snapshot.current
    && snapshot.persistedRows != null
    && snapshot.writtenRows != null
    && snapshot.persistedRows < snapshot.writtenRows;
  const snapshotBandActive = snapshot.band === "elevated" || snapshot.band === "systemic";
  const snapshotPartial = snapshot.current && (snapshotRowsMissing || snapshotBandActive);
  const snapshotPartialLabel = [
    snapshot.expectedActiveCount != null && snapshot.unavailableActiveIds != null
      ? `${snapshot.unavailableActiveIds.length}/${snapshot.expectedActiveCount} active asset(s) have unavailable supply; budget ${formatShare(STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE)}`
      : null,
    snapshot.unavailableActiveIds != null && snapshot.unavailableActiveIds.length > 0
      ? formatIds(snapshot.unavailableActiveIds)
      : null,
    snapshotRowsMissing ? `persisted ${snapshot.persistedRows} of ${snapshot.writtenRows} written row(s)` : null,
  ].filter((part): part is string => part != null).join("; ");
  const snapshotOverdueLabel = snapshot.snapshotDate == null
    ? `snapshot overdue: producer snapshot-supply has no completion marker; budget ${STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec / 60}m after UTC midnight`
    : `snapshot overdue: producer snapshot-supply last wrote ${isoDay(snapshot.snapshotDate)} (today ${isoDay(snapshot.expectedDate)}); `
      + `budget ${STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec / 60}m after UTC midnight`;

  return [
    {
      id: "value-drift",
      label: valueActive ? valueLabel : "value drift",
      active: valueActive,
      unknown: value.status === "unknown",
      // Coarse, state-shaped signatures keep a persisting finding stable
      // across runs; the live ratios/counts stay in the label and metadata.
      signature: `${valueDrift.map((finding) => finding.stablecoinId).join(",")}|${aggregateBreached}|${value.frozen}`,
    },
    {
      id: "availability",
      label: availabilityLabel,
      active: availabilityActive,
      unknown: availability.status === "unknown",
      signature: "unavailable-supply",
    },
    {
      id: "carry",
      label: carryActive ? `carried supply: ${carryLabel}` : "carried supply",
      active: carryActive,
      // Carry is read from the cache alone; only a failed cache read is unknown.
      unknown: value.cacheUpdatedAt == null,
      signature: value.carryIds.join(","),
    },
    {
      id: "snapshot-overdue",
      label: snapshotOverdueLabel,
      active: snapshotOverdue,
      unknown: snapshot.status === "unknown",
      signature: snapshot.snapshotDate == null ? "none" : String(snapshot.snapshotDate),
    },
    {
      id: "snapshot-partial",
      label: snapshotPartial ? `partial supply snapshot: ${snapshotPartialLabel}` : "partial supply snapshot",
      active: snapshotPartial,
      // A current marker without the unavailable-evidence field (legacy) or a
      // failed row read cannot certify a complete snapshot (R2).
      unknown: snapshot.current && (snapshot.status === "unknown" || snapshot.unavailableActiveIds == null),
      signature: `${snapshot.unavailableActiveIds?.join(",") ?? ""}|${snapshot.persistedRows ?? ""}/${snapshot.writtenRows ?? ""}`,
    },
    {
      id: "charts-history",
      label: availability.charts.status === "truncated"
        ? `producer sync-stablecoin-charts published a discontinuous history on generation `
          + `${availability.charts.runStartedAt != null ? new Date(availability.charts.runStartedAt * 1000).toISOString() : "unknown"}`
          + `${availability.charts.codes.length > 0 ? ` (${availability.charts.codes.join(", ")})` : ""}; budget 80% of prior points`
        : "chart history continuity",
      active: availability.charts.status === "truncated",
      unknown: availability.charts.status === "unknown",
      signature: "chart-history-truncated",
    },
  ];
}

interface ConfirmationEntry {
  signature: string;
  runs: number;
}

function parseConfirmationState(value: string | null): Record<string, ConfirmationEntry> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, entry]) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as { signature?: unknown; runs?: unknown };
        return typeof record.signature === "string" && Number.isInteger(record.runs)
          ? [[id, { signature: record.signature, runs: Number(record.runs) }] as const]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

/**
 * Require the same finding signature on consecutive watchdog runs before it is
 * raised. A confirmation-state read/write failure marks every condition
 * unknown so the caller keeps prior transition state instead of claiming
 * recovery.
 */
export async function confirmSupplyIntegrityConditions(
  db: D1Database,
  conditions: readonly SupplyIntegrityCondition[],
  options: { signal?: AbortSignal } = {},
): Promise<SupplyIntegrityCondition[]> {
  let previous: Record<string, ConfirmationEntry>;
  try {
    previous = parseConfirmationState((await getCache(db, SUPPLY_INTEGRITY_CONFIRM_KEY, options.signal))?.value ?? null);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return conditions.map((condition) => ({ ...condition, unknown: true }));
  }
  const next: Record<string, ConfirmationEntry> = {};
  const confirmed = conditions.map((condition) => {
    if (condition.unknown) {
      if (previous[condition.id] != null) next[condition.id] = previous[condition.id];
      return condition;
    }
    if (!condition.active) return condition;
    const runs = previous[condition.id]?.signature === condition.signature
      ? previous[condition.id].runs + 1
      : 1;
    next[condition.id] = { signature: condition.signature, runs };
    return runs >= SUPPLY_INTEGRITY_CONFIRM_RUNS ? condition : { ...condition, active: false };
  });
  try {
    await setCache(db, SUPPLY_INTEGRITY_CONFIRM_KEY, JSON.stringify(next), options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return conditions.map((condition) => ({ ...condition, unknown: true }));
  }
  return confirmed;
}

/** Compact operator metadata; bounded IDs keep the sentinel row inside its persistence budget. */
export function compactSupplyIntegrityReport(report: SupplyIntegrityReport): Record<string, unknown> {
  return {
    observedAt: report.observedAt,
    value: {
      status: report.value.status,
      reason: report.value.reason,
      checkedCount: report.value.checkedCount,
      excludedCount: report.value.excludedCount,
      driftCount: report.value.driftFindings.length,
      driftIds: report.value.driftFindings.slice(0, MAX_REPORTED_IDS).map((finding) => finding.stablecoinId),
      aggregateRatio: report.value.aggregateRatio,
      frozen: report.value.frozen,
      carryCount: report.value.carryIds.length,
      carryIds: report.value.carryIds.slice(0, MAX_REPORTED_IDS),
      carryOldestAgeSec: report.value.carryOldestAgeSec,
      carryUnclockedCount: report.value.carryUnclockedCount,
      cacheUpdatedAt: report.value.cacheUpdatedAt,
    },
    availability: {
      status: report.availability.status,
      reason: report.availability.reason,
      observedCount: report.availability.observedCount,
      unavailableCount: report.availability.unavailableCount,
      share: report.availability.share,
      consecutiveGenerations: report.availability.consecutiveGenerations,
      latestRunStartedAt: report.availability.latestRunStartedAt,
      charts: report.availability.charts,
    },
    snapshot: {
      status: report.snapshot.status,
      reason: report.snapshot.reason,
      expectedDate: report.snapshot.expectedDate,
      snapshotDate: report.snapshot.snapshotDate,
      due: report.snapshot.due,
      current: report.snapshot.current,
      identityVerified: report.snapshot.identityVerified,
      expectedActiveCount: report.snapshot.expectedActiveCount,
      accountedActiveCount: report.snapshot.accountedActiveCount,
      writtenRows: report.snapshot.writtenRows,
      persistedRows: report.snapshot.persistedRows,
      unavailableCount: report.snapshot.unavailableActiveIds?.length ?? null,
      unavailableActiveIds: report.snapshot.unavailableActiveIds?.slice(0, MAX_REPORTED_IDS) ?? null,
      band: report.snapshot.band,
    },
  };
}
