import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildDetailFeatureSnapshot } from "../stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "./fixtures/stablecoin-detail-view-model";


type BuildStablecoinDetailViewModelOverrides = Parameters<typeof makeBuildStablecoinDetailViewModelParams>[0];

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
