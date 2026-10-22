import { describe, expect, it } from "vitest";
import { gradeEconomicControlAuthority } from "@shared/lib/safety-score-v9/control-mint-grade";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { unknownQuality, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "@shared/lib/safety-score-v9/score";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import {
  makeDeploymentControl, makeEconomicControlArgs, makeEconomicControlFacts, makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";


// Fixed-fact variants exercise ordinary reconciled quorums and lower-bound routes.
const fixtures = [
  { assetId: "synthetic-quorum-alpha", backing: 49.88, exit: 67.55, quorum: 3 },
  { assetId: "synthetic-quorum-beta", backing: 55.59, exit: 52, quorum: 2 },
  { assetId: "synthetic-route-alpha", backing: 76.145, exit: 52, control: 90 },
  { assetId: "synthetic-route-beta", backing: 77.78, exit: 56.57, control: 67 },
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
          policy: V9_CANDIDATE_POLICY_V1, facts: makeEconomicControlFacts([mintControl]),
          mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "continuous", supervision: "none" }),
        }));
        expect(control.score).toBeGreaterThan(unknownQuality("control", "U"));
        input.pillars.control = makeV9Pillar(control.score);
      } else {
        const route = fixture.assetId === "synthetic-route-alpha"
          ? makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" })
          : makeExitRoute({
            coverageClass: "exact-lower-bound", modelConfidence: "medium",
            access: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
            outputValueRetention: 0.9999, minRedeemUsd: 4999.99,
            capacityCurve: [{ requestedNotionalUsd: 25_000_000, maxCostBps: 200,
              executableUsd: 8_500_000.001329, completionRatio: 0.34000000005315995, executionCostBps: 0 }],
          });
        const exit = evaluateV9Exit({
          circulatingUsd: fixture.assetId === "synthetic-route-alpha" ? 20_000_000 : 500_000_000,
          routes: [route],
        }, V9_CANDIDATE_POLICY_V1);
        expect(exit.reasons).not.toContain("missing-same-notional-route");
        expect(exit.reasons).not.toContain("no-viable-exit-path");
        expect(exit.score).toBeGreaterThan(unknownQuality("exit", "U"));
        input.pillars.control = makeV9Pillar(fixture.control);
        input.pillars.exit = makeV9Pillar(exit.score, { evidenceLevel: "adequate" });
      }
      const card = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
      expect(card.ratingStatus).toBe("rated");
      expect(card.nrReasons).toEqual([]);
    });
  }

  it.each(["not-applicable", "none", "unknown", "internal-ledger"] as const)(
    "%s reconciliation leaves a verified quorum's independent topology intact", (reconciliation) => {
      const control = makeDeploymentControl("mint:known", "mint", {
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
      });
      const mint = makeReviewedMintInput(control.controlKey, { reconciliation, supervision: "none" });
      const semantic = V9_CANDIDATE_POLICY_V1.policy.semantic;
      expect(gradeEconomicControlAuthority(control, mint, semantic)).toBe(65);
      expect(gradeEconomicControlAuthority({ ...control, capSemantics: { kind: "unknown", bound: null } }, mint, semantic)).toBe(65);
      expect(gradeEconomicControlAuthority({ ...control, incidentState: "active" }, mint, semantic)).toBe(25);
    },
  );

  it("does not use an unknown subfactor constant to reprice a verified quorum", () => {
    const control = makeDeploymentControl("mint:known", "mint");
    const mint = makeReviewedMintInput(control.controlKey);
    const semantic = structuredClone(V9_CANDIDATE_POLICY_V1.policy.semantic);
    const baseline = gradeEconomicControlAuthority(control, mint, semantic);
    for (const quality of [0, 35, 50, 60, 90]) {
      semantic.unknownQuality.control.U = quality;
      expect(gradeEconomicControlAuthority(control, mint, semantic)).toBe(baseline);
    }
  });

  it.each([1_000_000])("keeps $%s lower-bound capacity distinct from measured exhaustion", (executableUsd) => {
      const result = evaluateV9Exit({ circulatingUsd: 20_000_000,
        routes: [makeExitRoute({ coverageClass: "exact-lower-bound",
          capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
            executableUsd, completionRatio: executableUsd / 1_000_000, executionCostBps: 0 }],
        })],
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.reasons).not.toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("no-viable-exit-path");
    });

  it("preserves measured zero capacity while keeping unmeasured alternatives diagnostic", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
      makeExitRoute({ capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
        executableUsd: 0, completionRatio: 0, executionCostBps: 0 }] }),
      makeExitRoute({ routeKey: "redemption:unmeasured", coverageClass: "exact-lower-bound", capacityCurve: [] }),
    ] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(0);
    expect(result.routes[0]).toMatchObject({ included: true, score: 0 });
    expect(result.routes.find(route => route.routeKey === "redemption:unmeasured")).toMatchObject({
      included: false, capacityPoint: null, exclusionReason: "incomparable-route-requests",
    });
  });

  it("admits a bounded-terms alternative without inventing a known settlement factor", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
      makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" }),
      makeExitRoute({ routeKey: "redemption:unproven", settlementBoundUnproven: true }),
    ] }, V9_CANDIDATE_POLICY_V1);
    expect(result.reasons).not.toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("unproven-settlement-bound");
    const bounded = result.routes.find(route => route.routeKey === "redemption:unproven")!;
    expect(bounded).toMatchObject({
      included: true, exclusionReason: null, components: { settlement: unknownQuality("exit", "U") },
    });
    expect(bounded.score).toBeLessThanOrEqual(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedTermsRecoveryCeiling);
  });

});
