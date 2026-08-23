import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailViewModel } from "@/lib/stablecoin-detail-view-model";

type BuildStablecoinDetailViewModelParams = Parameters<typeof buildStablecoinDetailViewModel>[0];

export type BuildStablecoinDetailViewModelOverrides = {
  core?: Partial<BuildStablecoinDetailViewModelParams["core"]>;
  queries?: {
    supplyHistory?: Partial<BuildStablecoinDetailViewModelParams["queries"]["supplyHistory"]>;
    stablecoinList?: Partial<BuildStablecoinDetailViewModelParams["queries"]["stablecoinList"]>;
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
        ...overrides.queries?.supplyHistory,
      },
      stablecoinList: {
        data: { peggedAssets: [] } as never,
        isLoading: false,
        isError: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.queries?.stablecoinList,
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
