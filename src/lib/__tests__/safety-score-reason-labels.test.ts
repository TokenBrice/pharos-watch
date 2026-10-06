import { describe, expect, it } from "vitest";
import {
  describeEvaluatorKey,
  describeExcludedScoreComponent,
  describeExitRouteVenue,
  groupSafetyScoreReasons,
  humanizeSafetyScoreReason,
} from "@/lib/safety-score-reason-labels";

describe("safety score reason labels", () => {
  it("resolves evaluator keys to display names", () => {
    expect(describeEvaluatorKey("chain:solana")).toBe("Solana");
    expect(describeEvaluatorKey("bridge-route:protocol:chainlink-ccip")).toBe("Chainlink CCIP");
    expect(describeEvaluatorKey("bridge-meta:susde-ethena:02f0be89d79d3a6b4f02")).toBe("a bridge route");
    expect(describeEvaluatorKey("mechanism:loss-absorption")).toBe("the loss absorption review");
  });

  it("rewrites known templates without leaking keys", () => {
    const share = humanizeSafetyScoreReason(
      "This asset's own reviewed share is 10% at chain:solana, conservative non-mature exposure upper bound from 10% to below 25% (also 73 reviewed paths across 57 assets share chain:solana).",
    );
    expect(share).toBe("10% of reviewed supply depends on Solana, shared by 73 paths across 57 assets");
    expect(humanizeSafetyScoreReason("unsafe-backing condition at mechanism:loss-absorption."))
      .toBe("Unsafe backing condition flagged in the loss absorption review");
  });

  it("folds repeated datum reasons per key class and counts each raw message once", () => {
    const messages = ["a1", "b2", "c3"].map(
      (hash) => `The materialSupplyShare datum for independently identified control bridge-meta:coin:${hash} remains unresolved.`,
    );
    const groups = groupSafetyScoreReasons([...messages, ...messages, "Exit routes share a failure domain"]);
    expect(groups.map((group) => [group.text, group.count])).toEqual([
      ["Bridged supply share unresolved on 3 bridge routes", 3],
      ["Exit routes share a failure domain", 1],
    ]);
  });

  it("keeps a single datum reason singular", () => {
    expect(groupSafetyScoreReasons([
      "The materialSupplyShare datum for independently identified control bridge-meta:coin:a1 remains unresolved.",
    ])[0]?.text).toBe("Bridged supply share unresolved for a bridge route");
  });

  it("names DEX exit venues instead of AMM ordinals", () => {
    expect(describeExitRouteVenue({ label: "Ethereum AMM 10", routeFamily: "dex-amm", capacity: { chain: "ethereum", protocol: "curve" } }))
      .toBe("Curve on Ethereum");
    expect(describeExitRouteVenue({ label: "Base AMM 3", routeFamily: "dex-amm", capacity: null })).toBe("DEX pool on Base");
    expect(describeExitRouteVenue({ label: "PSM swap", routeFamily: "protocol-redemption" })).toBe("PSM swap");
  });

  it("describes excluded score components in plain words", () => {
    expect(describeExcludedScoreComponent(
      "redemption:redemption:30a5bff0-25a2-4615-9279-cd046fa1a618:redemption:usdc-circle:offchain-issuer:cost",
    )).toBe("issuer redemption cost");
    expect(describeExcludedScoreComponent("dependency:parent")).toBe("the parent asset's score");
  });
});
