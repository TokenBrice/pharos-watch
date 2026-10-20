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

  it("keeps deferred and failed reserve reads distinct", () => {
    expect(featureStates({ supplemental: { reserves: { enabled: false, isLoading: true } } }).reserves.status).toBe("deferred");
    expect(featureStates({ supplemental: { reserves: { enabled: true, error: new Error("offline") } } }).reserves.status).toBe("unavailable");
    const live = { mode: "live" as const, reserves: [], estimated: false };
    expect(featureStates({ supplemental: { reserves: { live, isLoading: true, error: new Error("offline") } } }).reserves.status).toBe("stale-with-data");
  });

  it.each([
    [{ enabled: false, isLoading: true, error: new Error("offline") }, "deferred"],
    [{ isLoading: true }, "loading"],
    [{ isLoading: false }, "loading"],
    [{ error: new Error("offline") }, "unavailable"],
    [{ data: { coins: {} } }, "empty"],
    [{ data: { coins: {} }, error: new Error("offline") }, "unavailable"],
    [{ data: { coins: { "usdt-tether": {} } }, error: new Error("offline") }, "retained"],
    [{ data: { coins: { "usdt-tether": {} } } }, "ready"],
  ] as const)("distinguishes redemption evidence read %s as %s", (query, status) => {
    const states = featureStates({ queries: { redemptionBackstops: query as never } });
    expect(states.redemption.status).toBe(status);
  });
});
