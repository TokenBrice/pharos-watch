import { getCache } from "../lib/db";
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { MINT_BURN_CONFIGS, SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";
import {
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  getGaugeBand,
} from "../lib/mint-burn-scoring";
import type { StablecoinData } from "../../../src/lib/types";
import { sumPegBuckets } from "../../../src/lib/supply";

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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMintBurnFlows = withErrorHandler(
  "mint-burn-flows",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoinParam = params.get("stablecoin");
    const hoursRaw = parseInt(params.get("hours") ?? "24", 10);
    const hours = Math.max(1, Math.min(720, isNaN(hoursRaw) ? 24 : hoursRaw));

    if (stablecoinParam) {
      return handlePerCoin(db, stablecoinParam, hours);
    }
    return handleAggregate(db, hours);
  },
);

// ---------------------------------------------------------------------------
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - hours * 3600;
  const window7d = nowSec - 7 * 24 * 3600;
  const baselineStart = nowSec - 30 * 24 * 3600;

  // Load grade-based classification (falls back to hardcoded SAFE_HAVEN_IDS if unavailable)
  const gradeClassification = await getGradeBasedClassification(db);

  // Load stablecoins cache for mcap lookup
  const stablecoinsCached = await getCache(db, "stablecoins");
  const mcapById = new Map<string, number>();
  if (stablecoinsCached) {
    try {
      const { peggedAssets } = JSON.parse(stablecoinsCached.value) as {
        peggedAssets: StablecoinData[];
      };
      for (const asset of peggedAssets) {
        if (TRACKED_IDS.has(asset.id)) {
          mcapById.set(asset.id, sumPegBuckets(asset.circulating));
        }
      }
    } catch {
      // Proceed without mcap data — gauge will be null
    }
  }

  // Parallel queries: hourly data for window, 7d window, 30d baseline, largest events
  const [hourlyResult, hourly7dResult, baselineResult, largestEventsResult] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                mint_volume_usd, burn_volume_usd, net_flow_usd
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         ORDER BY hour_ts ASC`,
      )
      .bind(windowStart)
      .all<HourlyRow>(),
    db
      .prepare(
        `SELECT stablecoin_id,
                SUM(net_flow_usd) as net_flow_usd
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(window7d)
      .all<{ stablecoin_id: string; net_flow_usd: number }>(),
    db
      .prepare(
        `SELECT stablecoin_id,
                AVG(daily_net) as avg_daily_net,
                AVG(daily_abs) as avg_daily_abs,
                COUNT(DISTINCT day_ts) as data_days
         FROM (
           SELECT stablecoin_id,
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs
           FROM mint_burn_hourly
           WHERE hour_ts >= ?
           GROUP BY stablecoin_id, day_ts
         )
         GROUP BY stablecoin_id`,
      )
      .bind(baselineStart)
      .all<{
        stablecoin_id: string;
        avg_daily_net: number;
        avg_daily_abs: number;
        data_days: number;
      }>(),
    db
      .prepare(
        `SELECT e.*
         FROM mint_burn_events e
         INNER JOIN (
           SELECT stablecoin_id, MAX(COALESCE(amount_usd, amount)) as max_val
           FROM mint_burn_events
           WHERE timestamp >= ?
           GROUP BY stablecoin_id
         ) m ON e.stablecoin_id = m.stablecoin_id
            AND COALESCE(e.amount_usd, e.amount) = m.max_val
            AND e.timestamp >= ?
         GROUP BY e.stablecoin_id`,
      )
      .bind(nowSec - 24 * 3600, nowSec - 24 * 3600)
      .all<EventRow>(),
  ]);

  const hourlyRows = hourlyResult.results ?? [];
  const net7dMap = new Map(
    (hourly7dResult.results ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]),
  );
  const baselineMap = new Map(
    (baselineResult.results ?? []).map((r) => [
      r.stablecoin_id,
      { avgNet: r.avg_daily_net, avgAbs: r.avg_daily_abs, dataDays: r.data_days },
    ]),
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
    netFlow24hUsd: number;
    mintVolume24hUsd: number;
    burnVolume24hUsd: number;
    mintCount24h: number;
    burnCount24h: number;
    netFlow7dUsd: number;
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

  for (const config of MINT_BURN_CONFIGS) {
    const id = config.stablecoinId;
    const agg = coinAgg.get(id);
    const baseline = baselineMap.get(id);
    const mcap = mcapById.get(id) ?? 0;
    trackedMcapUsd += mcap;

    const netFlow24h = agg?.netFlow ?? 0;
    const intensity = baseline
      ? computeFlowIntensity({
          currentDailyNet: netFlow24h,
          baselineDailyNet: baseline.avgNet,
          baselineDailyAbs: baseline.avgAbs,
          dataAgeDays: baseline.dataDays,
        })
      : null;

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
      netFlow24hUsd: netFlow24h,
      mintVolume24hUsd: agg?.mintVolume ?? 0,
      burnVolume24hUsd: agg?.burnVolume ?? 0,
      mintCount24h: agg?.mintCount ?? 0,
      burnCount24h: agg?.burnCount ?? 0,
      netFlow7dUsd: net7dMap.get(id) ?? 0,
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
    ? Math.max(...hourlyRows.map((r) => r.hour_ts))
    : nowSec;

  const body = {
    gauge: {
      score: gaugeScore,
      band: gaugeBand?.label ?? null,
      flightToQuality: ftq.active,
      flightIntensity: ftq.intensity,
      trackedCoins: MINT_BURN_CONFIGS.length,
      trackedMcapUsd,
    },
    coins,
    hourly,
    updatedAt,
  };

  return new Response(JSON.stringify(body), {
    headers: addFreshnessHeaders(
      {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,
      },
      updatedAt,
      300,
    ),
  });
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
    return new Response(
      JSON.stringify({ error: `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - hours * 3600;

  const hourlyResult = await db
    .prepare(
      `SELECT chain_id, hour_ts, mint_count, burn_count,
              mint_volume_usd, burn_volume_usd, net_flow_usd
       FROM mint_burn_hourly
       WHERE stablecoin_id = ? AND hour_ts >= ?
       ORDER BY hour_ts ASC`,
    )
    .bind(stablecoinId, windowStart)
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
    ? Math.max(...rows.map((r) => r.hour_ts))
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

  return new Response(JSON.stringify(body), {
    headers: addFreshnessHeaders(
      {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,
      },
      updatedAt,
      300,
    ),
  });
}
