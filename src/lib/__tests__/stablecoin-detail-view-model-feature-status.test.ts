import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";
import { buildDetailFeatureSnapshot } from "../stablecoin-detail-query-view-model";

type BuildStablecoinDetailViewModelParams = Parameters<typeof buildStablecoinDetailViewModel>[0];

type BuildStablecoinDetailViewModelOverrides = {
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

function makeBuildStablecoinDetailViewModelParams(
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

describe("detail feature-status ladders", () => {
  const coin = TRACKED_META_BY_ID.get("usdt-tether")!;

  function featureStates(
    overrides: BuildStablecoinDetailViewModelOverrides,
  ): ReturnType<typeof buildDetailFeatureSnapshot>["states"] {
    const params = makeBuildStablecoinDetailViewModelParams({ ...overrides, core: { coin, ...overrides.core } });
    return buildDetailFeatureSnapshot(coin.id, coin, params.queries, params.supplemental).states;
  }

  it("gates deferred queries above every transport state", () => {
    const states = featureStates({
      supplemental: {
        flows: { enabled: false, isLoading: true, error: new Error("offline") },
        blacklist: { enabled: false, isLoading: true, error: new Error("offline") },
        reserves: { enabled: false, isLoading: true, error: new Error("offline") },
      },
    });

    expect(states.flows.status).toBe("deferred");
    expect(states.blacklist.status).toBe("deferred");
    expect(states.reserves.status).toBe("deferred");
  });

  it("keeps error-with-data above loading", () => {
    const error = new Error("offline");
    const states = featureStates({
      supplemental: {
        flows: { data: { coins: [] } as never, isLoading: true, error },
        blacklist: { summary: { stats: { perCoinTotalEvents: {} } } as never, isLoading: true, error },
      },
    });

    expect(states.flows.status).toBe("stale-with-data");
    expect(states.blacklist.status).toBe("stale-with-data");
  });

  it("reads an answered-but-rowless yield or flows lane as non-applicable, blacklist as empty", () => {
    expect(coin.flags.yieldBearing).toBe(false);
    const states = featureStates({
      supplemental: {
        yieldRankingsData: { rankings: [] } as never,
        flows: { data: { coins: [] } as never },
        blacklist: { summary: { stats: { perCoinTotalEvents: {} } } as never },
      },
    });

    expect(states.yield.status).toBe("unsupported");
    expect(states.flows.status).toBe("unsupported");
    expect(states.blacklist.status).toBe("empty");
  });

  it("marks an unsupported subject before consulting the query at all", () => {
    const navCoin = { ...coin, flags: { ...coin.flags, navToken: true } };
    const params = makeBuildStablecoinDetailViewModelParams({
      core: { coin: navCoin },
      supplemental: { stressSignals: { isLoading: true } },
    });

    const states = buildDetailFeatureSnapshot(navCoin.id, navCoin, params.queries, params.supplemental).states;
    expect(states.stress.status).toBe("unsupported");
  });
});

