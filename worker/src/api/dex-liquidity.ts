import { withErrorHandler } from "../lib/api-utils";

interface DexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  total_volume_7d_usd: number;
  pool_count: number;
  pair_count: number;
  chain_count: number;
  protocol_tvl_json: string | null;
  chain_tvl_json: string | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  depth_stability: number | null;
  updated_at: number;
  effective_tvl_usd: number | null;
  avg_pool_stress: number | null;
  weighted_balance_ratio: number | null;
  organic_fraction: number | null;
  durability_score: number | null;
  score_components_json: string | null;
}

interface DexHistoryRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  snapshot_date: number;
}

interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  price_sources_json: string | null;
  updated_at: number;
}

export const handleDexLiquidity = withErrorHandler("dex-liquidity", async (db: D1Database): Promise<Response> => {
  const [result, histResult, priceResult] = await Promise.all([
    db.prepare("SELECT * FROM dex_liquidity ORDER BY liquidity_score DESC").all<DexLiquidityRow>(),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, snapshot_date
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date DESC`
      )
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400) // 8 days back covers 7d comparison
      .all<DexHistoryRow>(),
    db.prepare("SELECT * FROM dex_prices").all<DexPriceRow>().catch(() => ({ results: [] as DexPriceRow[] })),
  ]);

  // Build DEX price lookup
  const dexPriceById = new Map<string, DexPriceRow>();
  for (const row of priceResult.results ?? []) {
    dexPriceById.set(row.stablecoin_id, row);
  }

  // Build historical TVL lookup: stablecoin_id → sorted snapshots (newest first)
  const histByCoin = new Map<string, { tvl: number; date: number }[]>();
  for (const row of histResult.results ?? []) {
    const arr = histByCoin.get(row.stablecoin_id) ?? [];
    arr.push({ tvl: row.total_tvl_usd, date: row.snapshot_date });
    histByCoin.set(row.stablecoin_id, arr);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSec - 86_400;
  const sevenDaysAgo = nowSec - 7 * 86_400;

  const map: Record<string, unknown> = {};
  for (const row of result.results ?? []) {
    const id = row.stablecoin_id;
    const currentTvl = row.total_tvl_usd;

    // Compute trend changes from history
    const history = histByCoin.get(id) ?? [];
    let tvlChange24h: number | null = null;
    let tvlChange7d: number | null = null;

    // Find closest snapshot to 1 day ago and 7 days ago
    for (const snap of history) {
      if (tvlChange24h == null && snap.date <= oneDayAgo && snap.tvl > 0) {
        tvlChange24h = ((currentTvl - snap.tvl) / snap.tvl) * 100;
      }
      if (tvlChange7d == null && snap.date <= sevenDaysAgo && snap.tvl > 0) {
        tvlChange7d = ((currentTvl - snap.tvl) / snap.tvl) * 100;
      }
      if (tvlChange24h != null && tvlChange7d != null) break;
    }

    // Merge DEX price data if available
    const dexPrice = dexPriceById.get(id);

    map[id] = {
      totalTvlUsd: currentTvl,
      totalVolume24hUsd: row.total_volume_24h_usd,
      totalVolume7dUsd: row.total_volume_7d_usd,
      poolCount: row.pool_count,
      pairCount: row.pair_count,
      chainCount: row.chain_count,
      protocolTvl: row.protocol_tvl_json ? JSON.parse(row.protocol_tvl_json) : {},
      chainTvl: row.chain_tvl_json ? JSON.parse(row.chain_tvl_json) : {},
      topPools: row.top_pools_json ? JSON.parse(row.top_pools_json) : [],
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      depthStability: row.depth_stability,
      tvlChange24h: tvlChange24h != null ? Math.round(tvlChange24h * 100) / 100 : null,
      tvlChange7d: tvlChange7d != null ? Math.round(tvlChange7d * 100) / 100 : null,
      updatedAt: row.updated_at,
      dexPriceUsd: dexPrice?.dex_price_usd ?? null,
      dexDeviationBps: dexPrice?.deviation_from_primary_bps ?? null,
      priceSourceCount: dexPrice?.source_pool_count ?? null,
      priceSourceTvl: dexPrice?.source_total_tvl ?? null,
      priceSources: dexPrice?.price_sources_json ? JSON.parse(dexPrice.price_sources_json) : null,
      // v2 fields
      effectiveTvlUsd: row.effective_tvl_usd ?? 0,
      avgPoolStress: row.avg_pool_stress ?? null,
      weightedBalanceRatio: row.weighted_balance_ratio ?? null,
      organicFraction: row.organic_fraction ?? null,
      durabilityScore: row.durability_score ?? null,
      scoreComponents: row.score_components_json
        ? (() => { try { return JSON.parse(row.score_components_json); } catch { return null; } })()
        : null,
    };
  }

  return new Response(JSON.stringify(map), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=300, max-age=60",
    },
  });
});
