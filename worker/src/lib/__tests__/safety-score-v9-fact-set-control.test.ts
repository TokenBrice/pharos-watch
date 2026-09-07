import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { compileSafetyScoreV9FactSetFromFixedInput, compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension, computeSafetyScoreV9ReserveExposureKey, materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9/fact-set";
import { V9_EVALUATION_TEST_TIMEOUT_MS, makeV9BoundedUnknownFeeRedemptionFixedInput as boundedUnknownFeeRedemptionFixedInput, makeV9FixedInput as exactFixedInput, makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput } from "../../test-helpers/v9-fixed-input";
import {
  accessOnlyMeta,
  alphaMeta,
  bridgeMeta,
  bridgeRoute,
  boundedStatus,
  cappedMinterMeta,
  immutableMintMeta,
  localControl,
  materialityFixture,
  metaMap,
  rebuildFixed,
  reviewedOracleMeta,
  reviewedUpgradeExtension,
  strategyVaultExtension,
  unresolvedMintMeta,
  unmatchedFixture,
  withRedemptionRoute,
} from "./safety-score-v9-fact-set.test-support";

const controlsOf = (asset: { controlReview: unknown }) => {
  const review = asset.controlReview;
  return review && typeof review === "object" && "controls" in review && Array.isArray(review.controls) ? review.controls : [];
};

describe("Safety Score v9 exact base fact-set adapter — control and wrapper dimensions", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("maps explicit oracle branches and remains NR without a mechanism review", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(reviewedOracleMeta()) });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const oracle = compiled.assets[0]!.economicControlReview.oracle;
    expect(oracle).toMatchObject({ tier: "redundant-with-failover" });
    expect(oracle.branches.map((branch) => [branch.branch, branch.status.observationState])).toEqual([
      ["backstop", "known"], ["collateral-parameter", "known"], ["feed", "known"], ["liquidation", "known"], ["shutdown-bad-debt", "known"],
    ]);
    expect(oracle.branches.every((branch) => branch.mechanismKey !== null && branch.controlKey === null)).toBe(true);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
    expect(buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ mechanismArchetype: "cdp" })) }).assets[0]!.economicControlReview).toBeNull();
  });

  it("compiles a reviewed top-level internal price without liquidation branches", () => {
    const fixed = exactFixedInput();
    const meta = alphaMeta({ mechanismArchetype: "synthetic-delta-neutral", oracleRisk: {
      tier: "privileged-internal-pricing", summary: "A privileged backend constructs the quote.", branchModel: "single-path", branchApplicability: { disposition: "top-level-only", reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", rationale: "No borrower liquidation branches.", sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }] }, reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }],
    } });
    const oracle = compileSafetyScoreV9FactSetFromFixedInput(fixed, buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta) })).assets[0]!.economicControlReview.oracle;
    expect(oracle).toMatchObject({ tier: "privileged-internal-pricing", liquidationBranchesApplicable: false, branches: [], status: { observationState: "known" } });
  });

  it("retains a reviewed mint path when inventory remains unresolved", () => {
    const fixed = exactFixedInput();
    const unresolved = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(unresolvedMintMeta()) });
    expect(unresolved.assets[0]!.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, unresolved).assets[0]!.controls[0]).toMatchObject({ status: { observationState: "bounded-unknown" }, claimImpairment: "unbounded" });
  });

  it("reviews strategy-vault holder-loss controls from a partial inventory", () => {
    const fixed = exactFixedInput();
    const reviewed = strategyVaultExtension();
    reviewed.assets[0]!.controlReview = { state: "partially-reviewed-controls", rationale: "Local custody is reviewed; bridge authority is unresolved.", controls: [localControl(), localControl({ controlKey: "bridge:unresolved", controlKind: "bridge", deploymentKey: "ethereum:0x3333333333333333333333333333333333333333", capabilities: ["bridge-mint"], capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown", economicLossScope: "unknown", authority: null, delaySec: null, materialSupplyShare: 1, failureDomains: [{ kind: "bridge-route", key: "ethereum:0x3333333333333333333333333333333333333333" }] })] };
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    expect(asset.controlStatus).toMatchObject({ observationState: "bounded-unknown" });
    expect(asset.wrapperLocalFacts).toMatchObject({ applicability: "wrapper", form: "strategy-vault", facts: { lossAbsorptionEmergencyControls: { disposition: "reviewed", assessment: "moderate" } } });
  });

  describe("wrapper-local dimension branches", () => {
    const facts = (reviewed: ReturnType<typeof strategyVaultExtension>, fixed = exactFixedInput()) => {
      const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
      if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
      return asset.wrapperLocalFacts.facts;
    };

    it("escalates an active control incident to critical loss-absorption risk", () => {
      const reviewed = strategyVaultExtension();
      reviewed.assets[0]!.controlReview = { state: "partially-reviewed-controls", rationale: "Active local incident.", controls: [localControl({ incidentState: "active" })] };
      expect(facts(reviewed).lossAbsorptionEmergencyControls).toMatchObject({ assessment: "critical", signals: expect.arrayContaining(["active-control-incident:custody:reviewed"]) });
    });

    it.each([
      ["missing", undefined, "wrapper-upgrade-review-unavailable"],
      ["unresolved-control", "upgrade:unresolved", "reviewed-upgrade-control-not-compiled:upgrade:unresolved"],
      ["undisclosed", "upgrade:unknown", "wrapper-upgrade-authority-undisclosed"],
    ] as const)("handles %s contract mutability", (_label, key, signal) => {
      const reviewed = strategyVaultExtension();
      if (key === undefined) {
        reviewed.assets[0]!.economicControlReview!.mint.status = boundedStatus("v9.control.mint-review", "extension-gap:mint:alpha");
        reviewed.assets[0]!.economicControlReview!.mint.reconciliation = "unknown";
        reviewed.assets[0]!.economicControlReview!.mint.upgrade = { state: "unknown", controlKey: null };
      } else if (key === "upgrade:unresolved") {
        reviewed.assets[0]!.controlReview = { state: "partially-reviewed-controls", rationale: "The upgrade identity is unresolved.", controls: [localControl({ controlKey: key, controlKind: "upgrade", capabilities: ["upgrade"], capSemantics: { kind: "unknown", bound: null }, claimImpairment: "unknown", economicLossScope: "unknown", authority: null, delaySec: null, failureDomains: [] })] };
        reviewed.assets[0]!.economicControlReview!.mint.upgrade = { state: "reviewed", controlKey: key };
      } else reviewed.assets[0]!.economicControlReview!.mint.upgrade = { state: "unknown", controlKey: null };
      expect(facts(reviewed).contractMutability).toMatchObject({ signals: [signal] });
    });

    it("grades a leverage factor high", () => {
      const fixed = structuredClone(exactFixedInput());
      for (const slice of fixed.liveReserveMap.alpha!) slice.riskFactors = ["leverage", "counterparty"];
      expect(facts(strategyVaultExtension(), rebuildFixed(fixed)).leverage).toMatchObject({ assessment: "high", signals: expect.arrayContaining(["wrapper-leverage-factor:leverage"]) });
    });

    it("keeps withdrawal fees undisclosed and parameterizes access posture", () => {
      const feeFixed = boundedUnknownFeeRedemptionFixedInput();
      const feeExtension = strategyVaultExtension();
      feeExtension.registryFingerprint = feeFixed.registryFingerprint;
      feeExtension.assets[0]!.assetId = "usdc-circle";
      feeExtension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(feeFixed, "usdc-circle");
      feeExtension.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(feeFixed, "usdc-circle");
      expect(facts(feeExtension, feeFixed).withdrawalTerms).toMatchObject({ disposition: "issuer-undisclosed", signals: ["wrapper-withdrawal-fee-undisclosed"] });
      for (const [holderAccess, assessment] of [["issuer-only", "critical"], ["allowlisted", "moderate"], ["permissionless", "low"]] as const) {
        const fixed = queuedRedemptionFixedInput(86_400, true);
        const reviewed = withRedemptionRoute(fixed, { settlementModel: "atomic", executionModel: "market-depth", executionCertainty: "bounded", holderAccess, settlementSlaSec: null });
        expect(facts(reviewed, fixed).withdrawalTerms).toMatchObject({ assessment });
      }
    });

    it("grades queued redemption by settlement SLA and measured unwind availability", () => {
      for (const [settlementSlaSec, assessment] of [[8 * 86_400, "high"], [2 * 86_400, "moderate"]] as const) {
        const fixed = queuedRedemptionFixedInput(86_400, true);
        expect(facts(withRedemptionRoute(fixed, { settlementModel: "queued", holderAccess: "permissionless", executionModel: "market-depth", executionCertainty: "bounded", settlementSlaSec }), fixed).withdrawalTerms).toMatchObject({ assessment });
      }
      const draft = structuredClone(exactFixedInput());
      draft.dexLiqMap.alpha!.exitRouteObservations![0]!.maxCostBps = 300;
      draft.dexLiqMap.alpha!.exitRouteObservations![0]!.capacityCurve = draft.dexLiqMap.alpha!.exitRouteObservations![0]!.capacityCurve!.map((point) => ({ ...point, maxCostBps: 300 }));
      const reviewed = strategyVaultExtension();
      reviewed.assets[0]!.routeReviews = reviewed.assets[0]!.routeReviews.map((review) => ({ ...review, executionCosts: review.executionCosts.map((cost) => ({ ...cost, maxCostBps: 300 })) }));
      expect(facts(reviewed, rebuildFixed(draft)).measuredUnwind).toMatchObject({ assessment: "critical", signals: ["wrapper-measured-unwind:no-score-eligible-capacity"] });
      const unavailable = strategyVaultExtension();
      unavailable.assets[0]!.routeReviews = [];
      unavailable.assets[0]!.retainedRoutes = [];
      expect(facts(unavailable).measuredUnwind).toMatchObject({ assessment: null, signals: ["wrapper-measured-unwind-unavailable"] });
    });
  });

  it("keeps a reviewed upgrade control known inside a partial inventory", () => {
    const fixed = exactFixedInput();
    const reviewed = reviewedUpgradeExtension();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    expect(compiled.controls.find((control) => control.controlKey === "upgrade:reviewed")?.status).toMatchObject({ observationState: "known", gapIds: [] });
    for (const key of ["bridge:unresolved", "mint:unresolved"]) expect(compiled.controls.find((control) => control.controlKey === key)?.status).toMatchObject({ observationState: "bounded-unknown" });
    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed), V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.control.reasons.map((reason) => reason.code)).not.toContain("missing-upgradeability-review");
    expect(evaluated.control.reasons.some((reason) => reason.path.includes("bridge:unresolved"))).toBe(true);
  });

  it("joins a capped minter only to a same-chain cap governor", () => {
    for (const [chain, state, capKind] of [["ethereum", "reviewed-controls", "raiseable"], ["arbitrum", "partially-reviewed-controls", "unknown"]] as const) {
      const fixed = exactFixedInput();
      const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(cappedMinterMeta(chain as "ethereum" | "arbitrum")) });
      expect(baseline.assets[0]!.controlReview).toMatchObject({ state });
      expect(controlsOf(baseline.assets[0]!)[0]).toMatchObject({ capSemantics: { kind: capKind } });
    }
  });

  it("does not infer upgradeability from an immutable mint path", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(immutableMintMeta()) });
    expect(baseline.assets[0]!.economicControlReview?.mint.upgrade).toEqual({ state: "unknown", controlKey: null });
  });

  it("keeps reviewed zero-share and empty bridge profiles fail-closed", () => {
    const native = { ...bridgeRoute("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), canonicalChain: "ethereum" };
    const lockMint = { ...bridgeRoute("base:0x3333333333333333333333333333333333333333", "reviewed"), sourceChain: "ethereum", canonicalChain: "ethereum", issuanceModel: "bridge-representation" as const, routeClass: "third-party" as const, riskTier: "external-lock-mint" as const, semantics: "lock-mint" as const, scope: "peripheral" as const };
    const fixed = exactFixedInput();
    const zero = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(bridgeMeta([native, lockMint])) });
    expect(zero.assets[0]!.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(controlsOf(zero.assets[0]!)[0]).toMatchObject({ materialSupplyShare: 0, capSemantics: { kind: "unbounded" } });
    const empty = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(bridgeMeta([], { tier: "opaque-or-unknown" })) });
    expect(empty.assets[0]!.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(empty.assets[0]!.controlReview).toMatchObject({ state: "partially-reviewed-controls", controls: [expect.objectContaining({ materialSupplyShare: 1 })] });
  });

  it("applies deployment and common-mode materiality boundaries", () => {
    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const below = materialityFixture(threshold - 0.001);
    expect(below.asset.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(controlsOf(below.asset).find((control) => control.deploymentKey.startsWith("polygon:"))).toMatchObject({ materialSupplyShare: threshold - 0.001, capSemantics: { kind: "unknown" } });
    expect(evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(below.fixed, below.extension), V9_CANDIDATE_POLICY_V1).assets[0]!.control.reasons.some((reason) => reason.path.includes("polygon:"))).toBe(false);
    for (const share of [threshold, threshold + 0.01, null]) {
      const fixture = materialityFixture(share);
      expect(fixture.asset.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
      expect(evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension), V9_CANDIDATE_POLICY_V1).assets[0]!.control.reasons.some((reason) => reason.code === "unresolved-control-identity")).toBe(true);
    }
  });

  it("exempts only complete independently subthreshold unmatched inventories", () => {
    const independent = unmatchedFixture({ ethereum: 0.9505, base: 0.0099, polygon: 0.0099, arbitrum: 0.0099, optimism: 0.0099, avalanche: 0.0099 }, []);
    expect(independent.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(controlsOf(independent.asset)).toHaveLength(0);
    const independentEvaluation = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(independent.fixed, independent.extension), V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(independentEvaluation.control.reasons.some((reason) => reason.code === "material-bridge-supply-unmatched")).toBe(false);
    const aggregate = unmatchedFixture({ ethereum: 0.5005, base: 0.0999, polygon: 0.0999, arbitrum: 0.0999, optimism: 0.0999, avalanche: 0.0999 }, []);
    expect(evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(aggregate.fixed, aggregate.extension), V9_CANDIDATE_POLICY_V1).assets[0]!.control.reasons.some((reason) => reason.code === "material-bridge-supply-unmatched")).toBe(true);
    const usdtShape = unmatchedFixture({ ethereum: 0.85, base: 0.1, Starknet: 0.05 }, [{ ...bridgeRoute("base:0x2222222222222222222222222222222222222222", "reviewed"), sourceChain: "ethereum", canonicalChain: "ethereum", issuanceModel: "bridge-representation", routeClass: "canonical", riskTier: "canonical-rollup-bridge", semantics: "lock-mint", scope: "peripheral" }]);
    expect(controlsOf(usdtShape.asset).find((control) => control.deploymentKey.startsWith("base:"))).toBeDefined();
    expect(unmatchedFixture({ ethereum: 0.9, base: 0.1 }).asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(unmatchedFixture({ ethereum: 0.9001, "Future Chain": 0.0499, future_chain: 0.05 }).asset.supplyReview?.selectedBridgeRoutes.find((route) => route.reviewState === "unmatched")).toMatchObject({ supplyShare: 0.0999 });
    expect(controlsOf(unmatchedFixture({ ethereum: 0.9, "Future Chain": 0.05, future_chain: 0.05 }).asset).some((control) => control.deploymentKey === "unmatched-chain-label-pool:alpha")).toBe(true);
    const ambiguous = unmatchedFixture({ ethereum: 0.95, base: 0.05 }, [bridgeRoute("base:0x2222222222222222222222222222222222222222"), bridgeRoute("base:0x3333333333333333333333333333333333333333")]);
    expect(ambiguous.asset.supplyReview?.selectedBridgeRoutes).toContainEqual(expect.objectContaining({ deploymentRouteKey: "ambiguous-chain:alpha:base" }));
    expect(unmatchedFixture({ ethereum: 1 }, [bridgeRoute("hyperevm:0x4444444444444444444444444444444444444444")]).asset.economicControlReview?.bridge.status.applicability.state).toBe("not-applicable");
    expect(unmatchedFixture({ ethereum: 1 }, [bridgeRoute("futurechain:0x5555555555555555555555555555555555555555")]).asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
  });

  it("does not let an unresolved access-only control contaminate the aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(accessOnlyMeta()) });
    expect(baseline.assets[0]!.controlReview).toMatchObject({ state: "reviewed-controls", controls: [expect.objectContaining({ economicLossScope: "access-only", authority: null })] });
  });

  it("rejects registry drift and future reviews before quarantining stale known evidence", () => {
    const fixed = exactFixedInput();
    expect(() => buildSafetyScoreV9BaselineExtension(fixed, { registryFingerprint: "f".repeat(64), metaById: metaMap(alphaMeta()) })).toThrow(/registry fingerprint/);
    expect(() => buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ blacklistabilityReview: { reviewedStatus: true, sourceFreeRationale: "Fixture-only review.", evidence: "Future review.", reviewer: "Fixture reviewer", reviewedAt: "2026-07-14" } })) })).toThrow(/later than the scoring clock/);
    const stale = strategyVaultExtension();
    stale.assets[0]!.researchEvidence = [{ evidenceKey: "stale-control-review", sourceId: "fixture.stale-control-review", observedAtSec: 8_000, publishedAtSec: null, url: "https://example.com/stale", contentSha256: "a".repeat(64), confidence: "verified", maxAgeSec: 500 }];
    stale.assets[0]!.componentEvidence = [{ componentKey: "control", evidenceKeys: ["stale-control-review"] }];
    const materialized = materializeSafetyScoreV9FactSetExtension(fixed, stale);
    expect(compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixed, materialized).quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed" }]);
  });

  it("exports stable reserve exposure identities for exact overlay joins", () => {
    const slice = exactFixedInput().liveReserveMap.alpha![0]!;
    expect(computeSafetyScoreV9ReserveExposureKey(slice)).toMatch(/^reserve:[a-f0-9]{24}$/);
    expect(computeSafetyScoreV9ReserveExposureKey({ ...slice, pct: 50 })).toBe(computeSafetyScoreV9ReserveExposureKey(slice));
    const keyed = { ...slice, sourceKey: "fixture:alpha:treasury" };
    expect(computeSafetyScoreV9ReserveExposureKey({ ...keyed, name: "Renamed treasury", pct: 5 })).toBe(computeSafetyScoreV9ReserveExposureKey(keyed));
  });
});
