import { expect, it } from "vitest";
import { evaluateV9Backing } from "../safety-score-v9/archetypes";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9FiatCashMechanismRiskReview, V9MechanismFactV1 } from "../../types/safety-score-v9-backing";
import { asset, exposure, knownStatus } from "./safety-score-v9-backing.test-support";

const unknown: V9MechanismFactV1 = { status: { ...knownStatus("evidence:searched", "mechanism.required"), observationState: "bounded-unknown", gapIds: ["gap:issuer-undisclosed"] }, quality: null, failureDomains: [] };
const strong: V9MechanismFactV1 = { status: knownStatus("evidence:claim", "mechanism.required"), quality: "strong", failureDomains: [] };
const reserve = asset([exposure({ key: "cash", weight: 1, policyRuleId: "mechanism.required" })], [], knownStatus("evidence:reserves", "mechanism.required"));
const baseline: V9FiatCashMechanismRiskReview = { archetype: "fiat-cash", claimAndSegregation: strong, custodyContinuity: strong, assuranceAndReconciliation: unknown };
function score(fact: V9MechanismFactV1, seasoned = false) {
  return evaluateV9Backing({ ...reserve, ...(seasoned ? { trackRecordMonths: 120 } : {}) }, { ...baseline, assuranceAndReconciliation: fact }, V9_CANDIDATE_POLICY_V1);
}
it("partial verified assurance cannot worsen unknown; unknown remainder keeps its charge and no seasoning", () => {
  const partial: V9MechanismFactV1 = { ...unknown, scopedAssessments: [
    { scopeId: "trust", share: 0.25, quality: "adequate", status: knownStatus("evidence:trust", "mechanism.required") },
    { scopeId: "remainder", share: 0.75, quality: null, status: unknown.status },
  ] };
  const before = score(unknown);
  const after = score(partial);
  expect(after.score!).toBeGreaterThan(before.score!);
  const fragments = after.contributions.filter(row => row.componentKey.includes(":scope:"));
  const covered = fragments.find(row => row.componentKey.endsWith(":trust"))!;
  const remainder = fragments.find(row => row.componentKey.endsWith(":remainder"))!;
  expect([covered.score, covered.observationState, remainder.score, remainder.observationState]).toEqual([87, "known", 35, "bounded-unknown"]);
  expect(covered.normalizedWeight / remainder.normalizedWeight).toBeCloseTo(1 / 3);
  expect(score(partial, true).score).toBe(after.score);
});
it("an adverse reviewed fragment lowers rather than hides its measured failure", () => {
  const adverse: V9MechanismFactV1 = { ...unknown, scopedAssessments: [
    { scopeId: "failed-book", share: 0.25, quality: "failed", status: knownStatus("evidence:failure", "mechanism.required") },
    { scopeId: "remainder", share: 0.75, quality: null, status: unknown.status },
  ] };
  expect(score(adverse).score!).toBeLessThan(score(unknown).score!);
});
