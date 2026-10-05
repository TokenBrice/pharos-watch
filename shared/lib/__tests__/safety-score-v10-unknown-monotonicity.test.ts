import { describe, expect, it } from "vitest";
import { applyMergedMintSignals } from "@shared/lib/safety-score-v9/control-mint-grade";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import { deriveV9MintPosture } from "@shared/lib/safety-score-v9/control-primitives";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "@shared/lib/safety-score-v9/score";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import {
  makeDeploymentControl, makeEconomicControlArgs, makeEconomicControlFacts, makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";


// Minimal fixed-fact variants of the four replay counterexamples: seasoned,
// reconciled multisigs for FRAX/XUSD; positive non-exhaustive routes for hCHF/OUSG.
const fixtures = [
  { assetId: "frax-frax", backing: 49.88214976316884, exit: 67.55, quorum: 3 },
  { assetId: "xusd-babelfish", backing: 55.5922265625, exit: 52, quorum: 2 },
  { assetId: "hchf-hedera-swiss-franc", backing: 76.145, exit: 52, control: 90 },
  { assetId: "ousg-ondo-finance", backing: 77.78234466806647, exit: 56.57, control: 67 },
] as const;

describe("unknown policy rung isolation and capacity classification", () => {
  for (const fixture of fixtures) {
    it(`${fixture.assetId}: preserves supported quality under the admitted policy`, () => {
      const input = makeV9ProductionScoreInput({ assetId: fixture.assetId });
      input.pillars.backing = makeV9Pillar(fixture.backing);
      input.pillars.exit = makeV9Pillar(fixture.exit);
      if ("quorum" in fixture) {
        const mintControl = makeDeploymentControl("mint:reviewed", "mint", {
          authority: { authorityKey: "safe:reviewed", model: "multisig",
            threshold: { required: fixture.quorum, total: 5 } },
          capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
          modulesOrGuards: "none-detected",
        });
        const control = evaluateV9EconomicControl(makeEconomicControlArgs({
          policy: V9_CANDIDATE_POLICY_V1, facts: makeEconomicControlFacts([mintControl]), trackRecordMonths: 120,
          mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "continuous", supervision: "none" }),
        }));
        expect(control.score).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
        input.pillars.control = makeV9Pillar(control.score);
      } else {
        const route = fixture.assetId === "hchf-hedera-swiss-franc"
          ? makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" })
          : makeExitRoute({
            coverageClass: "exact-lower-bound", modelConfidence: "medium",
            access: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
            outputValueRetention: 0.9999, minRedeemUsd: 4999.99,
            capacityCurve: [{ requestedNotionalUsd: 25_000_000, maxCostBps: 200,
              executableUsd: 8_500_000.001329, completionRatio: 0.34000000005315995, executionCostBps: 0 }],
          });
        const exit = evaluateV9Exit({
          circulatingUsd: fixture.assetId === "hchf-hedera-swiss-franc" ? 20_000_000 : 500_000_000,
          routes: [route],
        }, V9_CANDIDATE_POLICY_V1);
        expect(exit.reasons).not.toContain("missing-same-notional-route");
        expect(exit.reasons).not.toContain("no-viable-exit-path");
        expect(exit.score).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
        input.pillars.control = makeV9Pillar(fixture.control);
        input.pillars.exit = makeV9Pillar(exit.score, { evidenceLevel: "adequate" });
      }
      const card = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
      expect(card.ratingStatus).toBe("rated");
      expect(card.nrReasons).toEqual([]);
    });
  }

  it.each(["not-applicable", "none", "unknown", "internal-ledger"] as const)(
    "%s reconciliation never routes known unbounded power through generic unknown quality", (reconciliation) => {
      const control = makeDeploymentControl("mint:known-adverse", "mint", {
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      });
      const mint = makeReviewedMintInput(control.controlKey, { reconciliation, supervision: "none" });
      const semantic = V9_CANDIDATE_POLICY_V1.policy.semantic;
      const posture = deriveV9MintPosture(control, mint, false, semantic);
      expect(posture).toBe("unbounded-adverse");
      expect(semantic.control.mintPostureQuality[posture]).toBe(25);
      for (const unresolvedControl of [
        null,
        { ...control, economicLossScope: "unknown" as const },
        { ...control, capSemantics: { kind: "unknown" as const, bound: null }, claimImpairment: "unknown" as const },
      ]) {
        const unresolvedPosture = deriveV9MintPosture(unresolvedControl, mint, false, semantic);
        expect(unresolvedPosture).toBe("unknown");
        expect(semantic.control.mintPostureQuality[unresolvedPosture]).toBe(50);
      }
    },
  );

  it("keeps known merged-credit headroom independent of the unknown mint rung", () => {
    const mintControl = makeDeploymentControl("mint:credit", "mint", {
      authority: { authorityKey: "contract:credit", model: "contract", threshold: null },
      modulesOrGuards: "none-detected",
    });
    for (const base of Object.entries(V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality)
      .filter(([posture]) => posture !== "unknown")
      .map(([, quality]) => quality)) {
      const controlPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy.semantic.control);
      controlPolicy.mintMergedSignals.modulesOrGuardsAdjustment.noneDetectedCredit = 10;
      const baseline = applyMergedMintSignals(base, mintControl, undefined, controlPolicy);
      for (let floor = 0; floor <= 100; floor++) {
        controlPolicy.mintPostureQuality.unknown = floor;
        expect(applyMergedMintSignals(base, mintControl, undefined, controlPolicy)).toBe(baseline);
      }
    }
  });

  it.each([0, 1_000_000])("keeps $%s lower-bound capacity distinct from measured exhaustion", (executableUsd) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000,
      routes: [makeExitRoute({ coverageClass: "exact-lower-bound",
        capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
          executableUsd, completionRatio: executableUsd / 1_000_000, executionCostBps: 0 }],
      })],
    }, V9_CANDIDATE_POLICY_V1);
    if (executableUsd === 0) expect(result.reasons).toContain("missing-same-notional-route");
    else expect(result.reasons).not.toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it("keeps diagnostic missing-route evidence visible alongside measured zero capacity", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
      makeExitRoute({ capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
        executableUsd: 0, completionRatio: 0, executionCostBps: 0 }] }),
      makeExitRoute({ routeKey: "redemption:unmeasured", coverageClass: "exact-lower-bound", capacityCurve: [] }),
    ] }, V9_CANDIDATE_POLICY_V1);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it("does not turn an excluded alternative into a missing positive portfolio claim", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
      makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" }),
      makeExitRoute({ routeKey: "redemption:unproven", settlementBoundUnproven: true }),
    ] }, V9_CANDIDATE_POLICY_V1);
    expect(result.reasons).not.toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("unproven-settlement-bound");
    expect(result.routes.find((route) => route.routeKey === "redemption:unproven")?.exclusionReason)
      .toBe("unproven-settlement-bound");
  });

  it("does not let bounded uncertainty soften measured complete-route exhaustion", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [makeExitRoute({
      capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
        executableUsd: 0, completionRatio: 0, executionCostBps: 0 }],
    })] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(0);
    expect(result.reasons).toContain("no-viable-exit-path");
  });
});
