import type { DexLiquidityData } from "@shared/types/market";

interface DexLiquidityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  pool_count: number;
  chain_count: number;
  updated_at: number | null;
}

type DexLiquiditySnapshot = Pick<
  DexLiquidityData,
  "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"
>;

export const DEX_LIQUIDITY_PUBLISHED_ROW_FILTER =
  "(publication_generation_id IS NULL OR publication_generation_id IN (SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'))";

export type DexLiquidityDbMap = Record<string, DexLiquiditySnapshot>;

export interface DexLiquidityLoadResult {
  map: DexLiquidityDbMap;
  latestUpdatedAt: number | null;
}

export async function loadDexLiquiditySnapshot(
  db: D1Database,
): Promise<DexLiquidityLoadResult> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count, updated_at
       FROM dex_liquidity
       WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .all<DexLiquidityRow>();

  const map: DexLiquidityDbMap = {};
  let latestUpdatedAt: number | null = null;
  for (const row of rows.results ?? []) {
    map[row.stablecoin_id] = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
    };
    if (
      row.updated_at != null &&
      (latestUpdatedAt == null || row.updated_at > latestUpdatedAt)
    ) {
      latestUpdatedAt = row.updated_at;
    }
  }

  return { map, latestUpdatedAt };
}

export async function loadDexLiquidityMap(
  db: D1Database,
): Promise<DexLiquidityDbMap> {
  const { map } = await loadDexLiquiditySnapshot(db);
  return map;
}
