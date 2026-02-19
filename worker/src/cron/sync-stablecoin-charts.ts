import { setCacheIfNewer } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { DEFILLAMA_BASE } from "../lib/constants";

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

  const downsampled = downsample(raw);

  await setCacheIfNewer(db, "stablecoin-charts", JSON.stringify(downsampled), syncStartSec);
  console.log(`[sync-charts] Cached ${downsampled.length} points (from ${raw.length} raw)`);
}
