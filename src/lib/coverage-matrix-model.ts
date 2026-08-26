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
  ReportCardsV9CurrentResponse,
  StablecoinListResponse,
  YieldRankingsResponse,
} from "@shared/types";
import type { ApiMeta } from "@/lib/api";
import { readV9CardMintComponent } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
  type CoverageFeatureKey,
  type CoverageFeatureSummary,
} from "@/lib/coverage";
import { buildV9DependencyCoverageFacts } from "@/lib/dependency-coverage-facts";

/**
 * Features whose whole cell becomes "Data n/a" when their query is missing, and
 * which the matrix therefore names in its unavailable-feeds notice.
 *
 * `mintAuthority` is deliberately absent even though it is query-backed: only
 * its score dimension degrades, while the curated route bucket stays true and
 * keeps rendering. Naming it here would tell the reader the mint cells are Data
 * n/a when they are not.
 */
const FEATURE_QUERY_AVAILABLE_KEYS = [
  "price",
  "safety",
  "dex",
  "redemption",
  "yield",
  "flows",
  "dependency",
] as const satisfies readonly CoverageFeatureKey[];

const COVERAGE_MATRIX_QUERY_KEYS = [
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
  reportCards: CoverageMatrixQueryResource<ReportCardsV9CurrentResponse>;
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
  mica: null,
  genius: null,
  dependency: "reportCards",
  // Half query-backed since safety 9.1: the curated route bucket needs no query,
  // but the score and band are read from the published V9 mint component. It was
  // left as `null` when the mint data moved, so a failed or blanked report-cards
  // fetch silently rendered every mint score as unrated.
  mintAuthority: "reportCards",
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
    ? buildV9DependencyCoverageFacts(activeStablecoins, input.reportCards.data)
    : new Map();

  const rows = activeStablecoins.map((coin) => {
    const pegCoin = pegCoinById.get(coin.id);
    const asset = assetById.get(coin.id);
    const reportCard = reportCardById.get(coin.id);
    const mcap = asset ? getCirculatingRaw(asset) : 0;
    return buildCoverageRow({
      coin,
      marketCapUsd: mcap,
      hasPegCoverage: pegIds.has(coin.id),
      consensusSources: pegCoin?.consensusSources,
      priceConfidence: pegCoin?.priceConfidence ?? undefined,
      safetyScore: reportCard?.score ?? null,
      dexCoverageClass: input.dexLiquidity.data?.[coin.id]?.coverageClass ?? null,
      redemptionEntry: input.redemptionBackstops.data?.coins?.[coin.id] ?? null,
      hasYieldCoverage: yieldIds.has(coin.id),
      flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
      dependencyCoverage: dependencyFacts.get(coin.id) ?? null,
      blacklistStatus: getResolvedBlacklistStatus(coin.id),
      publishedMint: reportCard ? readV9CardMintComponent(reportCard) : null,
      liveReserveFresh: reportCard?.backingFromLiveReserves ?? null,
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
  // Single O(n) pass tracking three extremes; ties resolve to the earliest
  // element, matching the prior stable-sort-then-[0] behavior.
  const featureExtremes = featureSummaries.reduce<{
    widest: CoverageFeatureSummary | null;
    narrowest: CoverageFeatureSummary | null;
    mostConcentrated: CoverageFeatureSummary | null;
  }>(
    (acc, summary) => {
      const mcapShare = summary.mcapSharePct ?? 0;
      const concentration = mcapShare - summary.coveragePct;
      if (
        acc.widest === null ||
        summary.coveragePct > acc.widest.coveragePct ||
        (summary.coveragePct === acc.widest.coveragePct && mcapShare > (acc.widest.mcapSharePct ?? 0))
      ) {
        acc.widest = summary;
      }
      if (
        acc.narrowest === null ||
        summary.coveragePct < acc.narrowest.coveragePct ||
        (summary.coveragePct === acc.narrowest.coveragePct && mcapShare < (acc.narrowest.mcapSharePct ?? 0))
      ) {
        acc.narrowest = summary;
      }
      if (
        acc.mostConcentrated === null ||
        concentration > (acc.mostConcentrated.mcapSharePct ?? 0) - acc.mostConcentrated.coveragePct
      ) {
        acc.mostConcentrated = summary;
      }
      return acc;
    },
    { widest: null, narrowest: null, mostConcentrated: null },
  );
  const widestFeature = featureExtremes.widest;
  const narrowestFeature = featureExtremes.narrowest;
  const mostConcentratedFeature = featureExtremes.mostConcentrated;

  const isStablecoinDataUnavailable = input.stablecoins.data === undefined && !!input.stablecoins.error;
  const isInitialDataLoading = coverageQueries.some((query) => query.data === undefined && !query.error);
  const unavailableFeatures = FEATURE_QUERY_AVAILABLE_KEYS.filter((key) => !queryAvailability[key]);

  const dataUpdatedAt = Math.max(...coverageQueries.map((query) => query.dataUpdatedAt ?? 0));

  return {
    rows,
    safetyScoreResponse: input.reportCards.data,
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

type CoverageMatrixModel = ReturnType<typeof buildCoverageMatrixModel>;
