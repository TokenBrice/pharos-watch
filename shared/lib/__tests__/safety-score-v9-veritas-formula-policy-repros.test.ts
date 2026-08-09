/**
 * VERITAS formula / policy-rounding repros (VER-001, VER-002, VER-005 and the
 * VERITAS-II decimal-snap and bounded-state sweeps). Consolidated from five
 * single-incident files; each origin keeps its own fixture scope in a block so
 * every assertion and finding name survives verbatim.
 */
import { describe, expect, it } from "vitest";
import type {
  V9EvidenceLevel,
  V9MethodologyPolicy,
  V9ScoringInput,
} from "@shared/types/safety-score-v9";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "../safety-score-v9/facts";
import { scoreV9Input } from "../safety-score-v9/formula";
import {
  V9_CANDIDATE_POLICY_V1,
  loadV9MethodologyPolicy,
  resolveV9ReasonPolicy,
} from "../safety-score-v9/policy";

// Folded in from `safety-score-v9-veritas-cap-rounding-repro.test.ts` (VER-001).
{
  function input(exit: number): V9ScoringInput {
    return {
      assetId: "veritas-cap-rounding",
      pillars: { backing: 44.714375, exit, control: 95 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [],
    };
  }

  // VER-001 regression: replacing the fractional hard cap must retain monotonic
  // published rounding without a hidden cap boundary.
  describe("VERITAS finding VER-001: continuous aggregation remains monotonic across rounding", () => {
    it("publishes the continuously aggregated score without a compensability cap", () => {
      const trace = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);

      expect(trace.weightedQuality).toBe(64.7113);
      expect(trace.preCapScore).toBe(59.9449);
      expect(trace.caps.map((cap) => cap.kind)).not.toContain("bounded-compensability");
      expect(trace.finalScore).toBe(60);
      expect(trace.finalGrade).toBe("C+");
    });

    it("does not lower the published result when exit quality increases", () => {
      const before = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);
      const after = scoreV9Input(input(65.94), V9_CANDIDATE_POLICY_V1);

      expect(after.finalScore).toBeGreaterThanOrEqual(before.finalScore!);
      expect(after.finalGrade).toBe(before.finalGrade);
    });
  });
}

// Folded in from `safety-score-v9-veritas-half-rounding-repro.test.ts` (VER-002).
{
  // VER-002 regression: the ordinary weighted mean is diagnostic after the
  // continuous weakest-path selection; the published aggregate still uses the
  // same decimal-safe nearest rounding.
  describe("VERITAS finding VER-002: continuous aggregate rounds deterministically", () => {
    it("nearest-rounds the smooth aggregate independently of the weighted mean", () => {
      const input: V9ScoringInput = {
        assetId: "veritas-half-rounding",
        pillars: { backing: 42.91, exit: 70.96, control: 70 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [],
        unresolved: [],
      };

      const trace = scoreV9Input(input, V9_CANDIDATE_POLICY_V1);
      expect(trace.weightedQuality).toBe(59.5);
      expect(trace.aggregation?.score).toBe(56.5141);
      expect(trace.bindingCap).toBeNull();
      expect(trace.finalScore).toBe(57);
      expect(trace.finalGrade).toBe("C");
    });
  });
}

// Folded in from `safety-score-v9-veritas-policy-coupling-repro.test.ts` (VER-005).
{
  // VER-005: the policy validator checks grade bands and active-depeg caps
  // independently, so a band-only reanchor can contradict the caps' D/F contract.
  describe("VERITAS finding VER-005: active-depeg caps can cross their locked grade bands", () => {
    it("rejects grade thresholds that move the F and D depeg caps into higher grades", () => {
      const policy: V9MethodologyPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
      policy.semantic.formula.gradeThresholds.find((entry) => entry.grade === "C-")!.minScore = 44;
      policy.semantic.formula.gradeThresholds.find((entry) => entry.grade === "D")!.minScore = 36;

      expect(() => loadV9MethodologyPolicy(policy)).toThrow(/active-depeg.*grade band/i);
    });

    it.each([
      { thresholdGrade: "D", minScore: 36, capKind: "active-depeg:f", declaredGrade: "F" },
      { thresholdGrade: "C-", minScore: 44, capKind: "active-depeg:d", declaredGrade: "D" },
    ] as const)("validates $capKind against the $declaredGrade band", (fixture) => {
      const policy: V9MethodologyPolicy = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
      policy.semantic.formula.gradeThresholds.find((entry) => entry.grade === fixture.thresholdGrade)!.minScore =
        fixture.minScore;

      expect(() => loadV9MethodologyPolicy(policy)).toThrow(
        // eslint-disable-next-line security/detect-non-literal-regexp -- fragments come from the in-test it.each fixture constants, not user input.
        new RegExp(`${fixture.capKind}.*${fixture.declaredGrade} grade band`, "i"),
      );
    });
  });
}

// Folded in from `safety-score-v9-veritas-2-decimal-snap-repro.test.ts` (VERITAS-II decimal snapping).
{
  function score(pillars: { backing: number; exit: number; control: number }) {
    return scoreV9Input(
      {
        assetId: "veritas-ii-decimal-boundary",
        pillars,
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel: "strong",
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: [],
        unresolved: [],
      },
      V9_CANDIDATE_POLICY_V1,
    );
  }

  describe("VERITAS-II finding decimal snapping crosses genuine nearest and floor boundaries", () => {
    it("keeps a genuine below-half uncapped score below the nearest-integer boundary", () => {
      const belowHalf = 59.499_999_999_995;
      expect(belowHalf).toBeLessThan(59.5);
      expect(Math.round(belowHalf)).toBe(59);

      const trace = score({ backing: belowHalf, exit: belowHalf, control: belowHalf });

      expect(trace.finalScore).toBe(Math.round(belowHalf));
    });

    it("does not recreate a weakest-plus-headroom cap near an integer boundary", () => {
      const weakest = 39.999_999_999_995;
      const trace = score({ backing: weakest, exit: 100, control: 95 });

      expect(trace.bindingCap).toBeNull();
      expect(trace.caps.map((cap) => cap.kind)).not.toContain("bounded-compensability");
      expect(trace.aggregation?.method).toBe("smooth-bounded-headroom");
      expect(trace.preCapScore).toBe(58.7987);
      expect(trace.finalScore).toBe(59);
    });
  });
}

// Folded in from `safety-score-v9-veritas-bounded-invariants.test.ts` (VERITAS bounded-state invariants).
{
  function scoringInput(pillars: V9ScoringInput["pillars"], evidenceLevel: V9EvidenceLevel = "strong"): V9ScoringInput {
    return {
      assetId: "veritas-bounded-sweep",
      pillars,
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel,
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [{
        code: "no-viable-exit-path",
        reason: "VERITAS measured-adverse attribution fixture.",
        critical: false,
        responsibility: "measured-adverse",
      }],
    };
  }

  describe("VERITAS bounded-state invariants", () => {
    it("keeps evidence ceilings binding and evidence-strengthening monotone across pillar combinations", () => {
      for (let backing = 0; backing <= 100; backing += 5) {
        for (let exit = 0; exit <= 100; exit += 5) {
          for (let control = 0; control <= 100; control += 5) {
            const pillars = { backing, exit, control };
            const limited = scoreV9Input(scoringInput(pillars, "limited"), V9_CANDIDATE_POLICY_V1);
            const adequate = scoreV9Input(scoringInput(pillars, "adequate"), V9_CANDIDATE_POLICY_V1);
            const strong = scoreV9Input(scoringInput(pillars), V9_CANDIDATE_POLICY_V1);

            expect(limited.finalScore).not.toBeNull();
            expect(adequate.finalScore).not.toBeNull();
            expect(strong.finalScore).not.toBeNull();
            expect(limited.finalScore!).toBeLessThanOrEqual(69);
            expect(adequate.finalScore!).toBeLessThanOrEqual(84);
            expect(adequate.finalScore!).toBeGreaterThanOrEqual(limited.finalScore!);
            expect(strong.finalScore!).toBeGreaterThanOrEqual(adequate.finalScore!);
          }
        }
      }
    });

    it("executes every reason-registry treatment and keeps bounded missing or stale facts rateable", () => {
      for (const entry of V9_CANDIDATE_POLICY_V1.policy.reasonRegistry) {
        const resolved = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, entry.code);
        const input = scoringInput({ backing: 95, exit: 95, control: 95 });
        const responsibility = V9_LEGACY_RESPONSIBILITY_BY_REASON[entry.code];
        input.unresolved = [{
          code: entry.code,
          reason: "VERITAS treatment sweep.",
          critical: resolved.critical,
          responsibility,
        }];
        const trace = scoreV9Input(input, V9_CANDIDATE_POLICY_V1);

        const availabilityCannotBoundFact =
          entry.boundedness === "unbounded" &&
          responsibility !== "measured-adverse";
        if (entry.defaultTreatment === "NR" || availabilityCannotBoundFact) {
          expect(trace.finalGrade, entry.code).toBe("NR");
          expect(trace.nrReasons, entry.code).toContainEqual(expect.objectContaining({ code: entry.code }));
          continue;
        }

        expect(trace.finalGrade, entry.code).not.toBe("NR");
        if (entry.defaultTreatment === "ceiling") {
          expect(resolved.ceiling, entry.code).not.toBeNull();
          expect(trace.finalScore!, entry.code).toBeLessThanOrEqual(resolved.ceiling!.limit);
          expect(trace.caps, entry.code).toContainEqual(
            expect.objectContaining({ kind: resolved.ceiling!.kind, limit: resolved.ceiling!.limit }),
          );
        } else {
          expect(
            trace.caps.some((cap) => cap.kind === `reason:${entry.code}`),
            entry.code,
          ).toBe(false);
        }

        if (entry.defaultFactClass === "missing-global-bounded" || entry.defaultFactClass === "stale-bounded") {
          expect(resolved.disposition.rateability, entry.code).toBe("rateable");
        }
      }
    });

    it("never lowers a score when a bounded ceiling reason is resolved", () => {
      const ceilingReasons = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.filter(
        (entry) =>
          entry.defaultTreatment === "ceiling" &&
          (
            V9_LEGACY_RESPONSIBILITY_BY_REASON[entry.code] === "issuer-undisclosed" ||
            V9_LEGACY_RESPONSIBILITY_BY_REASON[entry.code] === "measured-adverse"
          ),
      );

      for (const entry of ceilingReasons) {
        const resolved = resolveV9ReasonPolicy(V9_CANDIDATE_POLICY_V1, entry.code);
        for (let score = 0; score <= 100; score += 1) {
          const completeInput = scoringInput({ backing: score, exit: score, control: score });
          const boundedInput = structuredClone(completeInput);
          boundedInput.unresolved = [
            ...completeInput.unresolved,
            {
              code: entry.code,
              reason: "VERITAS bounded evidence.",
              critical: resolved.critical,
              responsibility: V9_LEGACY_RESPONSIBILITY_BY_REASON[entry.code],
            },
          ];

          const bounded = scoreV9Input(boundedInput, V9_CANDIDATE_POLICY_V1);
          const complete = scoreV9Input(completeInput, V9_CANDIDATE_POLICY_V1);
          expect(complete.finalScore!, `${entry.code} at ${score}`).toBeGreaterThanOrEqual(bounded.finalScore!);
        }
      }
    });
  });
}
