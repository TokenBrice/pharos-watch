import { getCache, setCacheIfNewer } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { DEFILLAMA_BASE } from "../lib/constants";

/** Implied rate must be within 1/N to Nx of our cached FX rate.
 *  3x tolerates multi-year FX drift (e.g. ARS ~10x over 4 years won't hit
 *  recent points) while easily catching corruption like the RUB 22,000x bug. */
const RATE_TOLERANCE = 3;

interface RawChartPoint {
  date: number;
  totalCirculating?: Record<string, number>;
  totalCirculatingUSD?: Record<string, number>;
}

interface DownsampledPoint {
  date: number;
  totalCirculatingUSD: Record<string, number>;
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

export async function syncStablecoinCharts(db: D1Database): Promise<void> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const res = await fetchWithRetry(`${DEFILLAMA_BASE}/stablecoincharts/all`);

  if (!res || !res.ok) {
    console.error(`[sync-charts] DefiLlama API error: ${res?.status ?? "no response"}`);
    return;
  }

  const raw = (await res.json()) as RawChartPoint[];

  if (!Array.isArray(raw) || raw.length < 100) {
    console.error(`[sync-charts] Unexpected data length (${raw?.length}), skipping cache write`);
    return;
  }

  // Fix corrupted totalCirculatingUSD values (e.g. DefiLlama RUB bug Feb 2026)
  // by validating implied FX rates against known bounds and recomputing from
  // totalCirculating * cached FX rate when out of range.
  const fxCache = await getCache(db, "fx-rates");
  if (fxCache) {
    try {
      const fxRates = JSON.parse(fxCache.value) as Record<string, number>;
      let fixes = 0;
      for (const point of raw) {
        const circ = point.totalCirculating;
        const usd = point.totalCirculatingUSD;
        if (!circ || !usd) continue;
        for (const key of Object.keys(usd)) {
          if (key === "peggedUSD") continue;
          const rawVal = circ[key];
          if (!rawVal || rawVal <= 0) continue;
          const fxRate = fxRates[key];
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
    } catch {
      console.warn("[sync-charts] Could not parse cached FX rates, skipping USD fix");
    }
  }

  const downsampled = downsample(raw);

  await setCacheIfNewer(db, "stablecoin-charts", JSON.stringify(downsampled), syncStartSec);
  console.log(`[sync-charts] Cached ${downsampled.length} points (from ${raw.length} raw)`);
}
