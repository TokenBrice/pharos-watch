// worker/src/cron/sync-yield-data.ts
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache, batchExecute } from "../lib/db";
import {
  USER_AGENT, CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK,
  PYS_SCALING_FACTOR,
} from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getChainRpc } from "../lib/chain-rpcs";
import {
  computeApyFromRate, computeApyFromPrice, computePYS,
  computeYieldStability, computeApyVarianceScore,
} from "./yield-helpers";
import {
  YIELD_VARIANT_MAP, YIELD_POOL_MAP, ON_CHAIN_RATE_CONFIGS,
} from "./yield-config";
import {
  computeOverallGrade, scoreDecentralization, scoreDependencyRisk,
  scoreLiquidity, scorePegStability, scoreResilience,
} from "../../../src/lib/report-cards";
import { computePegScore } from "../../../src/lib/peg-score";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import type { StablecoinData, PegSummaryCoin, DexLiquidityData } from "../../../src/lib/types";
import type { CronResult } from "../lib/db";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";

interface DlPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number;
  stablecoin: boolean;
  exposure: string;
  underlyingTokens: string[] | null;
}

interface ResolvedYield {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: "onchain" | "defillama" | "price-derived";
  exchangeRate: number | null;
}

// -- Tier 1: On-chain exchange rates -----------------------------------------

async function fetchOnChainRates(): Promise<Map<string, { rate: number }>> {
  const results = new Map<string, { rate: number }>();

  for (const config of ON_CHAIN_RATE_CONFIGS) {
    try {
      const rpc = getChainRpc(config.chain);
      if (!rpc) {
        console.warn(`[yield] No RPC for chain ${config.chain}`);
        continue;
      }

      const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
      const res = await fetchWithRetry(rpc.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: config.contract, data: callData }, "latest"],
          id: 1,
        }),
      });

      if (!res?.ok) continue;
      const body = await res.json() as { result?: string };
      if (!body.result || body.result === "0x") continue;

      const raw = BigInt(body.result);
      const rate = Number(raw) / 10 ** config.decimals;
      results.set(config.stablecoinId, { rate });
    } catch (err) {
      console.warn(`[yield] On-chain rate failed for ${config.stablecoinId}:`, err);
    }
  }

  return results;
}

// -- Tier 2: DeFiLlama pool matching -----------------------------------------

function matchDlPool(
  stablecoinId: string,
  symbol: string,
  dlPools: DlPool[],
): DlPool | null {
  // Layer 1: Static map
  const poolId = YIELD_POOL_MAP[stablecoinId];
  if (poolId) {
    const pool = dlPools.find((p) => p.pool === poolId);
    if (pool) return pool;
  }

  // Layer 2: Fallback matching
  const variant = YIELD_VARIANT_MAP[stablecoinId];
  const searchSymbols = [symbol.toLowerCase()];
  if (variant) searchSymbols.push(variant.variantSymbol.toLowerCase());

  const candidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    searchSymbols.some((s) => p.symbol.toLowerCase().includes(s))
  );

  if (candidates.length === 0) return null;
  // Pick highest TVL
  return candidates.reduce((best, p) => (p.tvlUsd > best.tvlUsd ? p : best));
}

// -- Tier 3: Price-derived APY -----------------------------------------------

async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  // Get most recent and ~30d-ago prices from supply_history
  const [recentRow, oldRow] = await Promise.all([
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId).first<{ price: number }>(),
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId, thirtyDaysAgo).first<{ price: number }>(),
  ]);

  if (!recentRow?.price || !oldRow?.price || oldRow.price <= 0) return null;
  return computeApyFromPrice(recentRow.price, oldRow.price, 30);
}

// -- Main sync function ------------------------------------------------------

export async function syncYieldData(db: D1Database): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const yieldCoins = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing);

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  // 1. Fetch DL pools (Tier 2 source)
  let dlPools: DlPool[] = [];
  if (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS)) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res?.ok) {
        const body = await res.json() as { data: DlPool[] };
        dlPools = body.data ?? [];
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      }
    } catch {
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
    }
  }

  // 2. Fetch on-chain rates (Tier 1 source)
  const onChainRates = await fetchOnChainRates();

  // 3. Read cached risk-free rate
  const rfCache = await getCache(db, "risk_free_rate");
  const riskFreeRate = rfCache ? parseFloat(rfCache.value) : RISK_FREE_RATE_FALLBACK;

  // 4. Compute safety scores inline (report-cards API does NOT cache results)
  //    Follows the same two-phase approach as daily-digest.ts
  const safetyScores = await computeSafetyScores(db);

  // 5. Resolve yield for each coin
  const resolved: { id: string; symbol: string; yield: ResolvedYield | null }[] = [];
  const tier1PrevRates = new Map<string, number | null>();

  for (const meta of yieldCoins) {
    const id = meta.id;
    const symbol = meta.symbol;

    // Tier 1: On-chain rate
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      const { rate } = onChainRates.get(id)!;
      // Need previous rate from yield_history
      const prevRow = await db.prepare(
        "SELECT exchange_rate FROM yield_history WHERE stablecoin_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1"
      ).bind(id, startSec - 7 * 86400).first<{ exchange_rate: number | null }>();
      tier1PrevRates.set(id, prevRow?.exchange_rate ?? null);

      if (prevRow?.exchange_rate && prevRow.exchange_rate > 0) {
        const apy = computeApyFromRate(rate, prevRow.exchange_rate, 7);
        resolved.push({
          id, symbol,
          yield: { currentApy: apy, apyBase: apy, apyReward: null, sourcePool: null, sourceTvlUsd: null, dataSource: "onchain", exchangeRate: rate },
        });
        continue;
      }
      // Fall through if no previous rate yet (first run)
    }

    // Tier 2: DeFiLlama pool match
    const pool = matchDlPool(id, symbol, dlPools);
    if (pool && pool.apy != null && pool.apy >= 0) {
      resolved.push({
        id, symbol,
        yield: {
          currentApy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          sourcePool: pool.pool,
          sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
        },
      });
      continue;
    }

    // Tier 3: Price-derived (navTokens only)
    if (meta.flags.navToken) {
      const apy = await getPriceDerivedApy(db, id);
      if (apy != null) {
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "price-derived",
            exchangeRate: null,
          },
        });
        continue;
      }
    }

    // No data available
    resolved.push({ id, symbol, yield: null });
  }

  // 6. Compute trailing averages, PYS, and store
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  let updatedCount = 0;

  // Phase 2: compute warning signals here (see yield-helpers.ts::detectWarningSignals)

  for (const { id, symbol, yield: y } of resolved) {
    if (!y) continue;

    const meta = yieldCoins.find((m) => m.id === id)!;
    const yieldConfig = meta.yieldConfig;

    // Load historical APY samples for trailing averages
    const histRows = await db.prepare(
      "SELECT apy, recorded_at, source_tvl_usd FROM yield_history WHERE stablecoin_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC"
    ).bind(id, startSec - 30 * 86400).all<{ apy: number; recorded_at: number; source_tvl_usd: number | null }>();

    const samples = (histRows.results ?? []).map((r) => r.apy);
    samples.push(y.currentApy);

    const sevenDaysAgo = startSec - 7 * 86400;
    const apy7dSamples = (histRows.results ?? [])
      .filter((r) => r.recorded_at >= sevenDaysAgo)
      .map((r) => r.apy);
    apy7dSamples.push(y.currentApy);
    const apy7d = apy7dSamples.reduce((s, v) => s + v, 0) / apy7dSamples.length;
    const apy30d = samples.reduce((s, v) => s + v, 0) / samples.length;

    const apyVarianceScore = computeApyVarianceScore(samples);
    const yieldStability = computeYieldStability(samples);
    const variance30d = samples.length >= 2
      ? Math.sqrt(samples.reduce((s, v) => s + (v - apy30d) ** 2, 0) / samples.length)
      : null;
    const apyMin30d = samples.length > 0 ? Math.min(...samples) : null;
    const apyMax30d = samples.length > 0 ? Math.max(...samples) : null;

    // Safety score
    const safetyScore = safetyScores.get(id) ?? 40; // default 40 for unrated
    const safetyGrade = safetyScores.has(id) ? (safetyScores.get(id + "_grade") ?? "NR") : "NR";

    // PYS
    const pys = computePYS({ apy30d, safetyScore: safetyScore as number, apyVarianceScore, scalingFactor: PYS_SCALING_FACTOR });
    const yieldToRisk = (101 - (safetyScore as number)) > 0 ? apy30d / (101 - (safetyScore as number)) : null;
    const excessYield = apy30d - riskFreeRate;

    // Previous exchange rate (for Tier 1 coins — cached from resolution phase)
    const prevExchangeRate = tier1PrevRates.get(id) ?? null;

    // Upsert yield_data
    yieldDataStmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO yield_data (
          stablecoin_id, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
          yield_source, yield_type, source_pool, source_tvl_usd, data_source,
          safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
          apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, symbol, y.currentApy, y.apyBase, y.apyReward, apy7d, apy30d,
        yieldConfig?.yieldSource ?? "Unknown", yieldConfig?.yieldType ?? "nav-appreciation",
        y.sourcePool, y.sourceTvlUsd, y.dataSource,
        safetyScore as number, safetyGrade as string, pys, yieldToRisk, excessYield, yieldStability,
        variance30d, apyMin30d, apyMax30d, y.exchangeRate, prevExchangeRate, startSec,
      )
    );

    // Insert yield_history point
    historyStmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, startSec, y.currentApy, y.apyBase, y.apyReward, y.exchangeRate, y.sourceTvlUsd, y.dataSource)
    );

    updatedCount++;
  }

  // 7. Batch write
  if (yieldDataStmts.length > 0) await batchExecute(db, yieldDataStmts);
  if (historyStmts.length > 0) await batchExecute(db, historyStmts);

  // 8. Prune old history (>365 days)
  const pruneCutoff = startSec - 365 * 86400;
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();

  // 9. Cache the rankings response for fast API reads
  const rankingsData = await db.prepare("SELECT * FROM yield_data ORDER BY pharos_yield_score DESC").all();
  await setCache(db, "yield-rankings", JSON.stringify({
    rankings: (rankingsData.results ?? []).map(rowToRanking),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    updatedAt: startSec,
  }));

  console.log(`[sync-yield-data] Updated ${updatedCount}/${yieldCoins.length} coins`);
  return { itemCount: updatedCount, metadata: `${updatedCount} coins, rf=${riskFreeRate}%` };
}

// -- Helpers -----------------------------------------------------------------

/**
 * Compute safety scores inline -- report-cards API handler does NOT cache results,
 * so we must compute them ourselves (same approach as daily-digest.ts lines 426-558).
 */
async function computeSafetyScores(db: D1Database): Promise<Map<string, number | string>> {
  const scores = new Map<string, number | string>();

  try {
    // Load stablecoins cache (for price data / peg types)
    const stablecoinsCache = await getCache(db, "stablecoins");
    let peggedAssets: StablecoinData[] = [];
    if (stablecoinsCache) {
      const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
      peggedAssets = parsed.peggedAssets;
    }
    const priceById = new Map(peggedAssets.map((a) => [a.id, a]));

    // Load depeg events (4-year window) + dex liquidity
    const nowSec = Math.floor(Date.now() / 1000);
    const fourYearsAgoSec = nowSec - Math.ceil(4 * 365.25 * 86400);
    const [eventsResult, dexLiqResult] = await Promise.all([
      db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
        .bind(fourYearsAgoSec)
        .all<DepegRow>(),
      db.prepare("SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count FROM dex_liquidity")
        .all<{ stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; pool_count: number; chain_count: number }>(),
    ]);

    // Build depeg event lookup using rowToDepegEvent for proper typing
    const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);
    const eventsByCoin = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const list = eventsByCoin.get(e.stablecoinId) ?? [];
      list.push(e);
      eventsByCoin.set(e.stablecoinId, list);
    }

    // Build dex liquidity lookup
    const dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">> = {};
    for (const row of dexLiqResult.results ?? []) {
      dexLiqMap[row.stablecoin_id] = {
        liquidityScore: row.liquidity_score,
        concentrationHhi: row.concentration_hhi,
        poolCount: row.pool_count,
        chainCount: row.chain_count,
      };
    }

    const overallScores = new Map<string, number>();

    // Phase 1: non-dependent coins
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.navToken) continue;
      if (meta.flags.governance === "centralized-dependent") continue;

      const asset = priceById.get(meta.id);
      const events = eventsByCoin.get(meta.id) ?? [];
      const trackingStart = events.length > 0
        ? Math.min(Math.min(...events.map((e) => e.startedAt)), fourYearsAgoSec)
        : fourYearsAgoSec;
      const scoreResult = computePegScore(events, trackingStart, nowSec);

      const pegData: PegSummaryCoin = {
        id: meta.id, symbol: meta.symbol, name: meta.name,
        pegType: asset?.pegType ?? "", pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: null, pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct, severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty, eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg, lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
      };

      const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";
      const dims = {
        pegStability: scorePegStability(pegData, meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        resilience: scoreResilience(meta, canBl),
        decentralization: scoreDecentralization(meta.flags.governance, meta),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };
      const overall = computeOverallGrade(dims, { navToken: !!meta.flags.navToken });
      if (overall.score !== null) {
        overallScores.set(meta.id, overall.score);
        scores.set(meta.id, overall.score);
        scores.set(meta.id + "_grade", overall.grade);
      }
    }

    // Phase 2: dependent coins (need parent scores computed first)
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.navToken) continue;
      if (meta.flags.governance !== "centralized-dependent") continue;

      const asset = priceById.get(meta.id);
      const events = eventsByCoin.get(meta.id) ?? [];
      const trackingStart = events.length > 0
        ? Math.min(Math.min(...events.map((e) => e.startedAt)), fourYearsAgoSec)
        : fourYearsAgoSec;
      const scoreResult = computePegScore(events, trackingStart, nowSec);

      const pegData: PegSummaryCoin = {
        id: meta.id, symbol: meta.symbol, name: meta.name,
        pegType: asset?.pegType ?? "", pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: null, pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct, severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty, eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg, lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
      };

      const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";
      const dims = {
        pegStability: scorePegStability(pegData, meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        resilience: scoreResilience(meta, canBl),
        decentralization: scoreDecentralization(meta.flags.governance, meta),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };
      const overall = computeOverallGrade(dims, { navToken: false });
      if (overall.score !== null) {
        overallScores.set(meta.id, overall.score);
        scores.set(meta.id, overall.score);
        scores.set(meta.id + "_grade", overall.grade);
      }
    }
  } catch (err) {
    console.warn("[yield] Safety score computation failed, using fallbacks:", err);
  }

  return scores;
}

function rowToRanking(row: Record<string, unknown>) {
  return {
    id: row.stablecoin_id,
    symbol: row.symbol,
    name: TRACKED_STABLECOINS.find((m) => m.id === row.stablecoin_id)?.name ?? String(row.symbol),
    currentApy: row.current_apy,
    apy7d: row.apy_7d,
    apy30d: row.apy_30d,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    yieldSource: row.yield_source,
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: row.source_tvl_usd,
    pharosYieldScore: row.pharos_yield_score,
    safetyScore: row.safety_score,
    safetyGrade: row.safety_grade,
    yieldToRisk: row.yield_to_risk,
    excessYield: row.excess_yield,
    yieldStability: row.yield_stability,
    apyVariance30d: row.apy_variance_30d,
    apyMin30d: row.apy_min_30d,
    apyMax30d: row.apy_max_30d,
  };
}
