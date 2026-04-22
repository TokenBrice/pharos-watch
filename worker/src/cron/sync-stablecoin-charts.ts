import { getCache, setCache, setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchWithRetry } from "../lib/fetch-retry";
import { DEFILLAMA_BASE } from "../lib/constants";
import { getFxReferenceTypeFromState, loadFxRateState } from "../lib/fx-rate-state";
import { buildInClause } from "../lib/db";
import { mergeStructuralSupplementalHistoryIntoCharts, STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS } from "../lib/stablecoin-charts-reconciliation";
import { throwIfAborted } from "../lib/abort";

/** Implied rate must be within 1/N to Nx of our cached FX rate.
 *  3x tolerates multi-year FX drift (e.g. ARS ~10x over 4 years won't hit
 *  recent points) while easily catching corruption like the RUB 22,000x bug. */
const RATE_TOLERANCE = 3;
const MIN_DOWNSAMPLED_POINTS = 10;
const LIVE_FX_REPAIR_MAX_POINT_AGE_SEC = 3 * 24 * 60 * 60;

interface RawChartPoint {
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

function downsample(data: RawChartPoint[]): DownsampledPoint[] {
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

export async function syncStablecoinCharts(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const syncStartSec = Math.floor(Date.now() / 1000);

  const COOLDOWN_SEC = 3600;
  const lastWrite = await getCache(db, "stablecoin-charts:last-write");
  if (lastWrite && (syncStartSec - lastWrite.updatedAt) < COOLDOWN_SEC) {
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cooldown_active", lastWriteAgeSec: syncStartSec - lastWrite.updatedAt }) };
  }

  const res = await fetchWithRetry(`${DEFILLAMA_BASE}/stablecoincharts/all`, signal ? { signal } : undefined);

  if (!res || !res.ok) {
    console.error(`[sync-charts] DefiLlama API error: ${res?.status ?? "no response"}`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "DL API unavailable", apiStatus: res?.status ?? null }),
    };
  }

  let raw: RawChartPoint[];
  try {
    raw = (await res.json()) as RawChartPoint[];
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

  // Fix corrupted totalCirculatingUSD values (e.g. DefiLlama RUB bug Feb 2026)
  // by validating implied FX rates against known bounds and recomputing from
  // totalCirculating * cached FX rate when out of range.
  const fxState = await loadFxRateState(db);
  let fixes = 0;
  if (fxState) {
    for (const point of raw) {
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
  if (STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.length > 0) {
    const supplementalIds = STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.map((config) => config.id);
    const supplementalIn = buildInClause(supplementalIds);
    const overlayRowsResult = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, circulating_usd
         FROM supply_history
         WHERE stablecoin_id IN (${supplementalIn.sql})
         ORDER BY stablecoin_id ASC, snapshot_date ASC`,
      )
      .bind(...supplementalIn.binds)
      .all<SupplyHistoryChartRow>();
    raw = mergeStructuralSupplementalHistoryIntoCharts(raw.map((point) => ({
      date: point.date,
      totalCirculatingUSD: point.totalCirculatingUSD ?? {},
    })), overlayRowsResult.results ?? []).map((point) => ({
      date: point.date,
      totalCirculatingUSD: point.totalCirculatingUSD,
    }));
  }

  const downsampled = downsample(raw);
  if (downsampled.length < MIN_DOWNSAMPLED_POINTS) {
    console.error(`[sync-charts] Downsampled payload too small (${downsampled.length}), preserving existing cache`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "downsampled-payload-too-small",
        rawPoints: raw.length,
        downsampledPoints: downsampled.length,
      }),
    };
  }

  await setCacheIfNewer(db, "stablecoin-charts", JSON.stringify(downsampled), syncStartSec);
  await setCache(db, "stablecoin-charts:last-write", "1");
  console.log(`[sync-charts] Cached ${downsampled.length} points (from ${raw.length} raw)`);
  return {
    itemCount: downsampled.length,
    metadata: JSON.stringify({ rawPoints: raw.length, downsampledPoints: downsampled.length, fxFixes: fixes }),
  };
}
