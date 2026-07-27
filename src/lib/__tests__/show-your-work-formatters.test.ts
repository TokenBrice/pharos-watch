import { describe, expect, it } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import {
  formatChainHealth,
  formatDews,
  formatLiquidity,
  formatPsi,
  formatRedemption,
  formatReportCard,
  formatReportCardV9,
} from "@/lib/show-your-work-formatters";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";

describe("show-your-work formatters", () => {
  it("formats report card raw inputs into rows", () => {
    const rawInputs = createReportCardRawInputs({
      pegScore: 95,
      liquidityScore: 72,
      effectiveExitScore: 70,
      collateralQuality: "rwa",
      mintAuthorityScore: 64,
      oracleRiskTier: "medianized-with-delay",
      oracleRiskScore: 85,
      bridgeRouteRiskTier: "external-lock-mint",
      bridgeRouteRiskScore: 40,
    });
    const table = formatReportCard(rawInputs);
    expect(table.topic).toBe("safetyScore");
    expect(table.rows.find((r) => r.label === "Mint authority score")?.value).toBe("64");
    const pegRow = table.rows.find((r) => r.label === "Peg score");
    expect(pegRow?.value).toBe("95");
    const liqRow = table.rows.find((r) => r.label === "Liquidity score");
    expect(liqRow?.value).toBe("72");
    expect(table.rows.find((r) => r.label === "Oracle risk tier")?.value).toBe("medianized-with-delay");
    expect(table.rows.find((r) => r.label === "Oracle risk score")?.value).toBe("85");
    expect(table.rows.find((r) => r.label === "Bridge route tier")?.value).toBe("external-lock-mint");
    expect(table.rows.find((r) => r.label === "Bridge route score")?.value).toBe("40");
    expect(table.formula).toContain("weighted(liquidity/exit, resilience, decentralization, dependency risk)");
    expect(table.formula).toContain("CDP oracle");
    expect(table.formula).toContain("bridge-route");
    expect(table.formula).toContain("(Peg Score/100)^0.40");
    expect(table.formula).toContain("×0.9");
    expect(table.formula).toContain("active-depeg");
  });

  it("formats V9 score stages without routing through V8 raw inputs", () => {
    const card = makeV9Card({
      bindingCap: {
        kind: "track-record:<24m",
        limit: 84,
        source: "structural",
        reason: "Less than two years of implementation history.",
        binding: true,
      },
    });
    card.scoreTrace.stages.preCapScore = 86.9;

    const table = formatReportCardV9(card, "candidate-v2");

    expect(table.versionLabel).toBe("candidate-v2");
    expect(table.rows.find((row) => row.label === "Backing pillar")?.value).toBe("88.0");
    expect(table.rows.find((row) => row.label === "Pre-cap score")?.value).toBe("86.9");
    expect(table.rows.find((row) => row.label === "Binding cap")?.value).toBe("84 (track-record:<24m)");
    expect(table.formula).toContain("bounded-headroom aggregation");
    expect(table.formula).not.toContain("resilience");
  });

  it("formats DEWS signals", () => {
    const table = formatDews({
      score: 42,
      band: "ALERT",
      signals: {
        supply: { value: 80, available: true },
        pool: { value: 0, available: false },
      },
      computedAt: 0,
      methodologyVersion: "v6.0",
    });
    expect(table.topic).toBe("dews");
    expect(table.rows.find((r) => r.label === "supply")?.value).toBe("80");
    expect(table.rows.find((r) => r.label === "pool")?.value).toBe("n/a");
    expect(table.rows.find((r) => r.label === "Composite score")?.value).toBe("42");
    expect(table.formula).toContain("weighted average of available stress signals");
    expect(table.formula).toContain("weights redistributed");
    expect(table.formula).not.toContain("max(per-signal stress");
  });

  it("formats liquidity components with weighted contributions", () => {
    const table = formatLiquidity({
      tvlDepth: 80,
      volumeActivity: 60,
      poolQuality: 70,
      durability: 50,
      pairDiversity: 40,
    });
    expect(table.topic).toBe("liquidityScore");
    const tvl = table.rows.find((r) => r.label === "TVL Depth");
    expect(tvl?.value).toBe("80.0");
    expect(tvl?.weight).toBe("30%");
    expect(tvl?.contribution).toBe("24.0");
  });

  it("formats PSI components", () => {
    const table = formatPsi({
      score: 88,
      band: "STEADY",
      components: { severity: 5, breadth: 3, stressBreadth: 2, trend: 1 },
      computedAt: 0,
      methodologyVersion: "v3.3",
    });
    expect(table.topic).toBe("psi");
    expect(table.rows.find((r) => r.label === "Composite score")?.value).toBe("88.0");
    expect(table.rows.find((r) => r.label === "Severity penalty")?.value).toBe("5.0");
  });

  it("formats redemption sub-scores", () => {
    const table = formatRedemption({
      stablecoinId: "test",
      score: 70,
      effectiveExitScore: 65,
      dexLiquidityScore: null,
      accessScore: 80,
      settlementScore: 75,
      executionCertaintyScore: 70,
      capacityScore: 60,
      outputAssetQualityScore: 90,
      costScore: 85,
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      provider: "test",
      sourceMode: "static",
      resolutionState: "resolved",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "any-holder",
      capacityConfidence: "documented-bound",
      capacitySemantics: "immediate-bounded",
      feeConfidence: "fixed",
      feeModelKind: "fixed-bps",
      modelConfidence: "high",
      immediateCapacityUsd: 1_000_000,
      immediateCapacityRatio: 0.05,
      feeBps: 10,
      queueEnabled: false,
      methodologyVersion: "v2.0",
      updatedAt: 0,
    });
    expect(table.topic).toBe("redemptionBackstop");
    expect(table.rows.find((r) => r.label === "Access")?.value).toBe("80");
    expect(table.rows.find((r) => r.label === "Fee (bps)")?.value).toBe("10");
    expect(table.formula).toContain("route score = weighted");
    expect(table.formula).toContain("model-confidence discount");
    expect(table.formula).toContain("independent-route diversification");
  });

  it("pins effective-exit methodology copy to the confidence-discount pipeline", () => {
    expect(METHODOLOGY_CONTEXT.effectiveExit.detail).toContain("route score is first capped");
    expect(METHODOLOGY_CONTEXT.effectiveExit.detail).toContain("model-confidence discount");
    expect(METHODOLOGY_CONTEXT.effectiveExit.detail).toContain("diversification bonus");
  });

  it("formats chain-health factors with weighted contributions", () => {
    const table = formatChainHealth({
      concentration: 80,
      quality: 70,
      pegStability: 95,
      backingDiversity: 60,
      chainEnvironment: 100,
    }, {
      source: "pharos-chain-tier",
      score: 100,
      resilienceTier: 1,
    });
    expect(table.topic).toBe("chainHealth");
    const quality = table.rows.find((r) => r.label === "Quality");
    expect(quality?.value).toBe("70");
    expect(quality?.weight).toBe("30%");
    expect(quality?.contribution).toBe("21.0");
    expect(table.rows.find((r) => r.label === "Chain environment")?.value).toBe("100 (Pharos tier 1)");
  });

  it("formats L2BEAT chain-health evidence", () => {
    const table = formatChainHealth({
      concentration: 80,
      quality: 70,
      pegStability: 95,
      backingDiversity: 60,
      chainEnvironment: 82,
    }, {
      source: "l2beat",
      score: 82,
      projectId: "base",
      slug: "base",
      name: "Base Chain",
      stage: "Stage 1",
      isUnderReview: false,
      stageScore: 80,
      riskScore: 84,
      risks: {
        sequencerFailure: { value: "Self sequence", sentiment: "good" },
        stateValidation: { value: "Fraud proofs", sentiment: "good" },
        dataAvailability: { value: "Onchain", sentiment: "good" },
        exitWindow: { value: "None", sentiment: "bad" },
        proposerFailure: { value: "Self propose", sentiment: "good" },
      },
      snapshot: {
        source: "https://l2beat.com/api/scaling/summary",
        fetchedAt: "2026-06-12",
      },
    });

    expect(table.rows.find((r) => r.label === "Chain environment")?.value)
      .toBe("82 (Base Chain Stage 1, risk 84, snapshot 2026-06-12)");
  });
});
