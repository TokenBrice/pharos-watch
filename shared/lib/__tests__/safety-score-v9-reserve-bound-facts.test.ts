import { describe, expect, it } from "vitest";
import { ReserveBoundedFactSchema, type ReserveBoundedFact, type V9ReserveBoundedFact } from "../../types/reserve-bounded-facts";
import { reserveBoundTermDays, evaluateV9ReserveEligibilityEnvelope, resolveV9ReserveFactorBounds } from "../safety-score-v9/reserve-bound-facts";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { asset, exposure, knownStatus } from "./safety-score-v9-backing.test-support";
import type { V9FactGapV3 } from "../../types/safety-score-v9-facts";
const clock = 1790849876;
const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
const base = { factKey: "bound", scope: { kind: "exposure" as const, exposureKey: "reserve:test" }, asOfSec: clock, publisher: "fixture", sourceUrls: ["https://example.com/primary"], assertion: "pinned claim", contentDigest: "a".repeat(64), provenance: { kind: "reviewed-research" as const, reviewedAt: "2026-09-30", reviewer: "fixture", confidence: "high" as const } };
function compiled(fact: ReserveBoundedFact): V9ReserveBoundedFact { return { fact, status: knownStatus("evidence:bound"), sourceGenerationId: "fixture:generation", freshnessMaxAgeSec: 10800, rejectionReason: null }; }
function liquid(amount = 50): ReserveBoundedFact { return ReserveBoundedFactSchema.parse({ ...base, kind: "currently-liquid-fraction", assetId: "usdc-circle", unit: "USDC", chain: "ethereum", currentlyWithdrawable: amount, totalHeld: 100, snapshotAtSec: clock, availabilityMeaning: "currently-withdrawable-native-asset" }); }
const reserve = { ...exposure({ key: "reserve:test", weight: 1, assetClass: "government-security" }), liquidityHorizon: "unknown" as const };
describe("bounded reserve facts", () => {
  it("improves only the evidenced liquidity factor and preserves failure domains and concentration", () => {
    const baseline = evaluateV9ReserveExposures({ ...asset([reserve]), asOfSec: clock }, V9_CANDIDATE_POLICY_V1);
    const bounded = evaluateV9ReserveExposures({ ...asset([reserve]), asOfSec: clock, reserveBoundFacts: [compiled(liquid())] }, V9_CANDIDATE_POLICY_V1);
    expect(bounded.score).toBeGreaterThan(baseline.score!);
    const original = baseline.contributions.find((row) => row.source === "reserve-exposure")!;
    const improved = bounded.contributions.find((row) => row.source === "reserve-exposure")!;
    const weights = policy.reserve.factorWeights;
    expect(improved.score! - original.score!).toBeCloseTo(0.5 * (policy.componentQuality.limited - policy.reserve.liquidityQuality.unknown) * weights.liquidity / (weights.assetQuality + weights.liquidity + weights.maturity));
    expect(improved.failureDomains).toEqual(original.failureDomains);
    expect(bounded.contributions.find((row) => row.source === "reserve-concentration")).toEqual(baseline.contributions.find((row) => row.source === "reserve-concentration"));
    expect(improved.evidenceRefIds).toContain("evidence:bound");
  });
  it("admits only an evidenced liquid fraction when the remaining horizon is pipeline-failed", () => {
    const gap: V9FactGapV3 = {
      gapId: "gap:liquidity", ownerDomain: "backing", policyRuleId: "reserve.liquidity",
      observationState: "missing", reasonCode: "bounded-unknown-reserve-exposure",
      path: { kind: "local-component", componentKey: "liquidity" },
      message: "The remaining horizon reader failed", evidenceRefIds: [], responsibility: "producer-failed",
      causeProof: { cause: "A", producerState: "producer-failed", sourceId: "reader",
        sourceGenerationId: "fixture:generation", observedAtSec: clock, rejectionCode: "read-failed", evidenceRefIds: ["attempt:generation"] },
    };
    const row = { ...reserve, factorStatuses: { liquidity: {
      ...knownStatus("horizon"), observationState: "missing" as const, gapIds: [gap.gapId],
    } } };
    const result = evaluateV9ReserveExposures({ ...asset([row], [gap]), asOfSec: clock,
      reserveBoundFacts: [compiled(liquid(50))] }, V9_CANDIDATE_POLICY_V1);
    const contribution = result.contributions.find(entry => entry.componentKey === `reserve:${row.exposureKey}`)!;
    const factor = contribution.factors!.find(entry => entry.componentKey.endsWith(":liquidity:covered"))!;
    const omitted = contribution.factors!.find(entry => entry.componentKey.endsWith(":liquidity:uncovered"))!;
    expect(contribution.wholeAssetWeight).toBe(1);
    expect(factor).toMatchObject({ score: 60, normalizedWeight: 0.15, cause: null });
    expect(omitted).toMatchObject({ score: null, normalizedWeight: 0.15, effectiveScoringWeight: 0, cause: "A" });
    expect(factor.effectiveScoringWeight).toBeCloseTo(0.15 / 0.85, 12);
    expect(contribution.score).toBeCloseTo((policy.reserve.assetClassQuality["government-security"] * 0.55 + 60 * 0.15 + 48 * 0.15) / 0.85, 12);
    expect(result.structuralReasons.filter(entry => entry.kind === "unsafe-backing")).toEqual([]);
  });
  it("retains the actual covered grade for positive dust instead of cancelling it against the unknown baseline", () => {
    const result = evaluateV9ReserveExposures({ ...asset([reserve]), asOfSec: clock,
      reserveBoundFacts: [compiled(liquid(1e-18))] }, V9_CANDIDATE_POLICY_V1);
    const covered = result.contributions.find(row => row.source === "reserve-exposure")!.factors!
      .find(row => row.componentKey.endsWith(":liquidity:covered"))!;
    expect(covered.score).toBe(policy.componentQuality.limited);
    expect(covered.normalizedWeight).toBeCloseTo(0.3e-20, 35);
    expect(covered.effectiveScoringWeight).toBeGreaterThan(0);
  });
  it("does not renew stale snapshots, grant future observations, or double credit known horizons", () => {
    for (const asOfSec of [clock - 10801, clock + 1]) {
      const fact = compiled(liquid()); fact.fact.asOfSec = asOfSec;
      expect(resolveV9ReserveFactorBounds(reserve, [fact], policy, clock, { liquidity: 45, maturity: 45 }).liquidity).toBe(45);
    }
    const current = compiled(liquid(100));
    expect(resolveV9ReserveFactorBounds({ ...reserve, liquidityHorizon: "one-day" }, [current], policy, clock, { liquidity: 95, maturity: 45 }).liquidity).toBe(95);
    expect(resolveV9ReserveFactorBounds(reserve, [compiled(liquid(0))], policy, clock, { liquidity: 45, maturity: 45 }).liquidity).toBe(45);
  });
  it("rejects invalid ratios and mismatched snapshots rather than clamping", () => {
    expect(() => liquid(101)).toThrow();
    expect(ReserveBoundedFactSchema.safeParse({ ...liquid(), totalHeld: 0 }).success).toBe(false);
    expect(ReserveBoundedFactSchema.safeParse({ ...liquid(), snapshotAtSec: clock - 1 }).success).toBe(false);
  });
  it("keeps unweighted subinstrument constraints diagnostic and calendar months conservative", () => {
    expect(reserveBoundTermDays({ value: 3, unit: "calendar-months" })).toBe(92);
    const fact = ReserveBoundedFactSchema.parse({ ...base, kind: "contractual-maturity-maximum", claimId: "direct-bill", legallyBinding: true, allInScope: true, maximumTerm: { value: 3, unit: "calendar-months" }, scope: { kind: "sub-instrument", exposureKey: reserve.exposureKey, instrumentId: "bill", coveredShare: null, coverageAsOfSec: clock } });
    expect(resolveV9ReserveFactorBounds(reserve, [compiled(fact)], policy, clock, { liquidity: 45, maturity: 45 }).maturity).toBe(45);
    const covered = { ...fact, scope: { ...fact.scope, coveredShare: 0.5 } } as ReserveBoundedFact;
    expect(resolveV9ReserveFactorBounds(reserve, [compiled(covered)], policy, clock, { liquidity: 45, maturity: 45 }).maturity).toBeGreaterThan(45);
  });
  it("uses reconciled observed coverage without laundering observations into covenants", () => {
    const observed = ReserveBoundedFactSchema.parse({ ...base, kind: "observed-portfolio-maturity", coveredGrossValue: 50, totalGrossValue: 100, coverageAsOfSec: clock, denomination: "USD", observedMaximumDays: 30, instruments: [{ instrumentId: "bill", maturityAtSec: clock + 30 * 86400, grossMarkedValue: 50, denomination: "USD" }] });
    const quality = resolveV9ReserveFactorBounds(reserve, [compiled(observed)], policy, clock, { liquidity: 45, maturity: 45 }).maturity;
    expect(quality).toBe(45 + 0.5 * (policy.componentQuality.limited - 45));
    expect(resolveV9ReserveFactorBounds({ ...reserve, maturityDaysMax: 30 }, [compiled(observed)], policy, clock, { liquidity: 45, maturity: 94 }).maturity).toBe(94);
    expect(resolveV9ReserveFactorBounds({ ...reserve, assetClass: "cash" }, [compiled(observed)], policy, clock, { liquidity: 45, maturity: 100 }).maturity).toBe(100);
    const diagnostic = { ...observed, coveredGrossValue: null, totalGrossValue: null } as ReserveBoundedFact;
    expect(resolveV9ReserveFactorBounds(reserve, [compiled(diagnostic)], policy, clock, { liquidity: 45, maturity: 45 }).maturity).toBe(45);
    const adverse = { ...observed, observedMaximumDays: 10000, instruments: [{ instrumentId: "clo", maturityAtSec: clock + 10000 * 86400, grossMarkedValue: 50, denomination: "USD" }] } as ReserveBoundedFact;
    const contract = ReserveBoundedFactSchema.parse({ ...base, factKey: "contract", kind: "contractual-maturity-maximum", claimId: "bill", legallyBinding: true, allInScope: true, maximumTerm: { value: 30, unit: "days" } });
    const contradiction = resolveV9ReserveFactorBounds(reserve, [compiled(contract), compiled(adverse)], policy, clock, { liquidity: 45, maturity: 45 });
    expect(contradiction.contradiction).toBe(true);
    expect(contradiction.maturity).toBe(45 + 0.5 * (48 - 45));
    expect(resolveV9ReserveFactorBounds({ ...reserve, maturityDaysMax: 30 }, [compiled(adverse)], policy, clock, { liquidity: 45, maturity: 94 }).maturity).toBeLessThan(94);
  });
  it("solves the worst feasible envelope without inventing actual composition", () => {
    const envelope = ReserveBoundedFactSchema.parse({ ...base, kind: "eligibility-envelope", scope: { kind: "reserve-envelope" }, legallyBinding: true, exhaustive: true, allocations: [{ assetClass: "cash", minShare: 0.2, maxShare: 1, maximumTerm: null }, { assetClass: "bank-deposit", minShare: 0, maxShare: 0.8, maximumTerm: null }] });
    const result = evaluateV9ReserveEligibilityEnvelope([compiled(envelope)], policy, clock)!;
    const weights = policy.reserve.factorWeights, total = weights.assetQuality + weights.liquidity + weights.maturity;
    const expected = (0.2 * (policy.reserve.assetClassQuality.cash * weights.assetQuality + policy.reserve.liquidityQuality.unknown * weights.liquidity + 100 * weights.maturity) + 0.8 * (policy.reserve.assetClassQuality["bank-deposit"] * weights.assetQuality + policy.reserve.liquidityQuality.unknown * weights.liquidity + policy.reserve.maturityUnknownQuality * weights.maturity)) / total;
    expect(result.quality).toBeCloseTo(expected);
    expect(evaluateV9ReserveEligibilityEnvelope([compiled({ ...envelope, exhaustive: false } as ReserveBoundedFact)], policy, clock)).toBeNull();
    expect(ReserveBoundedFactSchema.safeParse({ ...envelope, allocations: [{ assetClass: "cash", minShare: 0.6, maxShare: 0.5, maximumTerm: null }] }).success).toBe(false);
  });
  it("never adds overlapping fractions or worsens an existing positive lower bound", () => {
    const whole = compiled(liquid(50));
    const sub = compiled(ReserveBoundedFactSchema.parse({
      ...liquid(100), factKey: "sub",
      scope: { kind: "sub-instrument", exposureKey: reserve.exposureKey, instrumentId: "idle", coveredShare: 0.2, coverageAsOfSec: clock },
    }));
    const baseline = { liquidity: 45, maturity: 45 };
    const before = resolveV9ReserveFactorBounds(reserve, [whole], policy, clock, baseline);
    const after = resolveV9ReserveFactorBounds(reserve, [whole, sub], policy, clock, baseline);
    expect(after.liquidity).toBe(before.liquidity);
    const conflict = compiled({ ...liquid(100), factKey: "conflict" });
    expect(resolveV9ReserveFactorBounds(reserve, [whole, conflict], policy, clock, baseline).liquidity).toBe(45);
  });
});
