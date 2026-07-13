import { describe, it, expect } from "vitest";
import { scoreLiquidity } from "../report-cards";

type DexLiquidityInput = NonNullable<Parameters<typeof scoreLiquidity>[0]>;
type RedemptionLiquidityInput = NonNullable<Parameters<typeof scoreLiquidity>[1]>;

function dexLiquidity(liquidityScore: number): DexLiquidityInput {
  return { liquidityScore, concentrationHhi: 0.04, poolCount: 100, chainCount: 10 };
}

function sameNotionalDexObservation(): NonNullable<DexLiquidityInput["exitRouteObservations"]>[number] {
  return {
    routeId: "dex:test",
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: "ethereum",
      contractOrPoolId: "pool:test",
      protocol: "test-dex",
    },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
    evidenceKind: "measured-executable-depth",
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_000,
    freshnessSeconds: 0,
    commonModeKeys: ["chain:ethereum", "protocol:test-dex"],
  };
}

function documentedOffchainEventualRoute(overrides: Partial<RedemptionLiquidityInput> = {}): RedemptionLiquidityInput {
  return {
    score: null,
    eventualRedeemabilityScore: 65,
    routeFamily: "offchain-issuer",
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    resolutionState: "resolved",
    modelConfidence: "medium",
    capacitySemantics: "eventual-only",
    capacityConfidence: "documented-bound",
    routeStatus: "open",
    ...overrides,
  };
}

describe("scoreLiquidity", () => {
  it("treats configured but unrated redemption routes as NR with explicit detail", () => {
    const result = scoreLiquidity(undefined, {
      score: null,
      routeFamily: "queue-redeem",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      resolutionState: "missing-capacity",
      modelConfidence: "medium",
      capacitySemantics: "immediate-bounded",
    });

    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("configured but currently unrated");
  });

  it("blends DEX liquidity with a resolved redemption backstop score", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
      },
    );

    expect(result.grade).not.toBe("NR");
    expect(result.score).toBeGreaterThan(40);
    expect(result.detail).toContain("Effective exit score");
    expect(result.detail).toContain("Redemption backstop");
    expect(result.detail).toContain("Stablecoin redeem");
  });

  it("uses raw redemption score when only redemption exists (no cap)", () => {
    const result = scoreLiquidity(undefined, {
      score: 90,
      routeFamily: "collateral-redeem",
      immediateCapacityUsd: 100_000_000,
      immediateCapacityRatio: 1.0,
      resolutionState: "resolved",
      modelConfidence: "medium",
      capacitySemantics: "immediate-bounded",
    });

    // Capacity-aware model: medium-confidence redemption-only routes are discounted.
    expect(result.score).toBe(68);
    expect(result.detail).toContain("DEX liquidity unavailable");
    expect(result.detail).toContain("Redemption backstop 90/100");
  });

  it("high DEX liquidity dominates over low redemption score", () => {
    const result = scoreLiquidity(
      { liquidityScore: 95, concentrationHhi: 0.1, poolCount: 10, chainCount: 3 },
      {
        score: 30,
        routeFamily: "queue-redeem",
        immediateCapacityUsd: 1_000_000,
        immediateCapacityRatio: 0.1,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
      },
    );

    // Correlated queue redemption does not add an independent-route diversification bonus.
    expect(result.score).toBe(95);
  });

  it("does not let low-confidence redemption uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "low",
        capacitySemantics: "immediate-bounded",
      },
    );

    expect(result.score).toBe(40);
    expect(result.detail).toContain("not used for Safety Score uplift");
  });

  it("does not let static redemption uplift liquidity during severe active depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 33, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 82,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 2_300_000,
        immediateCapacityRatio: 0.1,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        routeStatus: "open",
      },
      { activeDepegBps: 8332 },
    );

    expect(result.score).toBe(33);
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("lets live-direct permissionless immediate redemption uplift during severe active depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 33, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 90,
        routeFamily: "psm-swap",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.3,
        resolutionState: "resolved",
        modelConfidence: "high",
        capacitySemantics: "immediate-bounded",
        capacityConfidence: "live-direct",
        capacityKind: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        routeStatus: "open",
      },
      { activeDepegBps: 3000 },
    );

    expect(result.score).toBe(90);
    expect(result.detail).not.toContain("not used for Safety Score uplift");
  });

  it("does not let degraded routes uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "degraded",
      },
    );

    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently degraded");
  });

  it("does NOT exclude redemption at 2499 bps depeg (just below severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 60,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2499 },
    );
    expect(result.score).not.toBeNull();
    expect(result.detail).not.toContain("active severe depeg requires live-open redemption evidence");
  });

  it("excludes non-live-direct redemption at exactly 2500 bps depeg (severe threshold)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 60,
        routeFamily: "offchain-issuer",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "documented-bound",
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("does NOT exclude strong live-direct redemption at exactly 2500 bps depeg", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 88,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "high",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-direct",
        capacityKind: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).not.toContain("active severe depeg requires live-open redemption evidence");
    expect(result.score).not.toBeNull();
  });

  it("excludes live-proxy redemption during severe depeg (not considered strong)", () => {
    const result = scoreLiquidity(
      { liquidityScore: 10, concentrationHhi: 0.1, poolCount: 1, chainCount: 1 },
      {
        score: 82,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.2,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "open",
        capacityConfidence: "live-proxy",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      },
      { activeDepegBps: 2500 },
    );
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
  });

  it("excludes paused routes regardless of confidence", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "paused",
      },
    );
    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently paused");
  });

  it("excludes cohort-limited routes regardless of confidence", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "cohort-limited",
      },
    );
    expect(result.score).toBe(40);
    expect(result.detail).toContain("route currently cohort-limited");
  });

  it("keeps unknown route status eligible outside severe active depegs", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 85,
        routeFamily: "stablecoin-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        routeStatus: "unknown",
      },
    );

    expect(result.score).toBeGreaterThan(40);
  });

  it("does not let eventual-only redemption uplift liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 25, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 87,
        routeFamily: "basket-redeem",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "eventual-only",
        routeStatus: "open",
      },
    );

    expect(result.score).toBe(25);
    expect(result.detail).toContain("not used for Safety Score uplift (eventual-only route)");
  });

  it("lets documented offchain issuer eventual redemption add only a DEX-gated primary-market bonus", () => {
    const result = scoreLiquidity(dexLiquidity(63), documentedOffchainEventualRoute());

    expect(result.score).toBe(63);
    expect(result.detail).toContain("primary-market exit bonus only");
    expect(result.detail).toContain("eventual redeemability modeled; immediate buffer not separately quantified");
    expect(result.detail).not.toContain("not used for Safety Score uplift");
  });

  it("caps documented offchain eventual contribution at the DEX floor when DEX is below redemption", () => {
    const result = scoreLiquidity(
      dexLiquidity(40),
      documentedOffchainEventualRoute({ routeExitCorrelation: "independent-issuer-rail" }),
    );

    expect(result.score).toBe(43);
    expect(result.detail).toContain("DEX liquidity 40/100");
    expect(result.detail).toContain("Redemption backstop 65/100");
    expect(result.detail).toContain("primary-market exit bonus only");
  });

  it("keeps documented offchain eventual contribution as a bonus when DEX is above redemption", () => {
    const result = scoreLiquidity(
      dexLiquidity(80),
      documentedOffchainEventualRoute({ routeExitCorrelation: "independent-issuer-rail" }),
    );

    expect(result.score).toBe(85);
    expect(result.detail).toContain("DEX liquidity 80/100");
    expect(result.detail).toContain("Redemption backstop 65/100");
    expect(result.detail).toContain("primary-market exit bonus only");
  });

  it("does not let documented offchain issuer eventual redemption replace missing DEX liquidity", () => {
    const result = scoreLiquidity(undefined, documentedOffchainEventualRoute());

    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("primary-market route requires DEX liquidity floor");
  });

  it("does not treat eventual offchain routes with missing capacityConfidence as documented-bound", () => {
    const result = scoreLiquidity(dexLiquidity(40), documentedOffchainEventualRoute({ capacityConfidence: undefined }));

    expect(result.score).toBe(40);
    expect(result.detail).toContain("not used for Safety Score uplift (eventual-only route)");
    expect(result.detail).not.toContain("primary-market exit bonus only");
  });

  it("keeps documented offchain eventual routes eligible when route status is unknown", () => {
    const result = scoreLiquidity(
      dexLiquidity(40),
      documentedOffchainEventualRoute({
        routeExitCorrelation: "independent-issuer-rail",
        routeStatus: "unknown",
      }),
    );

    expect(result.score).toBe(43);
    expect(result.detail).toContain("primary-market exit bonus only");
    expect(result.detail).not.toContain("route currently unknown");
  });

  it("does not let low-confidence offchain issuer eventual redemption add a primary-market bonus", () => {
    const result = scoreLiquidity(dexLiquidity(63), documentedOffchainEventualRoute({ modelConfidence: "low" }));

    expect(result.score).toBe(63);
    expect(result.detail).toContain("low confidence");
  });

  it("excludes documented offchain issuer eventual redemption during severe active depegs", () => {
    const result = scoreLiquidity(
      dexLiquidity(63),
      documentedOffchainEventualRoute({
        sourceMode: "estimated",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        routeExitCorrelation: "independent-issuer-rail",
      }),
      { activeDepegBps: 2500 },
    );

    expect(result.score).toBe(63);
    expect(result.detail).toContain("active severe depeg requires live-open redemption evidence");
    expect(result.detail).not.toContain("primary-market exit bonus only");
  });

  it("caps queue redemption uplift before blending with DEX liquidity", () => {
    const result = scoreLiquidity(
      { liquidityScore: 40, concentrationHhi: 0.3, poolCount: 5, chainCount: 2 },
      {
        score: 90,
        routeFamily: "queue-redeem",
        immediateCapacityUsd: 50_000_000,
        immediateCapacityRatio: 0.5,
        resolutionState: "resolved",
        modelConfidence: "medium",
        capacitySemantics: "immediate-bounded",
        settlementModel: "queued",
        routeStatus: "open",
      },
    );

    // Queue cap and medium confidence discount the redemption contribution before blending.
    expect(result.score).toBe(53);
  });

  it("keeps supply-weighted deployment materiality behind explicit activation", () => {
    const liq: DexLiquidityInput = {
      ...dexLiquidity(95),
      exitRouteObservations: [sameNotionalDexObservation()],
      deploymentSupplyCoverage: {
        totalSupplyUsd: 100_000_000,
        observedSupplyUsd: 80_000_000,
        verifiedNoPoolsSupplyUsd: 0,
        providerInaccessibleSupplyUsd: 20_000_000,
        unknownSupplyUsd: 0,
        observedSupplyRatio: 0.8,
        verifiedNoPoolsSupplyRatio: 0,
        providerInaccessibleSupplyRatio: 0.2,
        unknownSupplyRatio: 0,
        unknownChains: [],
      },
    };

    expect(scoreLiquidity(liq).score).toBe(95);
    const active = scoreLiquidity(liq, undefined, {
      sameNotionalScoringMode: "active",
      circulatingSupplyUsd: 20_000_000,
      exitObservationAsOfSec: 1_100,
      dexExitObservationMaxAgeSec: 1_000,
    });
    expect(active.score).toBe(85);
    expect(active.detail).toContain("20.0% of supply uncovered");
  });

  it("does not cap peripheral uncovered deployment supply", () => {
    const result = scoreLiquidity(
      {
        ...dexLiquidity(95),
        exitRouteObservations: [sameNotionalDexObservation()],
        deploymentSupplyCoverage: {
          totalSupplyUsd: 100_000_000,
          observedSupplyUsd: 95_000_000,
          verifiedNoPoolsSupplyUsd: 0,
          providerInaccessibleSupplyUsd: 0,
          unknownSupplyUsd: 5_000_000,
          observedSupplyRatio: 0.95,
          verifiedNoPoolsSupplyRatio: 0,
          providerInaccessibleSupplyRatio: 0,
          unknownSupplyRatio: 0.05,
          unknownChains: ["peripheral"],
        },
      },
      undefined,
      {
        sameNotionalScoringMode: "active",
        circulatingSupplyUsd: 20_000_000,
        exitObservationAsOfSec: 1_100,
        dexExitObservationMaxAgeSec: 1_000,
      },
    );

    expect(result.score).toBe(95);
  });
});
