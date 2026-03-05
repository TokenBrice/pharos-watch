import type { DexLiquidityData } from "@shared/types";

interface DexLiquidityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  pool_count: number;
  chain_count: number;
}

export type DexLiquiditySnapshot = Pick<
  DexLiquidityData,
  "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"
>;

export type DexLiquidityMap = Record<string, DexLiquiditySnapshot>;

export async function loadDexLiquidityMap(db: D1Database): Promise<DexLiquidityMap> {
  const rows = await db
    .prepare("SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count FROM dex_liquidity")
    .all<DexLiquidityRow>();

  const map: DexLiquidityMap = {};
  for (const row of rows.results ?? []) {
    map[row.stablecoin_id] = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
    };
  }

  return map;
}
