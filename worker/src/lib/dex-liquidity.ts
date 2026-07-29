import {
  DexExitRouteObservationSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  ExitRouteObservationCoverageSchema,
  type DexLiquidityData,
  type LiquidityCoverageClass,
} from "@shared/types/market";
import { classifyLiquidityEvidence } from "@shared/lib/dex-liquidity-evidence";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isMissingTableError } from "./db";
import { parseJsonObject } from "./json-parse";

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
  score_components_json: string | null;
  methodology_version: string | null;
  deployment_chain: string | null;
  deployment_contract_address: string | null;
  deployment_outcome: "observed_pools" | "verified_no_pools" | "provider_inaccessible" | null;
  updated_at: number | null;
}

type DexLiquiditySnapshot = Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> &
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
      | "exitRouteObservations"
      | "exitRouteObservationCoverage"
      | "methodologyVersion"
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

type DeploymentCoverage = NonNullable<DexLiquiditySnapshot["deploymentCoverage"]>;

export function deploymentKey(stablecoinId: string, chain: string, address: string): string {
  return `${stablecoinId}\u0000${canonicalExitRouteAssetKey(chain, address)}`;
}

export const CURRENT_DEPLOYMENT_KEYS = new Set(
  ACTIVE_STABLECOINS.flatMap((meta) =>
    [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])].map((deployment) =>
      deploymentKey(meta.id, deployment.chain, deployment.address),
    ),
  ),
);

function parseCoverageClass(value: string | null, stablecoinId: string): LiquidityCoverageClass | null {
  if (value === null) return null;
  switch (value) {
    case "primary":
    case "mixed":
    case "fallback":
    case "legacy":
    case "unobserved":
      return value;
    default:
      throw new Error(`Invalid dex_liquidity coverage_class for ${stablecoinId}: ${value}`);
  }
}

function parseCoverageConfidence(value: number | null, stablecoinId: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid dex_liquidity coverage_confidence for ${stablecoinId}: ${value}`);
  }
  return value;
}

function parseExitRouteDetails(
  json: string | null,
  stablecoinId: string,
): Pick<DexLiquiditySnapshot, "exitRouteObservations" | "exitRouteObservationCoverage"> {
  const raw = parseJsonObject(json);
  if (raw == null) return {};
  const observations =
    raw.exitRouteObservations === undefined
      ? null
      : DexExitRouteObservationSchema.array()
          .max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS)
          .safeParse(raw.exitRouteObservations);
  const coverage =
    raw.exitRouteObservationCoverage === undefined
      ? null
      : ExitRouteObservationCoverageSchema.safeParse(raw.exitRouteObservationCoverage);
  if (observations && !observations.success) {
    throw new Error(`Invalid persisted DEX exit-route observations for ${stablecoinId}`);
  }
  if (coverage && !coverage.success) {
    throw new Error(`Invalid persisted DEX exit-route coverage for ${stablecoinId}`);
  }
  if (observations?.success && coverage?.success) {
    const eligibleObservationCount = observations.data.filter((observation) => observation.scoreEligible).length;
    if (
      coverage.data.observationCount !== observations.data.length ||
      coverage.data.scoreEligibleObservationCount !== eligibleObservationCount
    ) {
      throw new Error(`Persisted DEX exit-route coverage counts do not match observations for ${stablecoinId}`);
    }
  }
  return {
    ...(observations?.success ? { exitRouteObservations: observations.data } : {}),
    ...(coverage?.success ? { exitRouteObservationCoverage: coverage.data } : {}),
  };
}

async function loadDexLiquidityRows(db: D1Database): Promise<DexLiquidityRow[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT dl.stablecoin_id, dl.liquidity_score, dl.concentration_hhi,
                dl.pool_count, dl.chain_count, dl.total_tvl_usd, dl.effective_tvl_usd,
                dl.coverage_class, dl.coverage_confidence, dl.balance_measured_tvl_usd,
                dl.organic_measured_tvl_usd, dl.score_components_json, dl.methodology_version, dl.updated_at,
                dco.chain AS deployment_chain,
                dco.contract_address AS deployment_contract_address,
                dco.outcome AS deployment_outcome
         FROM dex_liquidity dl
         LEFT JOIN dex_deployment_outcomes dco ON dco.stablecoin_id = dl.stablecoin_id
         WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER.replaceAll("publication_generation_id", "dl.publication_generation_id")}`,
      )
      .all<DexLiquidityRow>();
    return rows.results ?? [];
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    const rows = await db
      .prepare(
        `SELECT dl.stablecoin_id, dl.liquidity_score, dl.concentration_hhi,
                dl.pool_count, dl.chain_count, dl.total_tvl_usd, dl.effective_tvl_usd,
                dl.coverage_class, dl.coverage_confidence, dl.balance_measured_tvl_usd,
                dl.organic_measured_tvl_usd, dl.score_components_json, dl.methodology_version, dl.updated_at,
                NULL AS deployment_chain,
                NULL AS deployment_contract_address,
                NULL AS deployment_outcome
         FROM dex_liquidity dl
         WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER.replaceAll("publication_generation_id", "dl.publication_generation_id")}`,
      )
      .all<DexLiquidityRow>();
    return rows.results ?? [];
  }
}

export async function loadDexLiquiditySnapshot(db: D1Database): Promise<DexLiquidityLoadResult> {
  const rows = await loadDexLiquidityRows(db);

  const map: DexLiquidityDbMap = {};
  const processedStablecoinIds = new Set<string>();
  const deploymentCoverageById = new Map<string, DeploymentCoverage>();
  let latestUpdatedAt: number | null = null;
  for (const row of rows) {
    if (
      row.deployment_chain != null &&
      row.deployment_contract_address != null &&
      row.deployment_outcome != null &&
      CURRENT_DEPLOYMENT_KEYS.has(
        deploymentKey(row.stablecoin_id, row.deployment_chain, row.deployment_contract_address),
      )
    ) {
      const coverage = deploymentCoverageById.get(row.stablecoin_id) ?? {
        observedPools: 0,
        verifiedNoPools: 0,
        providerInaccessible: 0,
      };
      if (row.deployment_outcome === "observed_pools") coverage.observedPools += 1;
      else if (row.deployment_outcome === "verified_no_pools") coverage.verifiedNoPools += 1;
      else coverage.providerInaccessible += 1;
      deploymentCoverageById.set(row.stablecoin_id, coverage);
    }

    if (processedStablecoinIds.has(row.stablecoin_id)) continue;
    processedStablecoinIds.add(row.stablecoin_id);
    let coverageClass: LiquidityCoverageClass | null;
    let coverageConfidence: number | null;
    try {
      coverageClass = parseCoverageClass(row.coverage_class, row.stablecoin_id);
      coverageConfidence = parseCoverageConfidence(row.coverage_confidence, row.stablecoin_id);
      if ((coverageClass === null) !== (coverageConfidence === null)) {
        throw new Error(`Incomplete dex_liquidity coverage evidence for ${row.stablecoin_id}`);
      }
    } catch (error) {
      console.error(`[dex-liquidity] Quarantining malformed evidence row for ${row.stablecoin_id}:`, error);
      continue;
    }
    const evidence =
      coverageClass != null && coverageConfidence != null
        ? classifyLiquidityEvidence(row.total_tvl_usd, coverageClass, coverageConfidence)
        : null;
    const snapshot: DexLiquiditySnapshot = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
      ...parseExitRouteDetails(row.score_components_json, row.stablecoin_id),
    };
    if (typeof row.methodology_version === "string" && row.methodology_version.trim()) {
      snapshot.methodologyVersion = row.methodology_version.trim();
    }
    if (coverageClass != null && coverageConfidence != null && evidence != null) {
      snapshot.coverageClass = coverageClass;
      snapshot.coverageConfidence = coverageConfidence;
      snapshot.liquidityEvidenceClass = evidence.liquidityEvidenceClass;
      snapshot.hasMeasuredLiquidityEvidence = evidence.hasMeasuredLiquidityEvidence;
      snapshot.effectiveTvlUsd = row.effective_tvl_usd ?? 0;
      snapshot.balanceMeasuredTvlUsd = row.balance_measured_tvl_usd ?? 0;
      snapshot.organicMeasuredTvlUsd = row.organic_measured_tvl_usd ?? 0;
    }
    map[row.stablecoin_id] = snapshot;
    if (row.updated_at != null && (latestUpdatedAt == null || row.updated_at > latestUpdatedAt)) {
      latestUpdatedAt = row.updated_at;
    }
  }

  for (const [stablecoinId, deploymentCoverage] of deploymentCoverageById) {
    if (map[stablecoinId]) map[stablecoinId].deploymentCoverage = deploymentCoverage;
  }

  return { map, latestUpdatedAt };
}

export async function loadDexLiquidityMap(db: D1Database): Promise<DexLiquidityDbMap> {
  const { map } = await loadDexLiquiditySnapshot(db);
  return map;
}
