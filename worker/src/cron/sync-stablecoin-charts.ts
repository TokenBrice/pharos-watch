import { getCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { fetchTextWithRetry } from "../lib/fetch-retry";
import { DEFILLAMA_BASE } from "../lib/constants";
import { getFxReferenceTypeFromState, loadFxRateState } from "../lib/fx-rate-state";
import { buildInClause } from "../lib/db";
import { chunkArray } from "../lib/collections";
import {
  normalizeStablecoinChartBuckets,
  normalizeStablecoinChartDateSeconds,
  normalizeStablecoinChartPoints,
  sampleHistoricalDatePoints,
} from "../lib/stablecoin-charts-payload";
import {
  assessStablecoinChartContinuity,
  STABLECOIN_CHART_CONTINUITY_THRESHOLDS,
} from "../lib/stablecoin-charts-continuity";
import {
  mergeStructuralSupplementalHistoryIntoCharts,
  STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS,
  type SupplyHistoryChartRow,
} from "../lib/stablecoin-charts-reconciliation";
import { throwIfAborted } from "../lib/abort";
import { runCadenceBucketPublication } from "../lib/cadence-bucket";
import { logWorkerEvent } from "../lib/structured-log";
import { parseJson } from "../lib/json-parse";

// D1 caps bound parameters per query at 100; keep headroom for non-IN binds.
const SUPPLEMENTAL_HISTORY_IN_CHUNK_SIZE = 90;

/** Implied rate must be within 1/N to Nx of our cached FX rate.
 *  3x tolerates multi-year FX drift (e.g. ARS ~10x over 4 years won't hit
 *  recent points) while easily catching corruption like the RUB 22,000x bug. */
const RATE_TOLERANCE = 3;
const MIN_DOWNSAMPLED_POINTS = 10;
const LIVE_FX_REPAIR_MAX_POINT_AGE_SEC = 3 * 24 * 60 * 60;

interface RawChartPoint {
  date: number | string;
  totalCirculating?: Record<string, number>;
  totalCirculatingUSD?: Record<string, number>;
}

interface NormalizedRawChartPoint {
  date: number;
  totalCirculating?: Record<string, number>;
  totalCirculatingUSD?: Record<string, number | null>;
}

interface DownsampledPoint {
  date: number;
  totalCirculatingUSD: Record<string, number | null>;
}


function downsample(data: NormalizedRawChartPoint[]): DownsampledPoint[] {
  if (data.length === 0) return [];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const sorted = data
    .filter((point): point is NormalizedRawChartPoint & DownsampledPoint => !!point.totalCirculatingUSD)
    .sort((a, b) => a.date - b.date);
  return sampleHistoricalDatePoints(sorted, nowSeconds).map((point) => ({
    date: point.date,
    totalCirculatingUSD: point.totalCirculatingUSD,
  }));
}

export interface SyncStablecoinChartsOptions {
  scheduledAtSec?: number;
}

const CHART_CADENCE_SEC = 60 * 60;
const CHART_CADENCE_KEY = "stablecoin-charts:cadence";
const CHART_STALE_CLAIM_SEC = 25 * 60;

export async function syncStablecoinCharts(
  db: D1Database,
  signal?: AbortSignal,
  options: SyncStablecoinChartsOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const syncStartSec = Math.floor(Date.now() / 1000);
  const scheduledAtSec = options.scheduledAtSec ?? syncStartSec;
  return runCadenceBucketPublication(db, {
    key: CHART_CADENCE_KEY,
    cadenceSec: CHART_CADENCE_SEC,
    staleClaimAfterSec: CHART_STALE_CLAIM_SEC,
    scheduledAtSec,
    startedAtSec: syncStartSec,
    job: "sync-stablecoin-charts",
    releaseFailureEvent: "sync_stablecoin_charts.cadence_claim_release_failed",
    releaseFailureMessage: "Failed to release chart cadence claim after publication failure",
    publication: () => runStablecoinChartsPublication(db, syncStartSec, signal),
  });
}

async function runStablecoinChartsPublication(
  db: D1Database,
  syncStartSec: number,
  signal?: AbortSignal,
): Promise<CronResult> {

  const chartResult = await fetchTextWithRetry(
    `${DEFILLAMA_BASE}/stablecoincharts/all`,
    signal ? { signal } : undefined,
    2,
    { returnFinalResponse: true },
  );

  if (!chartResult?.response.ok) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      event: "defillama-api-unavailable",
      message: "DefiLlama charts API error",
      status: chartResult?.response.status ?? "no response",
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "DL API unavailable", apiStatus: chartResult?.response.status ?? null },
    });
  }
  const res = chartResult.response;

  const parsedBody = parseJson(chartResult.body);
  if (!parsedBody.ok) {
    /* non-blocking: DL charts API returned non-JSON; degrade gracefully so other cron jobs continue */
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      event: "defillama-api-invalid-json",
      message: "Failed to parse JSON from DefiLlama charts API",
      status: res.status,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "DL API invalid JSON", apiStatus: res.status },
    });
  }
  const raw = parsedBody.value as RawChartPoint[];

  if (!Array.isArray(raw) || raw.length < 100) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      event: "defillama-payload-too-small",
      message: "Unexpected data length; skipping cache write",
      metadata: { rawLength: raw?.length },
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "DL API payload too small", rawLength: raw?.length ?? 0 },
    });
  }

  let invalidDateCount = 0;
  let invalidBucketCount = 0;
  let normalizedRaw: NormalizedRawChartPoint[] = raw.flatMap((point) => {
    const date = normalizeStablecoinChartDateSeconds(point?.date, syncStartSec);
    if (date == null) {
      invalidDateCount++;
      return [];
    }
    const totalCirculatingUSD = normalizeStablecoinChartBuckets(point.totalCirculatingUSD);
    if (totalCirculatingUSD == null) {
      invalidBucketCount++;
      return [];
    }
    return [{ ...point, date, totalCirculatingUSD }];
  });
  if (invalidDateCount > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      level: "warn",
      event: "invalid-chart-dates-dropped",
      message: "Dropped chart points with invalid dates",
      metadata: { invalidDateCount },
    });
  }
  if (invalidBucketCount > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      level: "warn",
      event: "invalid-chart-base-buckets-dropped",
      message: "Quarantined chart points without an observed base aggregate",
      metadata: { invalidBucketCount },
    });
  }

  // Fix corrupted totalCirculatingUSD values (e.g. DefiLlama RUB bug Feb 2026)
  // by validating implied FX rates against known bounds and recomputing from
  // totalCirculating * cached FX rate when out of range.
  const fxState = await loadFxRateState(db);
  let fixes = 0;
  if (fxState) {
    for (const point of normalizedRaw) {
      const circ = point.totalCirculating;
      const usd = point.totalCirculatingUSD;
      if (!circ || !usd) continue;
      // The live FX cache is only safe as a repair reference near "now"; older
      // chart points need a point-in-time FX series, not today's rate.
      const pointAgeSec = Math.max(0, syncStartSec - point.date);
      if (pointAgeSec > LIVE_FX_REPAIR_MAX_POINT_AGE_SEC) continue;
      for (const key of Object.keys(usd)) {
        if (key === "peggedUSD") continue;
        const rawVal = circ[key];
        if (!rawVal || rawVal <= 0) continue;
        const referenceType = getFxReferenceTypeFromState(fxState, key, 6 * 3600);
        if (referenceType !== "fresh") continue;
        const fxRate = fxState.rates[key];
        if (!fxRate || fxRate <= 0) continue;
        const usdVal = usd[key];
        if (usdVal == null) continue;
        const impliedRate = usdVal / rawVal;
        if (impliedRate < fxRate / RATE_TOLERANCE || impliedRate > fxRate * RATE_TOLERANCE) {
          usd[key] = rawVal * fxRate;
          fixes++;
        }
      }
    }
    if (fixes > 0) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoin-charts",
        level: "info",
        event: "corrupted-usd-values-fixed",
        message: "Fixed corrupted totalCirculatingUSD values",
        metadata: { fixes },
      });
    }
  }

  throwIfAborted(signal);
  let supplementalHistoryChunks = 0;
  let supplementalHistoryMaxBindCount = 0;
  if (STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.length > 0) {
    const supplementalIds = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.map((config) => config.id);
    const overlayRows: SupplyHistoryChartRow[] = [];
    for (const idChunk of chunkArray(supplementalIds, SUPPLEMENTAL_HISTORY_IN_CHUNK_SIZE)) {
      throwIfAborted(signal);
      const supplementalIn = buildInClause(idChunk);
      supplementalHistoryChunks++;
      supplementalHistoryMaxBindCount = Math.max(supplementalHistoryMaxBindCount, supplementalIn.binds.length);
      const overlayRowsResult = await db
        .prepare(
          `SELECT stablecoin_id, snapshot_date, circulating_usd
           FROM supply_history
           WHERE stablecoin_id IN (${supplementalIn.sql})
           ORDER BY stablecoin_id ASC, snapshot_date ASC`,
        )
        .bind(...supplementalIn.binds)
        .all<SupplyHistoryChartRow>();
      if (overlayRowsResult.results) overlayRows.push(...overlayRowsResult.results);
    }
    normalizedRaw = mergeStructuralSupplementalHistoryIntoCharts(normalizedRaw.map((point) => ({
      date: point.date,
      totalCirculatingUSD: point.totalCirculatingUSD ?? {},
    })), overlayRows).map((point) => ({
      date: point.date,
      totalCirculatingUSD: point.totalCirculatingUSD,
    }));
  }

  const downsampled = downsample(normalizedRaw);
  if (downsampled.length < MIN_DOWNSAMPLED_POINTS) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      event: "downsampled-payload-too-small",
      message: "Downsampled payload too small; preserving existing cache",
      metadata: { downsampledPointCount: downsampled.length },
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "downsampled-payload-too-small", rawPoints: normalizedRaw.length, downsampledPoints: downsampled.length },
    });
  }
  const payload = normalizeStablecoinChartPoints(downsampled);
  if (payload == null) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "invalid-chart-publication-payload" },
    });
  }

  // Continuity guard: the cache key holds the last published history, so a
  // truncated upstream response is detectable without a second table. A failed
  // baseline read fails closed; an absent/corrupt baseline is reported as such
  // and cannot mask a truncation because there is no history to preserve.
  let previousCache: Awaited<ReturnType<typeof getCache>>;
  try {
    previousCache = await getCache(db, "stablecoin-charts");
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      level: "error",
      event: "chart-history-baseline-read-failed",
      message: "Could not read the previous chart payload; preserving the cache",
      error,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "chart-history-baseline-read-failed" },
    });
  }
  const parsedPrevious = previousCache ? parseJson(previousCache.value) : null;
  const previousPayload = parsedPrevious?.ok
    ? normalizeStablecoinChartPoints(parsedPrevious.value)
    : null;
  const continuityBaseline = !previousCache ? "missing" : previousPayload == null ? "invalid" : "present";
  const continuityFindings = previousPayload == null
    ? []
    : assessStablecoinChartContinuity(previousPayload, payload);
  if (continuityFindings.length > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      level: "warn",
      event: "chart-history-truncated",
      message: "Chart history continuity check failed; preserving existing cache",
      metadata: {
        findings: continuityFindings.slice(0, 10),
        previousPoints: previousPayload?.length ?? 0,
        nextPoints: payload.length,
      },
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "chart-history-truncated",
        quality: {
          reason: "chart-history-truncated",
          codes: [...new Set(continuityFindings.map((finding) => finding.code))],
        },
        previousPoints: previousPayload?.length ?? 0,
        nextPoints: payload.length,
        previousOldestDate: previousPayload?.[0]?.date ?? null,
        nextOldestDate: payload[0]?.date ?? null,
        minPointShare: STABLECOIN_CHART_CONTINUITY_THRESHOLDS.minPointShare,
        continuityFindings: continuityFindings.slice(0, 20).map((finding) =>
          [finding.code, finding.previous, finding.next, finding.bucket ?? null] as const),
      },
    });
  }

  const cacheResult = await setCacheIfNewer(
    db,
    "stablecoin-charts",
    JSON.stringify(payload),
    syncStartSec,
    signal,
  );
  let lastWriteAdvanced = false;
  let canonicalReadbackUpdatedAt: number | null = null;
  if (cacheResult.written) {
    lastWriteAdvanced = true;
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoin-charts",
      level: "info",
      event: "chart-cache-published",
      message: "Cached chart points",
      metadata: { downsampledPointCount: downsampled.length, rawPointCount: normalizedRaw.length },
    });
  } else {
    const canonicalCache = await getCache(db, "stablecoin-charts");
    canonicalReadbackUpdatedAt = canonicalCache?.updatedAt ?? null;
    if (canonicalCache && canonicalCache.updatedAt > syncStartSec) {
      lastWriteAdvanced = true;
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoin-charts",
        level: "info",
        event: "chart-cache-newer-row-exists",
        message: "Skipped chart cache write because a newer canonical cache exists",
        metadata: { canonicalCacheUpdatedAt: canonicalCache.updatedAt, syncStartSec },
      });
    } else {
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoin-charts",
        level: "warn",
        event: "chart-cache-write-unconfirmed",
        message: "Skipped chart cache write but could not confirm a newer canonical cache; leaving last-write marker unchanged",
      });
    }
  }
  return createCronResult({
    itemCount: cacheResult.written ? downsampled.length : 0,
    metadata: {
      rawPoints: normalizedRaw.length,
      downsampledPoints: downsampled.length,
      invalidDateCount,
      invalidBucketCount,
      fxFixes: fixes,
      supplementalHistoryChunks,
      supplementalHistoryMaxBindCount,
      continuityBaseline,
      cacheKey: "stablecoin-charts",
      syncStartSec,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      lastWriteAdvanced,
      canonicalReadbackUpdatedAt,
    },
  });
}
