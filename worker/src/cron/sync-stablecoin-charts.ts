import { getCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchTextWithRetry } from "../lib/fetch-retry";
import { DEFILLAMA_BASE } from "../lib/constants";
import { getFxReferenceTypeFromState, loadFxRateState } from "../lib/fx-rate-state";
import { buildInClause } from "../lib/db";
import { chunkArray } from "../lib/collections";
import { normalizeStablecoinChartDateSeconds } from "../lib/stablecoin-charts-payload";
import { mergeStructuralSupplementalHistoryIntoCharts, STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS } from "../lib/stablecoin-charts-reconciliation";
import { throwIfAborted } from "../lib/abort";
import {
  appendCadenceResultMetadata,
  cadenceBucketFor,
  claimCadenceBucket,
  completeCadenceBucket,
  failCadenceBucket,
} from "../lib/cadence-bucket";
import { logWorkerEvent } from "../lib/structured-log";

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
  totalCirculatingUSD?: Record<string, number>;
}

interface DownsampledPoint {
  date: number;
  totalCirculatingUSD: Record<string, number>;
}

interface SupplyHistoryChartRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

function downsample(data: NormalizedRawChartPoint[]): DownsampledPoint[] {
  if (data.length === 0) return [];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ninetyDaysAgo = nowSeconds - 90 * 24 * 60 * 60;
  const twoYearsAgo = nowSeconds - 2 * 365 * 24 * 60 * 60;

  const result: DownsampledPoint[] = [];

  // Sort chronologically
  const sorted = [...data].sort((a, b) => a.date - b.date);

  let lastKeptDate = 0;

  for (const point of sorted) {
    if (!point.totalCirculatingUSD) continue;

    let interval: number;
    if (point.date >= ninetyDaysAgo) {
      interval = 24 * 60 * 60; // daily
    } else if (point.date >= twoYearsAgo) {
      interval = 7 * 24 * 60 * 60; // weekly
    } else {
      interval = 30 * 24 * 60 * 60; // monthly
    }

    if (point.date - lastKeptDate >= interval) {
      result.push({
        date: point.date,
        totalCirculatingUSD: point.totalCirculatingUSD,
      });
      lastKeptDate = point.date;
    }
  }

  return result;
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
  const bucket = cadenceBucketFor(scheduledAtSec, CHART_CADENCE_SEC);
  const claimResult = await claimCadenceBucket(db, {
    key: CHART_CADENCE_KEY,
    bucket,
    nowSec: syncStartSec,
    staleClaimAfterSec: CHART_STALE_CLAIM_SEC,
  });
  if (claimResult.kind === "skip") {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        reason: claimResult.reason === "already-completed"
          ? "cadence_bucket_completed"
          : "cadence_bucket_in_progress",
        cadence: {
          bucket,
          observedBucket: claimResult.bucket,
          cadenceSec: CHART_CADENCE_SEC,
        },
      }),
    };
  }

  try {
    const result = await runStablecoinChartsPublication(db, syncStartSec, signal);
    const resultMetadata = result.metadata ? JSON.parse(result.metadata) as Record<string, unknown> : {};
    if (resultMetadata.lastWriteAdvanced !== true) {
      await failCadenceBucket(db, claimResult.claim);
      return appendCadenceResultMetadata(
        { ...result, status: "degraded" },
        { bucket, cadenceSec: CHART_CADENCE_SEC, completed: false, retryable: true },
      );
    }
    const completed = await completeCadenceBucket(db, claimResult.claim);
    return appendCadenceResultMetadata(
      completed ? result : { ...result, status: "degraded" },
      { bucket, cadenceSec: CHART_CADENCE_SEC, completed, retryable: !completed },
    );
  } catch (error) {
    try {
      await failCadenceBucket(db, claimResult.claim);
    } catch (transitionError) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync_stablecoin_charts.cadence_claim_release_failed",
        job: "sync-stablecoin-charts",
        message: "Failed to release chart cadence claim after publication failure",
        error: transitionError,
        metadata: { bucket },
      });
    }
    throw error;
  }
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
    console.error(`[sync-charts] DefiLlama API error: ${chartResult?.response.status ?? "no response"}`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "DL API unavailable", apiStatus: chartResult?.response.status ?? null }),
    };
  }
  const res = chartResult.response;

  let raw: RawChartPoint[];
  try {
    raw = JSON.parse(chartResult.body) as RawChartPoint[];
  } catch {
    /* non-blocking: DL charts API returned non-JSON; degrade gracefully so other cron jobs continue */
    console.error(`[sync-charts] Failed to parse JSON from DefiLlama charts API: ${res.status}`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "DL API invalid JSON", apiStatus: res.status }),
    };
  }

  if (!Array.isArray(raw) || raw.length < 100) {
    console.error(`[sync-charts] Unexpected data length (${raw?.length}), skipping cache write`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "DL API payload too small", rawLength: raw?.length ?? 0 }),
    };
  }

  let normalizedRaw: NormalizedRawChartPoint[] = raw.flatMap((point) => {
    const date = normalizeStablecoinChartDateSeconds(point.date);
    if (date == null) return [];
    return [{ ...point, date }];
  });
  const invalidDateCount = raw.length - normalizedRaw.length;
  if (invalidDateCount > 0) {
    console.warn(`[sync-charts] Dropped ${invalidDateCount} chart points with invalid dates`);
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
        if (referenceType !== "fresh" && referenceType !== "static") continue;
        const fxRate = fxState.rates[key];
        if (!fxRate || fxRate <= 0) continue;
        const impliedRate = usd[key] / rawVal;
        if (impliedRate < fxRate / RATE_TOLERANCE || impliedRate > fxRate * RATE_TOLERANCE) {
          usd[key] = rawVal * fxRate;
          fixes++;
        }
      }
    }
    if (fixes > 0) {
      console.log(`[sync-charts] Fixed ${fixes} corrupted totalCirculatingUSD values`);
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
    console.error(`[sync-charts] Downsampled payload too small (${downsampled.length}), preserving existing cache`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "downsampled-payload-too-small",
        rawPoints: normalizedRaw.length,
        downsampledPoints: downsampled.length,
      }),
    };
  }

  const cacheResult = await setCacheIfNewer(
    db,
    "stablecoin-charts",
    JSON.stringify(downsampled),
    syncStartSec,
    signal,
  );
  let lastWriteAdvanced = false;
  let canonicalReadbackUpdatedAt: number | null = null;
  if (cacheResult.written) {
    lastWriteAdvanced = true;
    console.log(`[sync-charts] Cached ${downsampled.length} points (from ${normalizedRaw.length} raw)`);
  } else {
    const canonicalCache = await getCache(db, "stablecoin-charts");
    canonicalReadbackUpdatedAt = canonicalCache?.updatedAt ?? null;
    if (canonicalCache && canonicalCache.updatedAt > syncStartSec) {
      lastWriteAdvanced = true;
      console.log(
        `[sync-charts] Skipped chart cache write; newer canonical cache exists ` +
        `(updatedAt=${canonicalCache.updatedAt}, syncStartSec=${syncStartSec})`,
      );
    } else {
      console.warn(
        `[sync-charts] Skipped chart cache write but could not confirm a newer canonical cache; ` +
        `leaving last-write marker unchanged`,
      );
    }
  }
  return {
    itemCount: cacheResult.written ? downsampled.length : 0,
    metadata: JSON.stringify({
      rawPoints: normalizedRaw.length,
      downsampledPoints: downsampled.length,
      fxFixes: fixes,
      supplementalHistoryChunks,
      supplementalHistoryMaxBindCount,
      cacheKey: "stablecoin-charts",
      syncStartSec,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      lastWriteAdvanced,
      canonicalReadbackUpdatedAt,
    }),
  };
}
