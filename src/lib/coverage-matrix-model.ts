import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import type {
  DexLiquidityMap,
  MintBurnFlowsResponse,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StablecoinMeta,
  YieldRankingsResponse,
} from "@shared/types";
import type { ApiMeta } from "@/lib/api";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
  type CoverageFeatureKey,
} from "@/lib/coverage";
import { buildDependencyCoverageFacts } from "@/lib/dependency-coverage-facts";

const FEATURE_QUERY_AVAILABLE_KEYS = [
  "price",
  "safety",
  "dex",
  "redemption",
  "yield",
  "flows",
  "dependency",
] as const satisfies readonly CoverageFeatureKey[];

export const COVERAGE_MATRIX_QUERY_KEYS = [
  "stablecoins",
  "pegSummary",
  "dexLiquidity",
  "redemptionBackstops",
  "yieldRankings",
  "mintBurnFlows",
  "reportCards",
] as const;

export type CoverageMatrixQueryKey = (typeof COVERAGE_MATRIX_QUERY_KEYS)[number];

interface CoverageMatrixQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface CoverageMatrixModelInput {
  stablecoins: CoverageMatrixQueryResource<StablecoinListResponse>;
  pegSummary: CoverageMatrixQueryResource<PegSummaryResponse>;
  dexLiquidity: CoverageMatrixQueryResource<DexLiquidityMap>;
  redemptionBackstops: CoverageMatrixQueryResource<RedemptionBackstopsResponse>;
  yieldRankings: CoverageMatrixQueryResource<YieldRankingsResponse>;
  mintBurnFlows: CoverageMatrixQueryResource<MintBurnFlowsResponse>;
  reportCards: CoverageMatrixQueryResource<ReportCardsResponse>;
  activeStablecoins?: readonly StablecoinClientMeta[];
}

const COVERAGE_FEATURE_QUERY_KEYS = {
  price: "pegSummary",
  safety: "reportCards",
  dex: "dexLiquidity",
  reserves: "reportCards",
  redemption: "redemptionBackstops",
  yield: "yieldRankings",
  flows: "mintBurnFlows",
  blacklist: null,
  dependency: "reportCards",
  mintAuthority: null,
} as const satisfies Record<CoverageFeatureKey, CoverageMatrixQueryKey | null>;

function getCoverageMatrixQueries(input: CoverageMatrixModelInput) {
  return COVERAGE_MATRIX_QUERY_KEYS.map((key) => input[key]);
}

function buildQueryAvailability(input: CoverageMatrixModelInput): Record<CoverageFeatureKey, boolean> {
  return Object.fromEntries(
    COVERAGE_FEATURES.map((feature) => {
      const queryKey = COVERAGE_FEATURE_QUERY_KEYS[feature.key];
      return [feature.key, queryKey === null || input[queryKey].data !== undefined];
    }),
  ) as Record<CoverageFeatureKey, boolean>;
}

function buildPricingSourceCounts(pegSummaryData: PegSummaryResponse | undefined) {
  const consensusMap = new Map<string, number>();
  const authMap = new Map<string, number>();

  for (const coin of pegSummaryData?.coins ?? []) {
    for (const src of coin.consensusSources ?? []) {
      const target = isPricingSourceProtocolOverride(src) ? authMap : consensusMap;
      target.set(src, (target.get(src) ?? 0) + 1);
    }
  }

  const toSorted = (map: Map<string, number>) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    pricingSources: toSorted(consensusMap),
    authoritativeSources: toSorted(authMap),
  };
}

export function buildCoverageMatrixModel(input: CoverageMatrixModelInput) {
  const activeStablecoins = input.activeStablecoins ?? ACTIVE_STABLECOINS;
  const coverageQueries = getCoverageMatrixQueries(input);
  const queryAvailability = buildQueryAvailability(input);
  const assetById = new Map((input.stablecoins.data?.peggedAssets ?? []).map((asset) => [asset.id, asset]));
  const pegIds = new Set((input.pegSummary.data?.coins ?? []).map((coin) => coin.id));
  const pegCoinById = new Map((input.pegSummary.data?.coins ?? []).map((coin) => [coin.id, coin]));
  const yieldIds = new Set((input.yieldRankings.data?.rankings ?? []).map((row) => row.id));
  const flowById = new Map((input.mintBurnFlows.data?.coins ?? []).map((row) => [row.stablecoinId, row]));
  const reportCardById = new Map((input.reportCards.data?.cards ?? []).map((card) => [card.id, card]));
  const dependencyFacts = input.reportCards.data
    ? buildDependencyCoverageFacts(activeStablecoins as StablecoinMeta[], input.reportCards.data)
    : new Map();

  const rows = activeStablecoins.map((coin) => {
    const pegCoin = pegCoinById.get(coin.id);
    const asset = assetById.get(coin.id);
    const reportCard = reportCardById.get(coin.id);
    const mcap = asset ? getCirculatingRaw(asset) : 0;
    return buildCoverageRow({
      coin: coin as StablecoinMeta & Pick<StablecoinClientMeta, "mintAuthoritySummary">,
      marketCapUsd: mcap,
      hasPegCoverage: pegIds.has(coin.id),
      consensusSources: pegCoin?.consensusSources,
      priceConfidence: pegCoin?.priceConfidence ?? undefined,
      safetyScore: reportCard?.overallScore ?? null,
      dexCoverageClass: input.dexLiquidity.data?.[coin.id]?.coverageClass ?? null,
      redemptionEntry: input.redemptionBackstops.data?.coins?.[coin.id] ?? null,
      hasYieldCoverage: yieldIds.has(coin.id),
      flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
      dependencyCoverage: dependencyFacts.get(coin.id) ?? null,
      blacklistStatus: getResolvedBlacklistStatus(coin.id, reportCard),
      liveReserveFresh: queryAvailability.reserves ? (reportCard?.rawInputs.collateralFromLive ?? false) : null,
      dataAvailability: queryAvailability,
    });
  });

  const totalMcapUsd = rows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const featureSummaries = COVERAGE_FEATURES.map((feature) => buildCoverageFeatureSummary(feature, rows, totalMcapUsd));

  let atTargetCount = 0;
  let exactTwoCount = 0;
  let belowTargetCount = 0;
  let atTargetMcapUsd = 0;
  let exactTwoMcapUsd = 0;

  for (const row of rows) {
    const sourceCount = row.statuses.price.sourceCount ?? 0;
    if (sourceCount >= 3) {
      atTargetCount++;
      atTargetMcapUsd += row.marketCapUsd;
    } else {
      belowTargetCount++;
      if (sourceCount === 2) {
        exactTwoCount++;
        exactTwoMcapUsd += row.marketCapUsd;
      }
    }
  }

  const totalCount = rows.length;
  const sourceDepthProgress = {
    totalCount,
    atTargetCount,
    exactTwoCount,
    belowTargetCount,
    atTargetPct: totalCount > 0 ? (atTargetCount / totalCount) * 100 : 0,
    atTargetMcapPct: totalMcapUsd > 0 ? (atTargetMcapUsd / totalMcapUsd) * 100 : null,
    exactTwoMcapPct: totalMcapUsd > 0 ? (exactTwoMcapUsd / totalMcapUsd) * 100 : null,
  };

  const { pricingSources, authoritativeSources } = buildPricingSourceCounts(input.pegSummary.data);
  const widestFeature =
    [...featureSummaries].sort((left, right) => {
      if (right.coveragePct !== left.coveragePct) {
        return right.coveragePct - left.coveragePct;
      }
      return (right.mcapSharePct ?? 0) - (left.mcapSharePct ?? 0);
    })[0] ?? null;
  const narrowestFeature =
    [...featureSummaries].sort((left, right) => {
      if (left.coveragePct !== right.coveragePct) {
        return left.coveragePct - right.coveragePct;
      }
      return (left.mcapSharePct ?? 0) - (right.mcapSharePct ?? 0);
    })[0] ?? null;
  const mostConcentratedFeature =
    [...featureSummaries].sort(
      (left, right) => (right.mcapSharePct ?? 0) - right.coveragePct - ((left.mcapSharePct ?? 0) - left.coveragePct),
    )[0] ?? null;

  const isStablecoinDataUnavailable = input.stablecoins.data === undefined && !!input.stablecoins.error;
  const isInitialDataLoading = coverageQueries.some((query) => query.data === undefined && !query.error);
  const unavailableFeatures = FEATURE_QUERY_AVAILABLE_KEYS.filter((key) => !queryAvailability[key]);

  const dataUpdatedAt = Math.max(...coverageQueries.map((query) => query.dataUpdatedAt ?? 0));

  return {
    rows,
    featureSummaries,
    sourceDepthProgress,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    dataUpdatedAt: dataUpdatedAt > 0 ? dataUpdatedAt : undefined,
    staleQueries: COVERAGE_MATRIX_QUERY_KEYS.map((preset) => {
      const query = input[preset];
      return {
        preset,
        dataUpdatedAt: query.dataUpdatedAt,
        error: query.error,
        hasData: query.data !== undefined,
        meta: query.meta,
      };
    }),
  };
}

export type CoverageMatrixModel = ReturnType<typeof buildCoverageMatrixModel>;
