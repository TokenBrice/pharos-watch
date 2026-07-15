import { describe, expect, it } from "vitest";
import { resolvedExitRouteOutputAssetKeys } from "../exit-route-output";

describe("resolvedExitRouteOutputAssetKeys", () => {
  it("treats a tracked token address as provenance for its canonical stablecoin id", () => {
    expect(
      resolvedExitRouteOutputAssetKeys({
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdf-falcon"],
        assetKeys: ["ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2"],
      }),
    ).toEqual(["usdf-falcon"]);
    expect(
      resolvedExitRouteOutputAssetKeys({
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdc-circle"],
        assetKeys: ["solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      }),
    ).toEqual(["usdc-circle"]);
  });
});
