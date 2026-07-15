import { describe, expect, it } from "vitest";
import type { V9MethodologyPolicy } from "@shared/types/safety-score-v9";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../safety-score-v9/policy";

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
