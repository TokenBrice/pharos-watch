import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { NativeSupplyCheckpoints, StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { buildStablecoinDetailViewModel } from "@/lib/stablecoin-detail-view-model";

type BuildStablecoinDetailViewModelParams = Parameters<typeof buildStablecoinDetailViewModel>[0];

export type BuildStablecoinDetailViewModelOverrides = {
  core?: Partial<BuildStablecoinDetailViewModelParams["core"]>;
  queries?: {
    supplyHistory?: Partial<BuildStablecoinDetailViewModelParams["queries"]["supplyHistory"]>;
    liveSummary?: Partial<BuildStablecoinDetailViewModelParams["queries"]["liveSummary"]>;
    pegSummary?: Partial<BuildStablecoinDetailViewModelParams["queries"]["pegSummary"]>;
    dexLiquidity?: Partial<BuildStablecoinDetailViewModelParams["queries"]["dexLiquidity"]>;
    reportCards?: Partial<BuildStablecoinDetailViewModelParams["queries"]["reportCards"]>;
    redemptionBackstops?: Partial<BuildStablecoinDetailViewModelParams["queries"]["redemptionBackstops"]>;
  };
  supplemental?: {
    yieldRankingsData?: BuildStablecoinDetailViewModelParams["supplemental"]["yieldRankings"]["data"];
    stressSignalsData?: BuildStablecoinDetailViewModelParams["supplemental"]["stressSignals"]["data"];
    yieldRankings?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["yieldRankings"]>;
    stressSignals?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["stressSignals"]>;
    flows?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["flows"]>;
    blacklist?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["blacklist"]>;
    reserves?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["reserves"]>;
    nowMs?: number;
  };
};

export type ReadyDetailParamsOverrides = {
  id: string;
  coin: BuildStablecoinDetailViewModelParams["core"]["coin"];
  asset?: Partial<StablecoinLiveSummary>;
  nativeSupply?: NativeSupplyCheckpoints;
  queries?: BuildStablecoinDetailViewModelOverrides["queries"];
  supplemental?: BuildStablecoinDetailViewModelOverrides["supplemental"];
};

export function makeBuildStablecoinDetailViewModelParams(
  overrides: BuildStablecoinDetailViewModelOverrides,
): BuildStablecoinDetailViewModelParams {
  const coin = overrides.core?.coin ?? TRACKED_META_BY_ID.get("usdt-tether")!;
  const id = overrides.core?.id ?? coin.id;

  return {
    core: {
      id,
      coin,
      summary: null,
      handleRetryAll: () => {},
      ...overrides.core,
    },
    queries: {
      supplyHistory: {
        data: [],
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.queries?.supplyHistory,
      },
      liveSummary: {
        data: undefined,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.queries?.liveSummary,
      },
      pegSummary: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.pegSummary,
      },
      dexLiquidity: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.dexLiquidity,
      },
      reportCards: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.reportCards,
      },
      redemptionBackstops: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.redemptionBackstops,
      },
    },
    supplemental: {
      flows: {
        data: undefined,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        enabled: true,
        ...overrides.supplemental?.flows,
      },
      blacklist: {
        summary: undefined,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        enabled: true,
        ...overrides.supplemental?.blacklist,
      },
      reserves: {
        live: null,
        error: null,
        dataUpdatedAt: 0,
        isLoading: false,
        enabled: true,
        ...overrides.supplemental?.reserves,
      },
      yieldRankings: {
        data: overrides.supplemental?.yieldRankingsData,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.supplemental?.yieldRankings,
      },
      stressSignals: {
        data: overrides.supplemental?.stressSignalsData,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.supplemental?.stressSignals,
      },
      nowMs: overrides.supplemental?.nowMs,
    },
  };
}

export function makeReadyDetailParams({
  id,
  coin,
  asset,
  nativeSupply,
  queries,
  supplemental,
}: ReadyDetailParamsOverrides): BuildStablecoinDetailViewModelParams {
  const readySummary: StablecoinLiveSummary = {
    price: 1, priceSource: "coingecko", priceConfidence: "single-source",
    priceUpdatedAt: null, priceObservedAt: null, supplyObservedAt: null,
    circulating: { peggedUSD: 100 },
    circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
    nativeSupply: nativeSupply ?? { current: null, prevWeek: null, prevMonth: null },
    ...asset,
  };

  return makeBuildStablecoinDetailViewModelParams({
    core: { id, coin },
    queries: {
      ...queries,
      supplyHistory: {
        data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }],
        ...queries?.supplyHistory,
      },
      liveSummary: {
        data: readySummary,
        dataUpdatedAt: 1,
        ...queries?.liveSummary,
      },
    },
    supplemental,
  });
}
