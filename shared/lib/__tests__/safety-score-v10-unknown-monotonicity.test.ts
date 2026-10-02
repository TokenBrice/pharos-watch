import { describe, expect, it } from "vitest";
import { applyMergedMintSignals } from "@shared/lib/safety-score-v9/control-mint-grade";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "@shared/lib/safety-score-v9/score";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import {
  makeDeploymentControl, makeEconomicControlArgs, makeEconomicControlFacts, makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

const unknownKnobs = ["mint-posture", "control-bounded", "exit-bounded"] as const;
const variants = Object.fromEntries(unknownKnobs.map((knob) => [knob,
  Array.from({ length: 101 }, (_, value) => {
    const policy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    if (knob === "mint-posture") policy.semantic.control.mintPostureQuality.unknown = value;
    if (knob === "control-bounded") policy.semantic.control.boundedUnknownQuality = value;
    if (knob === "exit-bounded") policy.semantic.exit.boundedUnknownScore = value;
    return loadV9MethodologyPolicy(policy);
  }),
]));

// Minimal fixed-fact variants of the four replay counterexamples: seasoned,
// reconciled multisigs for FRAX/XUSD; positive non-exhaustive routes for hCHF/OUSG.
const fixtures = [
  { assetId: "frax-frax", backing: 49.88214976316884, exit: 67.55, quorum: 3 },
  { assetId: "xusd-babelfish", backing: 55.5922265625, exit: 52, quorum: 2 },
  { assetId: "hchf-hedera-swiss-franc", backing: 76.145, exit: 52, control: 90 },
  { assetId: "ousg-ondo-finance", backing: 77.78234466806647, exit: 56.57, control: 67 },
] as const;

describe("unknown policy rung monotonicity with fixed asset facts", () => {
  for (const fixture of fixtures) {
    it.each(unknownKnobs)(`${fixture.assetId}: raising %s never lowers the card`, (knob) => {
      let previousScore = -Infinity;
      let previousPillar = -Infinity;
      for (const envelope of variants[knob]!) {
        const input = makeV9ProductionScoreInput({ assetId: fixture.assetId });
        input.pillars.backing = makeV9Pillar(fixture.backing);
        input.pillars.exit = makeV9Pillar(fixture.exit);
        let affectedPillar: number;
        if ("quorum" in fixture) {
          const mintControl = makeDeploymentControl("mint:reviewed", "mint", {
            authority: { authorityKey: "safe:reviewed", model: "multisig",
              threshold: { required: fixture.quorum, total: 5 } },
            capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
            modulesOrGuards: "none-detected",
          });
          const control = evaluateV9EconomicControl(makeEconomicControlArgs({
            policy: envelope, facts: makeEconomicControlFacts([mintControl]), trackRecordMonths: 120,
            mint: makeReviewedMintInput(mintControl.controlKey, { reconciliation: "continuous", supervision: "none" }),
          }));
          affectedPillar = control.score!;
          input.pillars.control = makeV9Pillar(control.score);
        } else {
          const routes = [fixture.assetId === "hchf-hedera-swiss-franc"
            ? makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" })
            : makeExitRoute({
              coverageClass: "exact-lower-bound", modelConfidence: "medium",
              access: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
              outputValueRetention: 0.9999, minRedeemUsd: 4999.99,
              capacityCurve: [{ requestedNotionalUsd: 25_000_000, maxCostBps: 200,
                executableUsd: 8_500_000.001329, completionRatio: 0.34000000005315995, executionCostBps: 0 }],
            })];
          const exit = evaluateV9Exit({ circulatingUsd: fixture.assetId === "hchf-hedera-swiss-franc"
            ? 20_000_000 : 500_000_000, routes }, envelope);
          affectedPillar = exit.score!;
          input.pillars.control = makeV9Pillar(fixture.control);
          input.pillars.exit = makeV9Pillar(exit.score, { evidenceLevel: "adequate", reasons: exit.reasons.map((code) => ({
            code, path: "exit:portfolio", message: "Non-exhaustive route evidence", responsibility: "issuer-undisclosed",
          })) });
        }
        const card = scoreV9EvaluatedAsset(input, envelope);
        expect(affectedPillar).toBeGreaterThanOrEqual(previousPillar);
        expect(card.finalScore).not.toBeNull();
        expect(card.finalScore!).toBeGreaterThanOrEqual(previousScore);
        previousPillar = affectedPillar;
        previousScore = card.finalScore!;
      }
    });
  }

  it.each(["mint-posture", "control-bounded"] as const)("merged credits grade known postures independently of %s", (knob) => {
    const mintControl = makeDeploymentControl("mint:credit", "mint", {
      authority: { authorityKey: "contract:credit", model: "contract", threshold: null },
      modulesOrGuards: "none-detected",
    });
    for (const base of Object.entries(V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality)
      .filter(([posture]) => posture !== "unknown").map(([, quality]) => quality)) {
      let previous = -Infinity;
      for (const envelope of variants[knob]!) {
        // Exercise the supported positive-credit lane even while current merged
        // credit is zero; the seasoned-credit lane above uses current policy.
        const controlPolicy = structuredClone(envelope.policy.semantic.control);
        controlPolicy.mintMergedSignals.modulesOrGuardsAdjustment.noneDetectedCredit = 10;
        const score = applyMergedMintSignals(base, mintControl, undefined, controlPolicy);
        if (Number.isFinite(previous)) expect(score).toBe(previous);
        previous = score;
      }
    }
  });

  it.each([0, 1_000_000])("classifies $%s lower-bound capacity independently of the floor", (executableUsd) => {
    for (const envelope of variants["exit-bounded"]!) {
      const result = evaluateV9Exit({ circulatingUsd: 20_000_000,
        routes: [makeExitRoute({ coverageClass: "exact-lower-bound",
          capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
            executableUsd, completionRatio: executableUsd / 1_000_000, executionCostBps: 0 }],
        })],
      }, envelope);
      if (executableUsd === 0) expect(result.reasons).toContain("missing-same-notional-route");
      else expect(result.reasons).not.toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("no-viable-exit-path");
    }
  });

  it("keeps an actual diagnostic missing-route gap visible above and below the floor", () => {
    for (const envelope of variants["exit-bounded"]!) {
      const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
        makeExitRoute({ capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
          executableUsd: 0, completionRatio: 0, executionCostBps: 0 }] }),
        makeExitRoute({ routeKey: "redemption:unmeasured", coverageClass: "exact-lower-bound", capacityCurve: [] }),
      ] }, envelope);
      expect(result.reasons).toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("no-viable-exit-path");
    }
  });

  it("does not turn an excluded alternative into a missing positive portfolio claim at any floor", () => {
    for (const envelope of variants["exit-bounded"]!) {
      const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [
        makeExitRoute({ coverageClass: "exact-lower-bound", feeEvidence: "disclosed-unquantified" }),
        makeExitRoute({ routeKey: "redemption:unproven", settlementBoundUnproven: true }),
      ] }, envelope);
      expect(result.reasons).not.toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("unproven-settlement-bound");
      expect(result.routes.find((route) => route.routeKey === "redemption:unproven")?.exclusionReason)
        .toBe("unproven-settlement-bound");
    }
  });

  it("does not let an unknown floor soften measured complete-route exhaustion", () => {
    for (const envelope of variants["exit-bounded"]!) {
      const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [makeExitRoute({
        capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
          executableUsd: 0, completionRatio: 0, executionCostBps: 0 }],
      })] }, envelope);
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual(["no-viable-exit-path"]);
    }
  });
});
