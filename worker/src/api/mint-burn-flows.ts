import { getCache, setCache } from "../lib/db";
import { withErrorHandler, addFreshnessHeaders, resolveOrReject, errorResponse, parseIntParam, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { MINT_BURN_CONFIGS, SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";
import {
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  getGaugeBand,
} from "../lib/mint-burn-scoring";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import type { StablecoinData } from "@shared/types";
import { sumPegBuckets } from "@shared/lib/supply";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
} from "@shared/lib/mint-burn-signals";

// ---------------------------------------------------------------------------
// Safe-haven classification (flight-to-quality)
// ---------------------------------------------------------------------------

/** All tracked stablecoin IDs from config */
const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId));

/** Max age for report card cache before falling back to hardcoded set (2 hours) */
const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Score thresholds for grade-based FTQ classification */
const SAFE_SCORE_THRESHOLD = 65; // B+ or better → "safe"
const RISKY_SCORE_THRESHOLD = 50; // Below C → "risky"

interface ReportCardCache {
  scores: Record<string, { score: number; grade: string }>;
  updatedAt: number;
}

/**
 * Build safe/risky ID sets from report card cache.
 * Returns null if cache is missing, unparseable, or stale (>2h).
 */
async function getGradeBasedClassification(
  db: D1Database,
): Promise<{ safeIds: Set<string>; riskyIds: Set<string> } | null> {
  const cached = await getCache(db, "report_card_cache");
  if (!cached) return null;

  try {
    const data = JSON.parse(cached.value) as ReportCardCache;
    if (!data.scores || !data.updatedAt) return null;

    // Stale check: updatedAt is epoch seconds in cache, compare with current time
    const ageMs = Date.now() - data.updatedAt * 1000;
    if (ageMs > REPORT_CARD_MAX_AGE_MS) return null;

    const safeIds = new Set<string>();
    const riskyIds = new Set<string>();

    for (const [id, entry] of Object.entries(data.scores)) {
      if (!TRACKED_IDS.has(id)) continue;
      if (entry.score >= SAFE_SCORE_THRESHOLD) {
        safeIds.add(id);
      } else if (entry.score < RISKY_SCORE_THRESHOLD) {
        riskyIds.add(id);
      }
      // Scores between 50-64 are "neutral" — don't contribute to FTQ
    }

    return { safeIds, riskyIds };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface HourlyRow {
  stablecoin_id: string;
  chain_id: string;
  hour_ts: number;
  mint_count: number;
  burn_count: number;
  mint_volume_usd: number;
  burn_volume_usd: number;
  net_flow_usd: number;
}

interface DailyBaselineRow {
  stablecoin_id: string;
  day_ts: number;
  daily_net: number;
  daily_abs: number;
}

interface FirstSeenRow {
  stablecoin_id: string;
  first_hour_ts: number;
}

interface EventRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount: number;
  amount_usd: number | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

const DAY_SEC = 86400;
const BASELINE_WINDOW_DAYS = 30;
const FLOW_MAX_AGE_SEC = 300;
const FLOW_CACHE_PREFIX = "mint-burn-flows:v2";
const ETHEREUM_CHAIN_ID = "ethereum";

function bucketDay(ts: number): number {
  return Math.floor(ts / DAY_SEC) * DAY_SEC;
}

function aggregateFlowCacheKey(hours: number): string {
  return `${FLOW_CACHE_PREFIX}:aggregate:${hours}`;
}

function perCoinFlowCacheKey(stablecoinId: string, hours: number): string {
  return `${FLOW_CACHE_PREFIX}:coin:${stablecoinId}:${hours}`;
}

function cachedFlowFallbackResponse(cached: { value: string; updatedAt: number }): Response {
  const headers = addFreshnessHeaders({
    "Content-Type": "application/json",
    "Cache-Control": CACHE_PROFILES.standard,
  }, cached.updatedAt, FLOW_MAX_AGE_SEC);
  const fallbackWarning = "199 - \"Served cached mint/burn flows due transient backend error\"";
  headers.Warning = headers.Warning
    ? `${headers.Warning}, ${fallbackWarning}`
    : fallbackWarning;
  return new Response(cached.value, { headers });
}

/**
 * Build per-coin baseline inputs for FIS.
 *
 * Uses calendar-day windows and treats missing days as zero flow. This avoids
 * sparse-event coins being misclassified as "insufficient history" even when
 * they've been tracked for weeks.
 */
function buildBaselineMap(
  nowSec: number,
  dailyRows: DailyBaselineRow[],
  firstSeenRows: FirstSeenRow[],
): Map<string, { avgNet: number; avgAbs: number; dataDays: number }> {
  const nowDayTs = bucketDay(nowSec);
  const byCoinDay = new Map<string, Map<number, { net: number; abs: number }>>();

  for (const row of dailyRows) {
    if (!Number.isFinite(row.day_ts)) continue;
    const dayTs = bucketDay(row.day_ts);
    const perDay = byCoinDay.get(row.stablecoin_id) ?? new Map<number, { net: number; abs: number }>();
    const prev = perDay.get(dayTs) ?? { net: 0, abs: 0 };
    prev.net += row.daily_net;
    prev.abs += row.daily_abs;
    perDay.set(dayTs, prev);
    byCoinDay.set(row.stablecoin_id, perDay);
  }

  const baselineMap = new Map<string, { avgNet: number; avgAbs: number; dataDays: number }>();
  for (const row of firstSeenRows) {
    if (!Number.isFinite(row.first_hour_ts)) continue;
    const firstDayTs = bucketDay(row.first_hour_ts);
    if (firstDayTs > nowDayTs) continue;

    const trackedDays = Math.floor((nowDayTs - firstDayTs) / DAY_SEC) + 1;
    const dataDays = Math.max(0, Math.min(BASELINE_WINDOW_DAYS, trackedDays));
    if (dataDays === 0) continue;

    const startDayTs = nowDayTs - (dataDays - 1) * DAY_SEC;
    const perDay = byCoinDay.get(row.stablecoin_id);
    let sumNet = 0;
    let sumAbs = 0;

    for (let dayTs = startDayTs; dayTs <= nowDayTs; dayTs += DAY_SEC) {
      const bucket = perDay?.get(dayTs);
      if (!bucket) continue;
      sumNet += bucket.net;
      sumAbs += bucket.abs;
    }

    baselineMap.set(row.stablecoin_id, {
      avgNet: sumNet / dataDays,
      avgAbs: sumAbs / dataDays,
      dataDays,
    });
  }

  return baselineMap;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMintBurnFlows = withErrorHandler(
  "mint-burn-flows",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoinParam = params.get("stablecoin");
    const hours = parseIntParam(params.get("hours"), 24, 1, 720, "hours");
    if (hours instanceof Response) {
      return hours;
    }

    if (stablecoinParam) {
      const resolved = resolveOrReject(stablecoinParam);
      if (resolved instanceof Response) {
        return resolved;
      }
      return handlePerCoin(db, resolved.canonicalId, hours);
    }
    return handleAggregate(db, hours);
  },
);

// ---------------------------------------------------------------------------
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - hours * 3600;
    const window7d  = nowSec - 7  * 24 * 3600;
    const window30d = nowSec - 30 * 24 * 3600;
    const window90d = nowSec - 90 * 24 * 3600;
    const nowDayTs = bucketDay(nowSec);
    const baselineWindowStart = nowDayTs - (BASELINE_WINDOW_DAYS - 1) * DAY_SEC;

    // Load grade-based classification (falls back to hardcoded SAFE_HAVEN_IDS if unavailable)
    const gradeClassification = await getGradeBasedClassification(db);

    // Load stablecoins cache for mcap lookup
    const mcapById = new Map<string, number>();
    const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
    if (stablecoinsCacheResult.kind !== "ok") {
      const cached = await getCache(db, cacheKey);
      if (cached) {
        console.error(
          `[mint-burn-flows] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason}), ` +
          `serving fallback cache (${cacheKey})`,
        );
        return cachedFlowFallbackResponse(cached);
      }
      return errorResponse(503, "Stablecoins data not yet available");
    }
    for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
      if (TRACKED_IDS.has(asset.id)) {
        mcapById.set(asset.id, sumPegBuckets(asset.circulating));
      }
    }
    // Parallel queries: hourly data for window, 7d/30d/90d net sums, daily baseline rows,
    // first-seen timestamps (history age), and largest events.
    const [hourlyResult, hourly7dResult, hourly30dResult, hourly90dResult, baselineDailyResult, firstSeenResult, largestEventsResult] = await Promise.all([
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(ETHEREUM_CHAIN_ID, windowStart)
        .all<HourlyRow>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window7d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window30d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window90d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id, day_ts`,
        )
        .bind(ETHEREUM_CHAIN_ID, baselineWindowStart)
        .all<DailyBaselineRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, MIN(hour_ts) as first_hour_ts
           FROM mint_burn_hourly
           WHERE chain_id = ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID)
        .all<FirstSeenRow>(),
      db
        .prepare(
          `SELECT e.*
           FROM mint_burn_events e
           INNER JOIN (
             SELECT stablecoin_id, MAX(COALESCE(amount_usd, amount)) as max_val
             FROM mint_burn_events
             WHERE chain_id = ?
               AND timestamp >= ?
               AND (direction = 'mint' OR burn_type = 'effective_burn')
               AND flow_type = 'standard'
             GROUP BY stablecoin_id
           ) m ON e.stablecoin_id = m.stablecoin_id
              AND COALESCE(e.amount_usd, e.amount) = m.max_val
              AND e.chain_id = ?
              AND e.timestamp >= ?
              AND (e.direction = 'mint' OR e.burn_type = 'effective_burn')
              AND e.flow_type = 'standard'
           GROUP BY e.stablecoin_id
           HAVING e.timestamp = MAX(e.timestamp)`,
        )
        .bind(ETHEREUM_CHAIN_ID, windowStart, ETHEREUM_CHAIN_ID, windowStart)
        .all<EventRow>(),
    ]);

    const hourlyRows = hourlyResult.results ?? [];
    const net7dMap  = new Map((hourly7dResult.results  ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const net30dMap = new Map((hourly30dResult.results ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const net90dMap = new Map((hourly90dResult.results ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const baselineMap = buildBaselineMap(
      nowSec,
      baselineDailyResult.results ?? [],
      firstSeenResult.results ?? [],
    );
    const largestEventMap = new Map(
      (largestEventsResult.results ?? []).map((r) => [r.stablecoin_id, r]),
    );

    // Aggregate per-coin summaries from hourly rows
    const coinAgg = new Map<
      string,
      {
        mintVolume: number;
        burnVolume: number;
        mintCount: number;
        burnCount: number;
        netFlow: number;
      }
    >();
    for (const row of hourlyRows) {
      const agg = coinAgg.get(row.stablecoin_id) ?? {
        mintVolume: 0,
        burnVolume: 0,
        mintCount: 0,
        burnCount: 0,
        netFlow: 0,
      };
      agg.mintVolume += row.mint_volume_usd;
      agg.burnVolume += row.burn_volume_usd;
      agg.mintCount += row.mint_count;
      agg.burnCount += row.burn_count;
      agg.netFlow += row.net_flow_usd;
      coinAgg.set(row.stablecoin_id, agg);
    }

    // Compute FIS and build coin responses
    const coins: Array<{
      stablecoinId: string;
      symbol: string;
      flowIntensity: number | null;
      pressureShiftScore: number | null;
      pressureShiftState: "improving" | "stable" | "worsening" | "nr";
      netFlowDirection24h: "minting" | "burning" | "flat" | "inactive";
      has24hActivity: boolean;
      baselineDailyNetUsd: number | null;
      baselineDailyAbsUsd: number | null;
      baselineDataDays: number | null;
      netFlow24hUsd: number;
      mintVolume24hUsd: number;
      burnVolume24hUsd: number;
      mintCount24h: number;
      burnCount24h: number;
      netFlow7dUsd: number;
      netFlow30dUsd: number;
      netFlow90dUsd: number;
      largestEvent24h: {
        direction: string;
        amountUsd: number;
        txHash: string;
        timestamp: number;
      } | null;
    }> = [];

    const gaugeInputs: Array<{ intensity: number | null; mcap: number }> = [];
    let safeNet24h = 0;
    let riskyNet24h = 0;
    let trackedMcapUsd = 0;

    if (!gradeClassification) {
      console.warn("Report card cache stale/missing, falling back to hardcoded SAFE_HAVEN_IDS");
    }

    const seenCoinIds = new Set<string>();
    for (const config of MINT_BURN_CONFIGS) {
      const id = config.stablecoinId;
      if (seenCoinIds.has(id)) continue;
      seenCoinIds.add(id);
      const agg = coinAgg.get(id);
      const baseline = baselineMap.get(id);
      const mcap = mcapById.get(id) ?? 0;
      trackedMcapUsd += mcap;

      const netFlow24h = agg?.netFlow ?? 0;
      const has24hActivity = (agg?.mintCount ?? 0) > 0
        || (agg?.burnCount ?? 0) > 0
        || (agg?.mintVolume ?? 0) > 0
        || (agg?.burnVolume ?? 0) > 0;
      const intensity = has24hActivity && baseline
        ? computeFlowIntensity({
            currentDailyNet: netFlow24h,
            baselineDailyNet: baseline.avgNet,
            baselineDailyAbs: baseline.avgAbs,
            dataAgeDays: baseline.dataDays,
            currentDailyAbs: (agg?.mintVolume ?? 0) + (agg?.burnVolume ?? 0),
          })
        : null;
      const pressureShiftScore = intensity;
      const pressureShiftState = getPressureShiftState(pressureShiftScore);
      const netFlowDirection24h = getNetFlowDirection24h({
        netFlow24hUsd: netFlow24h,
        has24hActivity,
      });

      gaugeInputs.push({ intensity, mcap });

      if (gradeClassification) {
        // Grade-based: safe (>=65), risky (<50), neutral (50-64) ignored
        if (gradeClassification.safeIds.has(id)) {
          safeNet24h += netFlow24h;
        } else if (gradeClassification.riskyIds.has(id)) {
          riskyNet24h += netFlow24h;
        }
        // Neutral coins don't contribute to FTQ signal
      } else {
        // Fallback: hardcoded safe-haven set, everything else is risky
        if (SAFE_HAVEN_IDS.has(id)) {
          safeNet24h += netFlow24h;
        } else {
          riskyNet24h += netFlow24h;
        }
      }

      const largest = largestEventMap.get(id);
      coins.push({
        stablecoinId: id,
        symbol: config.symbol,
        flowIntensity: intensity,
        pressureShiftScore,
        pressureShiftState,
        netFlowDirection24h,
        has24hActivity,
        baselineDailyNetUsd: baseline?.avgNet ?? null,
        baselineDailyAbsUsd: baseline?.avgAbs ?? null,
        baselineDataDays: baseline?.dataDays ?? null,
        netFlow24hUsd: netFlow24h,
        mintVolume24hUsd: agg?.mintVolume ?? 0,
        burnVolume24hUsd: agg?.burnVolume ?? 0,
        mintCount24h: agg?.mintCount ?? 0,
        burnCount24h: agg?.burnCount ?? 0,
        netFlow7dUsd:  net7dMap.get(id)  ?? 0,
        netFlow30dUsd: net30dMap.get(id) ?? 0,
        netFlow90dUsd: net90dMap.get(id) ?? 0,
        largestEvent24h: largest
          ? {
              direction: largest.direction,
              amountUsd: largest.amount_usd ?? largest.amount,
              txHash: largest.tx_hash,
              timestamp: largest.timestamp,
            }
          : null,
      });
    }

    // Gauge score
    const gaugeScore = computeGaugeScore(gaugeInputs);
    const gaugeBand = gaugeScore !== null ? getGaugeBand(gaugeScore) : null;

    // Flight-to-quality
    const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });

    // Hourly timeseries (aggregate across all coins)
    const hourlyMap = new Map<number, { net: number; mint: number; burn: number }>();
    for (const row of hourlyRows) {
      const entry = hourlyMap.get(row.hour_ts) ?? { net: 0, mint: 0, burn: 0 };
      entry.net += row.net_flow_usd;
      entry.mint += row.mint_volume_usd;
      entry.burn += row.burn_volume_usd;
      hourlyMap.set(row.hour_ts, entry);
    }
    const hourly = [...hourlyMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, v]) => ({
        hourTs: ts,
        netFlowUsd: v.net,
        mintVolumeUsd: v.mint,
        burnVolumeUsd: v.burn,
      }));

    const updatedAt = hourlyRows.length > 0
      ? hourlyRows.reduce((m, r) => Math.max(m, r.hour_ts), -Infinity)
      : nowSec;

    const body = {
      gauge: {
        score: gaugeScore,
        band: gaugeBand?.label ?? null,
        intensitySemantics: "signed-v2",
        flightToQuality: ftq.active,
        flightIntensity: ftq.intensity,
        // Use deduped stablecoin count (configs can include multiple contracts/chains per coin).
        trackedCoins: coins.length,
        trackedMcapUsd,
      },
      coins,
      hourly,
      updatedAt,
    };

    await setCache(db, cacheKey, JSON.stringify(body));
    return jsonResponse(body, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.standard,
    }, updatedAt, FLOW_MAX_AGE_SEC));
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      console.error(`[mint-burn-flows] aggregate live query failed, serving fallback cache (${cacheKey})`, err);
      return cachedFlowFallbackResponse(cached);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-coin mode (with stablecoin param)
// ---------------------------------------------------------------------------

async function handlePerCoin(
  db: D1Database,
  stablecoinId: string,
  hours: number,
): Promise<Response> {
  const config = MINT_BURN_CONFIGS.find((c) => c.stablecoinId === stablecoinId);
  if (!config) {
    return errorResponse(404, `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows`);
  }

  const cacheKey = perCoinFlowCacheKey(stablecoinId, hours);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - hours * 3600;

    const hourlyResult = await db
      .prepare(
        `SELECT chain_id, hour_ts, mint_count, burn_count,
                mint_volume_usd, burn_volume_usd, net_flow_usd
         FROM mint_burn_hourly
         WHERE chain_id = ? AND stablecoin_id = ? AND hour_ts >= ?
         ORDER BY hour_ts ASC`,
      )
      .bind(ETHEREUM_CHAIN_ID, stablecoinId, windowStart)
      .all<HourlyRow>();

    const rows = hourlyResult.results ?? [];

    // Per-chain breakdown
    const chainMap = new Map<
      string,
      { mintVolume: number; burnVolume: number; mintCount: number; burnCount: number; netFlow: number }
    >();
    // Hourly timeseries (aggregate across chains)
    const hourlyAgg = new Map<number, { net: number; mint: number; burn: number }>();

    for (const row of rows) {
      // Chain breakdown
      const chain = chainMap.get(row.chain_id) ?? {
        mintVolume: 0, burnVolume: 0, mintCount: 0, burnCount: 0, netFlow: 0,
      };
      chain.mintVolume += row.mint_volume_usd;
      chain.burnVolume += row.burn_volume_usd;
      chain.mintCount += row.mint_count;
      chain.burnCount += row.burn_count;
      chain.netFlow += row.net_flow_usd;
      chainMap.set(row.chain_id, chain);

      // Hourly aggregate
      const entry = hourlyAgg.get(row.hour_ts) ?? { net: 0, mint: 0, burn: 0 };
      entry.net += row.net_flow_usd;
      entry.mint += row.mint_volume_usd;
      entry.burn += row.burn_volume_usd;
      hourlyAgg.set(row.hour_ts, entry);
    }

    const chains = [...chainMap.entries()].map(([chainId, v]) => ({
      chainId,
      mintVolumeUsd: v.mintVolume,
      burnVolumeUsd: v.burnVolume,
      mintCount: v.mintCount,
      burnCount: v.burnCount,
      netFlowUsd: v.netFlow,
    }));

    const hourly = [...hourlyAgg.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, v]) => ({
        hourTs: ts,
        netFlowUsd: v.net,
        mintVolumeUsd: v.mint,
        burnVolumeUsd: v.burn,
      }));

    // Totals
    let totalMint = 0;
    let totalBurn = 0;
    let totalMintCount = 0;
    let totalBurnCount = 0;
    for (const c of chainMap.values()) {
      totalMint += c.mintVolume;
      totalBurn += c.burnVolume;
      totalMintCount += c.mintCount;
      totalBurnCount += c.burnCount;
    }

    const updatedAt = rows.length > 0
      ? rows.reduce((m, r) => Math.max(m, r.hour_ts), -Infinity)
      : nowSec;

    const body = {
      stablecoinId,
      symbol: config.symbol,
      mintVolumeUsd: totalMint,
      burnVolumeUsd: totalBurn,
      netFlowUsd: totalMint - totalBurn,
      mintCount: totalMintCount,
      burnCount: totalBurnCount,
      chains,
      hourly,
      updatedAt,
    };

    await setCache(db, cacheKey, JSON.stringify(body));
    return jsonResponse(body, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.standard,
    }, updatedAt, FLOW_MAX_AGE_SEC));
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      console.error(`[mint-burn-flows] per-coin live query failed, serving fallback cache (${cacheKey})`, err);
      return cachedFlowFallbackResponse(cached);
    }
    throw err;
  }
}
