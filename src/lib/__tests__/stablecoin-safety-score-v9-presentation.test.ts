import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import {
  buildStablecoinSafetyScoreV9Presentation,
  describeSafetyScoreV9Components,
  humanizeSafetyScoreV9Value,
} from "@/lib/stablecoin-safety-score-v9-presentation";

describe("stablecoin V9 safety presentation", () => {
  it("derives honest score trace labels without recreating V8 dimensions", () => {
    const card = makeV9Card({
      score: 84,
      grade: "A",
      bindingCap: {
        kind: "track-record",
        limit: 84,
        source: "structural",
        reason: "Less than two years of implementation history.",
        binding: true,
      },
    });
    card.scoreTrace.stages.preCapScore = 86.9;
    card.scoreTrace.stages.deploymentAdjustmentPoints = 0.3;
    card.scoreTrace.stages.pegMultiplier = 0.99;

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.traceParts).toEqual([
      "Pre-cap 86.9",
      "Track-record cap 84",
      "Peg x0.990",
      "Deployment -0.3",
    ]);
    expect(presentation.pillars.map((pillar) => pillar.label)).toEqual([
      "Backing",
      "Exit",
      "Economic Control",
    ]);
  });

  it("humanizes public enum values and omits unknown access fields", () => {
    const card = makeV9Card({
      accessPosture: {
        transfer: "permissionless",
        freezeExposure: "none-known",
        primaryExit: "unknown",
        governance: "single-entity",
        unknownFields: ["primaryExit"],
        signals: [],
        reasons: [],
      },
    });

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.accessRows).toEqual([
      { key: "transfer", label: "Transfer", value: "Permissionless" },
      { key: "freezeExposure", label: "Freeze exposure", value: "None known" },
      { key: "governance", label: "Governance", value: "Single entity" },
    ]);
    expect(humanizeSafetyScoreV9Value("issuer-discretionary")).toBe("Issuer discretionary");
  });

  it("turns opaque public component keys into categorized input details", () => {
    expect(describeSafetyScoreV9Components([
      "mechanism:liquidation-mechanics",
      "reserve:concentration",
      "reserve:reserve:abc",
      "reserve:reserve:def",
      "dex:generation:dex:asset:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool",
      "redemption:generation:redemption:asset:collateral-redeem",
      "bridge:arbitrum:0x123:bridge-meta:asset:key",
      "mint",
      "oracle",
    ])).toEqual([
      { key: "mechanism:liquidation-mechanics", label: "Liquidation mechanics", category: "Mechanism" },
      { key: "reserve:concentration", label: "Reserve concentration", category: "Reserve" },
      { key: "reserve:reserve:abc", label: "Reserve slice 1", category: "Reserve" },
      { key: "reserve:reserve:def", label: "Reserve slice 2", category: "Reserve" },
      {
        key: "dex:generation:dex:asset:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool",
        label: "Curve liquidity route",
        category: "DEX",
      },
      {
        key: "redemption:generation:redemption:asset:collateral-redeem",
        label: "Collateral redemption",
        category: "Redemption",
      },
      { key: "bridge:arbitrum:0x123:bridge-meta:asset:key", label: "Arbitrum bridge", category: "Bridge" },
      { key: "mint", label: "Mint authority", category: "Authority" },
      { key: "oracle", label: "Oracle design", category: "Oracle" },
    ]);
  });
});
