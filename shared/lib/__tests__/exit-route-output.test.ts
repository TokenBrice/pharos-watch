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
  it("includes fiat currency alongside explicit basket keys", () => {
    expect(resolvedExitRouteOutputAssetKeys({ kind: "fiat", currency: "USD", assetKeys: ["fiat:EUR"] }))
      .toEqual(["fiat:EUR", "fiat:USD"]);
  });

  it("uses explicit keys when collateral or tracked outputs have no tracked identity", () => {
    expect(resolvedExitRouteOutputAssetKeys({ kind: "collateral", assetKeys: ["ethereum:weth"] })).toEqual(["ethereum:weth"]);
    expect(resolvedExitRouteOutputAssetKeys({ kind: "tracked-stablecoin", trackedAssetIds: [], assetKeys: ["solana:mint"] }))
      .toEqual(["solana:mint"]);
  });

  it("rejects empty and unresolved output identities", () => {
    expect(resolvedExitRouteOutputAssetKeys({ kind: "collateral", assetKeys: [] })).toBeNull();
    expect(resolvedExitRouteOutputAssetKeys({ kind: "fiat" })).toBeNull();
    expect(resolvedExitRouteOutputAssetKeys({ kind: "unknown", assetKeys: ["fiat:USD"] })).toBeNull();
  });

  it("sorts and deduplicates without mutating the caller's identities", () => {
    const assetKeys = ["z", "a", "z", "m"];
    expect(resolvedExitRouteOutputAssetKeys({ kind: "collateral", assetKeys })).toEqual(["a", "m", "z"]);
    expect(assetKeys).toEqual(["z", "a", "z", "m"]);
  });
});
