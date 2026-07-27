import { describe, expect, it } from "vitest";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types";
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

  it("adapts numeric V9 breakdowns without inventing control weights", () => {
    const card = makeV9Card();
    card.breakdowns = {
      backing: {
        evaluatedScore: 86,
        publishedScore: 88,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves", label: "Reserves", score: 86, effectiveWeight: 1 }],
        components: [{
          key: "reserve:reserve:wsteth",
          label: "wstETH",
          source: "reserve-exposure",
          score: 86,
          effectiveWeight: 1,
          weightedContribution: 86,
          observationState: "known",
        }],
        adjustments: [{
          kind: "operational-resilience-credit",
          scoreBefore: 86,
          scoreAfter: 88,
          delta: 2,
        }],
      },
      exit: {
        evaluatedScore: 84,
        publishedScore: 84,
        aggregationWeight: 0.35,
        stressRequest: {
          requestedNotionalUsd: 10_000_000,
          maxCostBps: 100,
          comparisonWindowSec: 86_400,
        },
        primaryRoute: {
          key: "redemption:primary",
          label: "Direct redemption",
          routeFamily: "issuer-redemption",
          score: 84,
          components: [
            { key: "access", label: "Access", score: 90, weight: 0.2, weightedContribution: 18 },
            { key: "settlement", label: "Settlement", score: 84, weight: 0.15, weightedContribution: 12.6 },
            { key: "executionCertainty", label: "Execution certainty", score: 80, weight: 0.15, weightedContribution: 12 },
            { key: "capacity", label: "Capacity", score: 78, weight: 0.25, weightedContribution: 19.5 },
            { key: "outputAssetQuality", label: "Output asset quality", score: 92, weight: 0.15, weightedContribution: 13.8 },
            { key: "cost", label: "Cost", score: 81, weight: 0.1, weightedContribution: 8.1 },
          ],
          confidenceFactor: 1,
          eligibilityMultiplier: 1,
          capsApplied: [],
        },
        diversification: null,
        alternatives: [{
          key: "dex:curve",
          label: "Curve liquidity",
          routeFamily: "dex-amm",
          score: 77,
          included: true,
          exclusionReason: null,
        }],
        adjustments: [],
      },
      control: {
        evaluatedScore: 86,
        publishedScore: 86,
        aggregationWeight: 0.25,
        method: "minimum-binding-component",
        components: [
          { key: "mint", label: "Mint authority", kind: "mint", score: 86, binding: true, posture: "concentrated" },
          { key: "oracle", label: "Oracle design", kind: "oracle", score: 95, binding: false, posture: "distributed" },
        ],
        adjustments: [],
      },
    };

    const presentation = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    );

    expect(presentation.pillars[0].breakdown).toMatchObject({
      aggregationWeight: 0.4,
      sectionLabel: "Backing components",
      rows: [{ label: "wstETH", score: 86, weight: 1, status: "Known" }],
    });
    expect(presentation.pillars[0].breakdown?.context).toContainEqual({
      key: "operational-resilience-credit-0",
      label: "Resilience credit",
      value: "+2.0 to 88.0",
    });
    expect(presentation.pillars[1].breakdown).toMatchObject({
      sectionLabel: "Route components",
      alternatives: [{ label: "Curve liquidity", score: 77, included: true }],
    });
    expect(presentation.pillars[1].breakdown?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Access", score: 90, weight: 0.2 }),
      expect.objectContaining({ label: "Capacity", score: 78, weight: 0.25 }),
    ]));
    expect(presentation.pillars[1].breakdown?.context).toEqual(expect.arrayContaining([
      { key: "primary-route", label: "Primary route", value: "Direct redemption" },
      { key: "stress-request", label: "Stress request", value: "$10m / 100 bps / 1d" },
    ]));
    expect(presentation.pillars[2].breakdown?.rows).toEqual([
      { key: "mint", label: "Mint authority", score: 86, weight: null, status: "Binding" },
      { key: "oracle", label: "Oracle design", score: 95, weight: null, status: "Diagnostic" },
    ]);
  });
});
