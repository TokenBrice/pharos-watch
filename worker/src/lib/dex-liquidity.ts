import type { DexLiquidityData } from "@shared/types/market";
import { classifyLiquidityEvidence } from "@shared/lib/dex-liquidity-evidence";
import type { LiquidityCoverageClass } from "@shared/types/market";

interface DexLiquidityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  pool_count: number;
  chain_count: number;
  total_tvl_usd: number;
  effective_tvl_usd: number | null;
  coverage_class: string | null;
  coverage_confidence: number | null;
  balance_measured_tvl_usd: number | null;
  organic_measured_tvl_usd: number | null;
  deployment_total: number;
  deployment_observed_pools: number;
  deployment_verified_no_pools: number;
  deployment_provider_inaccessible: number;
  updated_at: number | null;
}

type DexLiquiditySnapshot = Pick<
  DexLiquidityData,
  "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"
> &
  Partial<
    Pick<
      DexLiquidityData,
      | "effectiveTvlUsd"
      | "coverageClass"
      | "coverageConfidence"
      | "liquidityEvidenceClass"
      | "hasMeasuredLiquidityEvidence"
      | "balanceMeasuredTvlUsd"
      | "organicMeasuredTvlUsd"
    >
  > & {
    deploymentCoverage?: {
      observedPools: number;
      verifiedNoPools: number;
      providerInaccessible: number;
    } | null;
  };

export const DEX_LIQUIDITY_PUBLISHED_ROW_FILTER =
  "(publication_generation_id IS NULL OR publication_generation_id IN (SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'))";

export type DexLiquidityDbMap = Record<string, DexLiquiditySnapshot>;

export interface DexLiquidityLoadResult {
  map: DexLiquidityDbMap;
  latestUpdatedAt: number | null;
}

function parseCoverageClass(value: string | null): LiquidityCoverageClass | null {
  switch (value) {
    case "primary":
    case "mixed":
    case "fallback":
    case "legacy":
    case "unobserved":
      return value;
    default:
      return null;
  }
}

export async function loadDexLiquiditySnapshot(
  db: D1Database,
): Promise<DexLiquidityLoadResult> {
  const rows = await db
    .prepare(
      `SELECT dl.stablecoin_id, dl.liquidity_score, dl.concentration_hhi,
              dl.pool_count, dl.chain_count, dl.total_tvl_usd, dl.effective_tvl_usd,
              dl.coverage_class, dl.coverage_confidence, dl.balance_measured_tvl_usd,
              dl.organic_measured_tvl_usd, dl.updated_at,
              COALESCE(dc.deployment_total, 0) AS deployment_total,
              COALESCE(dc.observed_pools, 0) AS deployment_observed_pools,
              COALESCE(dc.verified_no_pools, 0) AS deployment_verified_no_pools,
              COALESCE(dc.provider_inaccessible, 0) AS deployment_provider_inaccessible
       FROM dex_liquidity dl
       LEFT JOIN (
         SELECT stablecoin_id,
                COUNT(*) AS deployment_total,
                SUM(CASE WHEN outcome = 'observed_pools' THEN 1 ELSE 0 END) AS observed_pools,
                SUM(CASE WHEN outcome = 'verified_no_pools' THEN 1 ELSE 0 END) AS verified_no_pools,
                SUM(CASE WHEN outcome = 'provider_inaccessible' THEN 1 ELSE 0 END) AS provider_inaccessible
         FROM dex_deployment_outcomes
         GROUP BY stablecoin_id
       ) dc ON dc.stablecoin_id = dl.stablecoin_id
       WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER.replaceAll("publication_generation_id", "dl.publication_generation_id")}`,
    )
    .all<DexLiquidityRow>();

  const map: DexLiquidityDbMap = {};
  let latestUpdatedAt: number | null = null;
  for (const row of rows.results ?? []) {
    const coverageClass = parseCoverageClass(row.coverage_class);
    const hasRepublishedEvidence = coverageClass != null && row.coverage_confidence != null;
    const evidence = hasRepublishedEvidence
      ? classifyLiquidityEvidence(row.total_tvl_usd, coverageClass, row.coverage_confidence)
      : null;
    const snapshot: DexLiquiditySnapshot = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
    };
    if (hasRepublishedEvidence && evidence != null) {
      snapshot.coverageClass = coverageClass;
      snapshot.coverageConfidence = row.coverage_confidence!;
      snapshot.liquidityEvidenceClass = evidence.liquidityEvidenceClass;
      snapshot.hasMeasuredLiquidityEvidence = evidence.hasMeasuredLiquidityEvidence;
      snapshot.effectiveTvlUsd = row.effective_tvl_usd ?? 0;
      snapshot.balanceMeasuredTvlUsd = row.balance_measured_tvl_usd ?? 0;
      snapshot.organicMeasuredTvlUsd = row.organic_measured_tvl_usd ?? 0;
    }
    if (row.deployment_total > 0) {
      snapshot.deploymentCoverage = {
        observedPools: row.deployment_observed_pools,
        verifiedNoPools: row.deployment_verified_no_pools,
        providerInaccessible: row.deployment_provider_inaccessible,
      };
    }
    map[row.stablecoin_id] = snapshot;
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
