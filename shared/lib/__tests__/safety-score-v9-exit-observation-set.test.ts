import { describe, expect, it } from "vitest";
import type { ExitRouteObservation, ExitRouteOutput } from "../../types/exit-route";
import { mergeExitRouteObservations, mergeExitRouteObservationSets } from "../safety-score-v9/exit-observation-set";

function observation(
  lane: "dex" | "redemption",
  routeId: string,
  output: ExitRouteOutput = { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
): ExitRouteObservation {
  return {
    routeId,
    routeFamily: lane === "dex" ? "dex-amm" : "issuer-redemption",
    scope:
      lane === "dex"
        ? { kind: "chain-contract", chain: "ethereum", contractOrPoolId: `pool:${routeId}`, protocol: "test" }
        : { kind: "issuer", issuerId: "test-issuer" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: lane === "dex" ? 300 : 86_400,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output,
    evidenceKind: lane === "dex" ? "measured-executable-depth" : "documented-terms",
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_000,
    freshnessSeconds: 0,
    commonModeKeys: [`lane:${lane}`],
  };
}

describe("mergeExitRouteObservations", () => {
  it("merges both lanes in stable routeId order", () => {
    const result = mergeExitRouteObservations(
      [observation("dex", "route:z"), observation("dex", "route:a")],
      [observation("redemption", "route:m")],
      "asset-a",
    );

    expect(result.map((route) => route.routeId)).toEqual(["route:a", "route:m", "route:z"]);
  });

  it("deduplicates structurally identical route IDs within one producer lane", () => {
    const duplicate = observation("dex", "route:duplicate");
    expect(mergeExitRouteObservations([duplicate, { ...duplicate }], [])).toEqual([duplicate]);
  });

  it("rejects observations supplied through the wrong producer lane", () => {
    const dexRoute = observation("dex", "route:dex");
    const redemptionRoute = observation("redemption", "route:redemption");

    expect(() => mergeExitRouteObservations([], [dexRoute], "asset-a")).toThrow(
      /redemption\[0\].*redemption route family/,
    );
    expect(() => mergeExitRouteObservations([redemptionRoute], [], "asset-a")).toThrow(/dex\[0\].*DEX route family/);
  });

  it("throws a useful error for conflicting route IDs", () => {
    const route = observation("dex", "route:conflict");
    expect(() => mergeExitRouteObservations([route, { ...route, executableUsd: 900_000 }], [], "asset-a")).toThrow(
      /route:conflict.*asset "asset-a".*dex\[0\].*dex\[1\]/,
    );
  });
});

describe("mergeExitRouteObservationSets", () => {
  it("merges sorted asset sets and summarizes output resolution per source lane", () => {
    const dex = new Map<string, readonly ExitRouteObservation[]>([
      ["asset-b", [observation("dex", "dex:resolved-asset-b", { kind: "collateral", assetKeys: ["ethereum:weth"] })]],
      [
        "asset-a",
        [
          observation("dex", "dex:resolved-asset"),
          observation("dex", "dex:resolved-basket", {
            kind: "collateral",
            basketWeights: [
              { symbol: "WETH", weight: 0.5 },
              { symbol: "WBTC", weight: 0.5 },
            ],
          }),
          observation("dex", "dex:unresolved-asset", { kind: "unresolved-asset" }),
          observation("dex", "dex:unresolved-basket", { kind: "unresolved-basket" }),
          observation("dex", "dex:unknown", { kind: "unknown" }),
        ],
      ],
    ]);
    const redemption = new Map<string, readonly ExitRouteObservation[]>([
      ["asset-c", []],
      [
        "asset-a",
        [
          observation("redemption", "redemption:resolved-asset", { kind: "fiat", currency: "USD" }),
          observation("redemption", "redemption:resolved-basket", {
            kind: "tracked-stablecoin",
            trackedAssetIds: ["usdc-circle", "usdt-tether"],
          }),
          observation("redemption", "redemption:unresolved-asset", { kind: "unresolved-asset" }),
          observation("redemption", "redemption:unresolved-basket", { kind: "unresolved-basket" }),
          observation("redemption", "redemption:unknown", { kind: "unknown" }),
        ],
      ],
    ]);

    const result = mergeExitRouteObservationSets(dex, redemption);

    expect([...result.observationsByAssetId.keys()]).toEqual(["asset-a", "asset-b"]);
    expect(result.observationsByAssetId.get("asset-a")?.map((route) => route.routeId)).toEqual([
      "dex:resolved-asset",
      "dex:resolved-basket",
      "dex:unknown",
      "dex:unresolved-asset",
      "dex:unresolved-basket",
      "redemption:resolved-asset",
      "redemption:resolved-basket",
      "redemption:unknown",
      "redemption:unresolved-asset",
      "redemption:unresolved-basket",
    ]);
    expect(result.summary).toEqual({
      dex: {
        assetCount: 2,
        observationCount: 6,
        resolvedAssetOutputCount: 2,
        resolvedBasketOutputCount: 1,
        unresolvedAssetOutputCount: 1,
        unresolvedBasketOutputCount: 1,
        unknownOutputCount: 1,
      },
      redemption: {
        assetCount: 1,
        observationCount: 5,
        resolvedAssetOutputCount: 1,
        resolvedBasketOutputCount: 1,
        unresolvedAssetOutputCount: 1,
        unresolvedBasketOutputCount: 1,
        unknownOutputCount: 1,
      },
    });
  });

  it("rejects conflicting identities across producer lanes", () => {
    const dexRoute = observation("dex", "shared-route");
    const redemptionRoute = observation("redemption", "shared-route");

    expect(() =>
      mergeExitRouteObservationSets(new Map([["asset-a", [dexRoute]]]), new Map([["asset-a", [redemptionRoute]]])),
    ).toThrow(/shared-route.*dex\[0\].*redemption\[0\]/);
  });
});
