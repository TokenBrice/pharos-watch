import { withErrorHandler } from "../lib/api-utils";

export const handleDexLiquidity = withErrorHandler("dex-liquidity", async (db: D1Database): Promise<Response> => {
  const [result, histResult, priceResult] = await Promise.all([
    db.prepare("SELECT * FROM dex_liquidity ORDER BY liquidity_score DESC").all(),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, snapshot_date
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date DESC`
      )
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400) // 8 days back covers 7d comparison
      .all(),
    db.prepare("SELECT * FROM dex_prices").all().catch(() => ({ results: [] })),
  ]);

  // Build DEX price lookup
  const dexPriceById = new Map<string, {
    dex_price_usd: number;
    deviation_from_primary_bps: number | null;
    source_pool_count: number;
    source_total_tvl: number;
    price_sources_json: string | null;
  }>();
  for (const row of (priceResult as { results: unknown[] }).results ?? []) {
    const r = row as Record<string, unknown>;
    dexPriceById.set(r.stablecoin_id as string, {
      dex_price_usd: r.dex_price_usd as number,
      deviation_from_primary_bps: r.deviation_from_primary_bps as number | null,
      source_pool_count: r.source_pool_count as number,
      source_total_tvl: r.source_total_tvl as number,
      price_sources_json: r.price_sources_json as string | null,
    });
  }

  // Build historical TVL lookup: stablecoin_id → sorted snapshots (newest first)
  const histByCoin = new Map<string, { tvl: number; date: number }[]>();
  for (const row of histResult.results ?? []) {
    const id = row.stablecoin_id as string;
    const arr = histByCoin.get(id) ?? [];
    arr.push({ tvl: row.total_tvl_usd as number, date: row.snapshot_date as number });
    histByCoin.set(id, arr);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSec - 86_400;
  const sevenDaysAgo = nowSec - 7 * 86_400;

  const map: Record<string, unknown> = {};
  for (const row of result.results ?? []) {
    const id = row.stablecoin_id as string;
    const currentTvl = row.total_tvl_usd as number;

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
      totalVolume24hUsd: row.total_volume_24h_usd as number,
      totalVolume7dUsd: row.total_volume_7d_usd as number,
      poolCount: row.pool_count as number,
      pairCount: row.pair_count as number,
      chainCount: row.chain_count as number,
      protocolTvl: row.protocol_tvl_json ? JSON.parse(row.protocol_tvl_json as string) : {},
      chainTvl: row.chain_tvl_json ? JSON.parse(row.chain_tvl_json as string) : {},
      topPools: row.top_pools_json ? JSON.parse(row.top_pools_json as string) : [],
      liquidityScore: row.liquidity_score as number | null,
      concentrationHhi: row.concentration_hhi as number | null,
      depthStability: row.depth_stability as number | null,
      tvlChange24h: tvlChange24h != null ? Math.round(tvlChange24h * 100) / 100 : null,
      tvlChange7d: tvlChange7d != null ? Math.round(tvlChange7d * 100) / 100 : null,
      updatedAt: row.updated_at as number,
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
        ? (() => { try { return JSON.parse(row.score_components_json as string); } catch { return null; } })()
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
