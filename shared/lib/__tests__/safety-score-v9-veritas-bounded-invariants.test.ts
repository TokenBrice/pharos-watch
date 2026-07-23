import { describe, expect, it } from "vitest";
import type { V9EvidenceLevel, V9ScoringInput } from "@shared/types/safety-score-v9";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "../safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1, resolveV9ReasonPolicy } from "../safety-score-v9/policy";

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

      const nonEconomic = (
        responsibility === "integration-missing" ||
        responsibility === "producer-failed" ||
        responsibility === "method-unsupported"
      );
      const nonEconomicWithhold = nonEconomic && (
        (responsibility !== "integration-missing" || resolved.critical) &&
        entry.defaultTreatment !== "diagnostic"
      );

      if (entry.defaultTreatment === "NR" || nonEconomicWithhold) {
        expect(trace.finalGrade, entry.code).toBe("NR");
        expect(trace.nrReasons, entry.code).toContainEqual(expect.objectContaining({ code: entry.code }));
        continue;
      }

      expect(trace.finalGrade, entry.code).not.toBe("NR");
      if (entry.defaultTreatment === "ceiling" && !nonEconomic) {
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
