import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { getCache, batchExecute } from "../../lib/db";
import type { LiquidityMetrics, FullScoreResult, GlobalAgg, DexPriceObs } from "./types";
import { computeDurabilityScore, computeLiquidityScore, normalizeProtocol } from "./pool-helpers";

function getPoolExtraNumber(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: string,
): number | null {
  const value = extra?.[key as keyof NonNullable<typeof extra>];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPoolExtraBoolean(
  extra: LiquidityMetrics["topPools"][number]["extra"] | undefined,
  key: string,
): boolean | null {
  const value = extra?.[key as keyof NonNullable<typeof extra>];
  return typeof value === "boolean" ? value : null;
}

function rebuildMetricsFromPools(pools: LiquidityMetrics["topPools"]) {
  const protocolTvl: Record<string, number> = {};
  const chainTvl: Record<string, number> = {};
  const chains = new Set<string>();
  const pairs = new Set<string>();

  let totalTvlUsd = 0;
  let totalVolume24hUsd = 0;
  let totalVolume7dUsd = 0;
  let qualityAdjustedTvl = 0;
  let effectiveTvl = 0;
  let balanceRatioWeightedSum = 0;
  let totalTvlForBalance = 0;
  let organicTvlWeightedSum = 0;
  let totalTvlForOrganic = 0;
  let stressWeightedSum = 0;
  let oldestPoolDays = 0;
  let lockedLiqWeightedSum = 0;
  let totalTvlForLocked = 0;

  for (const pool of pools) {
    const proto = normalizeProtocol(pool.project);
    protocolTvl[proto] = (protocolTvl[proto] ?? 0) + pool.tvlUsd;
    chainTvl[pool.chain] = (chainTvl[pool.chain] ?? 0) + pool.tvlUsd;
    chains.add(pool.chain);
    pairs.add(pool.symbol);

    totalTvlUsd += pool.tvlUsd;
    totalVolume24hUsd += pool.volumeUsd1d || 0;
    totalVolume7dUsd += pool.volumeUsd7d ?? 0;
    qualityAdjustedTvl += getPoolExtraNumber(pool.extra, "qualityAdjustedTvl") ?? pool.tvlUsd;
    effectiveTvl += getPoolExtraNumber(pool.extra, "effectiveTvl") ?? pool.tvlUsd;

    const balanceRatio = getPoolExtraNumber(pool.extra, "balanceRatio");
    if (balanceRatio != null) {
      balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
      totalTvlForBalance += pool.tvlUsd;
    }

    const organicFraction = getPoolExtraNumber(pool.extra, "organicFraction");
    const hasMeasuredOrganicFraction = getPoolExtraBoolean(pool.extra, "hasMeasuredOrganicFraction") ?? false;
    if (organicFraction != null && hasMeasuredOrganicFraction) {
      organicTvlWeightedSum += pool.tvlUsd * organicFraction;
      totalTvlForOrganic += pool.tvlUsd;
    }

    const stressIndex = getPoolExtraNumber(pool.extra, "stressIndex");
    if (stressIndex != null) {
      stressWeightedSum += pool.tvlUsd * stressIndex;
    }

    const maturityDays = getPoolExtraNumber(pool.extra, "maturityDays");
    if (maturityDays != null) {
      oldestPoolDays = Math.max(oldestPoolDays, maturityDays);
    }

    const lockedLiquidityPct = getPoolExtraNumber(pool.extra, "lockedLiquidityPct");
    if (lockedLiquidityPct != null && lockedLiquidityPct > 0) {
      lockedLiqWeightedSum += pool.tvlUsd * (lockedLiquidityPct / 100);
      totalTvlForLocked += pool.tvlUsd;
    }
  }

  let hhi = 0;
  if (totalTvlUsd > 0) {
    for (const pool of pools) {
      const share = pool.tvlUsd / totalTvlUsd;
      hhi += share * share;
    }
  }

  const visiblePools = [...pools]
    .sort((a, b) => (b.volumeUsd1d || 0) - (a.volumeUsd1d || 0) || b.tvlUsd - a.tvlUsd)
    .slice(0, 10);

  return {
    totalTvlUsd,
    totalVolume24hUsd,
    totalVolume7dUsd,
    poolCount: pools.length,
    chains,
    pairs,
    protocolTvl,
    chainTvl,
    qualityAdjustedTvl,
    effectiveTvl,
    balanceRatioWeightedSum,
    totalTvlForBalance,
    organicTvlWeightedSum,
    totalTvlForOrganic,
    stressWeightedSum,
    oldestPoolDays,
    lockedLiqWeightedSum,
    totalTvlForLocked,
    hhi,
    visiblePools,
  };
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
export async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  protocolTvlCaps: Map<string, number>,
): Promise<{ scores: Map<string, FullScoreResult>; globalAgg: GlobalAgg }> {
  // Pre-fetch depth stability for durability computation
  const stabilityMap = new Map<string, number>();
  try {
    const stabRows = await db
      .prepare("SELECT stablecoin_id, depth_stability FROM dex_liquidity WHERE depth_stability IS NOT NULL")
      .all<{ stablecoin_id: string; depth_stability: number }>();
    for (const row of stabRows.results ?? []) {
      stabilityMap.set(row.stablecoin_id, row.depth_stability);
    }
  } catch { /* first run has no data */ }

  // Pre-fetch volume history for volume consistency (CV of 30-day volumes)
  const volumeStabilityMap = new Map<string, number>();
  try {
    const todayMidnightForVol = Math.floor(Date.now() / 86_400_000) * 86_400;
    const thirtyDaysAgoVol = todayMidnightForVol - 30 * 86_400;
    const volRows = await db
      .prepare(
        `SELECT stablecoin_id, total_volume_24h_usd
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date`
      )
      .bind(thirtyDaysAgoVol)
      .all<{ stablecoin_id: string; total_volume_24h_usd: number }>();
    const volByCoin = new Map<string, number[]>();
    for (const row of volRows.results ?? []) {
      const arr = volByCoin.get(row.stablecoin_id) ?? [];
      arr.push(row.total_volume_24h_usd);
      volByCoin.set(row.stablecoin_id, arr);
    }
    for (const [coinId, vols] of volByCoin) {
      if (vols.length < 7) continue;
      const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
      if (mean <= 0) continue;
      const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length;
      const cv = Math.sqrt(variance) / mean;
      volumeStabilityMap.set(coinId, Math.round((1 - Math.min(1, cv)) * 10000) / 10000);
    }
  } catch { /* first run has no data */ }

  const results = new Map<string, FullScoreResult>();

  // Global dedup accumulators — accumulated per-coin BEFORE top-10 truncation
  const globalSeenPools = new Set<string>();
  const globalProtocolTvl: Record<string, number> = {};
  const globalChainTvl: Record<string, number> = {};
  const globalProtoChainTvl: Record<string, number> = {}; // "proto:chain" → TVL
  let globalTotalTvl = 0;
  let globalTotalVol24h = 0;
  let globalTotalVol7d = 0;
  let globalPoolCount = 0;
  const globalChains = new Set<string>();

  for (const [id, m] of metrics) {
    // Filter pools with absurd volume/TVL ratios (e.g. $183M vol on $52K TVL)
    // before sorting — bad data from any source (DL, GT) gets dropped.
    // 50x is generous: legit concentrated AMMs (Maverick, Uni V4) hit 15-25x.
    // Also filter fake TVL: >$100M with <$50K daily volume is not a real pool.
    m.topPools = m.topPools.filter((p) => {
      const vol = p.volumeUsd1d || 0;
      if (p.tvlUsd > 0 && vol / p.tvlUsd > 50) return false;
      if (p.tvlUsd > 100_000_000 && vol < 50_000) return false;
      return true;
    });

    // Protocol-level TVL cap: CG/GT CLMM pools systematically report inflated
    // virtual reserves. Scale down non-DL pools per protocol when their aggregate
    // exceeds the DL protocol TVL. DL pools are trusted and kept as-is.
    if (protocolTvlCaps.size > 0) {
      // Sum secondary-source TVL per normalized protocol
      const secondaryTvlByProto = new Map<string, number>();
      for (const p of m.topPools) {
        if (p.source === "dl") continue;
        const proto = normalizeProtocol(p.project);
        secondaryTvlByProto.set(proto, (secondaryTvlByProto.get(proto) ?? 0) + p.tvlUsd);
      }
      // Sum DL-source TVL per protocol (to know remaining cap headroom)
      const dlTvlByProto = new Map<string, number>();
      for (const p of m.topPools) {
        if (p.source !== "dl") continue;
        const proto = normalizeProtocol(p.project);
        dlTvlByProto.set(proto, (dlTvlByProto.get(proto) ?? 0) + p.tvlUsd);
      }
      // Scale down secondary pools where they exceed cap headroom
      for (const [proto, secTvl] of secondaryTvlByProto) {
        const cap = protocolTvlCaps.get(proto);
        if (cap == null || cap <= 0) continue;
        const dlTvl = dlTvlByProto.get(proto) ?? 0;
        const headroom = Math.max(0, cap - dlTvl);
        if (secTvl > headroom && secTvl > 0) {
          const scale = headroom / secTvl;
          for (const p of m.topPools) {
            if (p.source === "dl") continue;
            if (normalizeProtocol(p.project) !== proto) continue;
            p.tvlUsd = Math.round(p.tvlUsd * scale);
            if (p.extra) {
              const ex = p.extra as Record<string, number>;
              if (ex.qualityAdjustedTvl != null) ex.qualityAdjustedTvl = Math.round(ex.qualityAdjustedTvl * scale);
              if (ex.effectiveTvl != null) ex.effectiveTvl = Math.round(ex.effectiveTvl * scale);
            }
          }
        }
      }
    }

    const retainedPools = [...m.topPools];
    const rebuilt = rebuildMetricsFromPools(retainedPools);

    // Recompute aggregates from retained pools so filtered/capped pools cannot
    // continue influencing score inputs through stale pre-filter metrics.
    m.protocolTvl = rebuilt.protocolTvl;
    m.chainTvl = rebuilt.chainTvl;
    m.totalTvlUsd = rebuilt.totalTvlUsd;
    m.totalVolume24hUsd = rebuilt.totalVolume24hUsd;
    m.totalVolume7dUsd = rebuilt.totalVolume7dUsd;
    m.poolCount = rebuilt.poolCount;
    m.chains = rebuilt.chains;
    m.pairs = rebuilt.pairs;
    m.qualityAdjustedTvl = rebuilt.qualityAdjustedTvl;
    m.effectiveTvl = rebuilt.effectiveTvl;
    m.balanceRatioWeightedSum = rebuilt.balanceRatioWeightedSum;
    m.totalTvlForBalance = rebuilt.totalTvlForBalance;
    m.organicTvlWeightedSum = rebuilt.organicTvlWeightedSum;
    m.totalTvlForOrganic = rebuilt.totalTvlForOrganic;
    m.stressWeightedSum = rebuilt.stressWeightedSum;
    m.oldestPoolDays = rebuilt.oldestPoolDays;
    m.lockedLiqWeightedSum = rebuilt.lockedLiqWeightedSum;
    m.totalTvlForLocked = rebuilt.totalTvlForLocked;

    // Global dedup: accumulate from ALL pools (pre-truncation) so every physical
    // pool is counted once even when shared by multiple stablecoins.
    for (const p of retainedPools) {
      if (globalSeenPools.has(p.poolId)) continue;
      globalSeenPools.add(p.poolId);
      globalTotalTvl += p.tvlUsd;
      globalTotalVol24h += p.volumeUsd1d;
      globalTotalVol7d += p.volumeUsd7d ?? 0;
      globalPoolCount++;
      const chainKey = p.chain.toLowerCase();
      globalChains.add(chainKey);
      const proto = normalizeProtocol(p.project);
      globalProtocolTvl[proto] = (globalProtocolTvl[proto] ?? 0) + p.tvlUsd;
      globalChainTvl[chainKey] = (globalChainTvl[chainKey] ?? 0) + p.tvlUsd;
      // Track protocol→chain TVL for proportional chain cap reduction
      const pcKey = `${proto}:${chainKey}`;
      globalProtoChainTvl[pcKey] = (globalProtoChainTvl[pcKey] ?? 0) + p.tvlUsd;
    }

    m.topPools = rebuilt.visiblePools;

    // v2: Compute durability score
    const tvlStab = stabilityMap.get(id) ?? null;
    const volStab = volumeStabilityMap.get(id) ?? null;
    const durability = computeDurabilityScore(m, tvlStab, volStab);

    // v2: Compute 6-component score
    const { score, components } = computeLiquidityScore(m, durability);

    // v2: Compute aggregate metrics
    const weightedBalanceRatio = m.totalTvlForBalance > 0
      ? Math.round((m.balanceRatioWeightedSum / m.totalTvlForBalance) * 10000) / 10000
      : null;
    const organicFrac = m.totalTvlForOrganic > 0
      ? Math.round((m.organicTvlWeightedSum / m.totalTvlForOrganic) * 10000) / 10000
      : null;
    const avgStress = m.totalTvlUsd > 0
      ? Math.round((m.stressWeightedSum / m.totalTvlUsd) * 100) / 100
      : null;
    const lockedLiqPct = m.totalTvlForLocked > 0
      ? Math.round((m.lockedLiqWeightedSum / m.totalTvlForLocked) * 10000) / 10000
      : null;

    results.set(id, {
      tvl: m.totalTvlUsd,
      vol24h: m.totalVolume24hUsd,
      score,
      hhi: Math.round(rebuilt.hhi * 10000) / 10000,
      durability,
      components,
      weightedBalanceRatio,
      organicFrac,
      avgStress,
      lockedLiqPct,
    });
  }

  // Global protocol-level TVL cap: clamp deduped protocol totals at DL protocol TVL.
  // After cross-stablecoin dedup, a protocol can still exceed its real TVL when
  // CG/GT virtual reserves are inflated across many pools. The per-coin cap allows
  // up to protocolTvl PER stablecoin, but globally the protocol total must not
  // exceed DL's reported TVL. Chain TVLs are reduced proportionally.
  let globalCapReduction = 0;
  for (const proto of Object.keys(globalProtocolTvl)) {
    const cap = protocolTvlCaps.get(proto);
    if (cap != null && cap > 0 && globalProtocolTvl[proto] > cap) {
      const excess = globalProtocolTvl[proto] - cap;
      globalCapReduction += excess;
      // Distribute reduction to chain TVLs proportionally
      const protoTotal = globalProtocolTvl[proto];
      for (const [pcKey, pcTvl] of Object.entries(globalProtoChainTvl)) {
        if (!pcKey.startsWith(`${proto}:`)) continue;
        const chain = pcKey.slice(proto.length + 1);
        const chainReduction = (pcTvl / protoTotal) * excess;
        globalChainTvl[chain] = Math.max(0, (globalChainTvl[chain] ?? 0) - chainReduction);
      }
      globalProtocolTvl[proto] = cap;
    }
  }
  globalTotalTvl -= globalCapReduction;

  const globalAgg: GlobalAgg = {
    totalTvl: globalTotalTvl,
    totalVol24h: globalTotalVol24h,
    totalVol7d: globalTotalVol7d,
    poolCount: globalPoolCount,
    chainCount: globalChains.size,
    protocolTvl: globalProtocolTvl,
    chainTvl: globalChainTvl,
  };

  return { scores: results, globalAgg };
}

/** Compute depth stability (CV-based) from 30-day history and persist to D1. */
export async function computeDepthStability(db: D1Database): Promise<void> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400;
  try {
    const thirtyDaysAgo = todayMidnight - 30 * 86_400;
    const histRows = await db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date`
      )
      .bind(thirtyDaysAgo)
      .all<{ stablecoin_id: string; total_tvl_usd: number }>();

    // Group by stablecoin
    const histByCoin = new Map<string, number[]>();
    for (const row of histRows.results ?? []) {
      const arr = histByCoin.get(row.stablecoin_id) ?? [];
      arr.push(row.total_tvl_usd);
      histByCoin.set(row.stablecoin_id, arr);
    }

    const stabilityStmts: D1PreparedStatement[] = [];
    for (const [id, tvls] of histByCoin) {
      if (tvls.length < 7) continue; // Need at least 7 days for meaningful stability
      const mean = tvls.reduce((s, v) => s + v, 0) / tvls.length;
      if (mean <= 0) continue;
      const variance = tvls.reduce((s, v) => s + (v - mean) ** 2, 0) / tvls.length;
      const stddev = Math.sqrt(variance);
      const cv = stddev / mean;
      const stability = Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
      stabilityStmts.push(
        db.prepare("UPDATE dex_liquidity SET depth_stability = ? WHERE stablecoin_id = ?").bind(stability, id)
      );
    }
    if (stabilityStmts.length > 0) {
      await batchExecute(db, stabilityStmts);
      console.log(`[dex-liquidity] Updated depth stability for ${stabilityStmts.length} coins`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] Depth stability computation failed:", err);
  }
}

/** Compute DEX-implied prices from all observations (TVL-weighted median) and persist to dex_prices. */
export async function computeDexPrices(
  db: D1Database,
  priceObservations: Map<string, DexPriceObs[]>,
  nowSec: number,
): Promise<void> {
  if (priceObservations.size === 0) return;

  // Load primary prices from stablecoins cache for comparison
  const primaryPrices = new Map<string, number>();
  const cached = await getCache(db, "stablecoins");
  if (cached) {
    try {
      const { peggedAssets } = JSON.parse(cached.value) as { peggedAssets: { id: string; price?: number | null }[] };
      for (const a of peggedAssets) {
        if (a.price != null && typeof a.price === "number" && a.price > 0) {
          primaryPrices.set(a.id, a.price);
        }
      }
    } catch { /* ignore malformed cache */ }
  }

  const priceStmts: D1PreparedStatement[] = [];
  for (const [id, observations] of priceObservations) {
    if (observations.length === 0) continue;

    // TVL-weighted median: sort by price, walk until cumulative TVL crosses 50%
    observations.sort((a, b) => a.price - b.price);
    const totalTvl = observations.reduce((s, o) => s + o.tvl, 0);
    const halfTvl = totalTvl / 2;
    let cumTvl = 0;
    let medianPrice = observations[0].price;
    for (const obs of observations) {
      cumTvl += obs.tvl;
      if (cumTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }

    // Compute deviation from primary price
    const primaryPrice = primaryPrices.get(id);
    let deviationBps: number | null = null;
    if (primaryPrice != null && primaryPrice > 0) {
      deviationBps = Math.round(((medianPrice / primaryPrice) - 1) * 10000);
    }

    // Top 5 sources by TVL for transparency (spread to avoid mutating price-sorted array)
    const topSources = [...observations]
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5)
      .map((o) => ({ protocol: o.protocol, chain: o.chain, price: o.price, tvl: o.tvl }));

    const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
    const symbol = meta?.symbol ?? id;

    priceStmts.push(
      db
        .prepare(
          `INSERT INTO dex_prices
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(stablecoin_id) DO UPDATE SET
            symbol = excluded.symbol,
            dex_price_usd = excluded.dex_price_usd,
            source_pool_count = excluded.source_pool_count,
            source_total_tvl = excluded.source_total_tvl,
            deviation_from_primary_bps = excluded.deviation_from_primary_bps,
            primary_price_at_calc = excluded.primary_price_at_calc,
            price_sources_json = excluded.price_sources_json,
            updated_at = excluded.updated_at
          WHERE dex_prices.updated_at <= excluded.updated_at`
        )
        .bind(
          id,
          symbol,
          Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
          observations.length,
          Math.round(totalTvl),
          deviationBps,
          primaryPrice ?? null,
          JSON.stringify(topSources),
          nowSec
        )
    );
  }

  if (priceStmts.length > 0) {
    await batchExecute(db, priceStmts);
    console.log(`[dex-liquidity] Wrote ${priceStmts.length} DEX price observations to dex_prices`);
  }
}
