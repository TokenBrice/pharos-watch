import { describe, expect, it } from "vitest";
import { ReserveBoundedFactSchema, type ReserveBoundedFact } from "@shared/types/reserve-bounded-facts";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9ReserveBoundFacts } from "../safety-score-v9/extension-reserve-bounds";
const clock = 1790849876;
const metaById = new Map<string, V9ExtensionRegistryMeta>([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }], ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }]]);
function research(overrides: Record<string, unknown> = {}): ReserveBoundedFact {
  return ReserveBoundedFactSchema.parse({ factKey: "envelope", kind: "eligibility-envelope", scope: { kind: "reserve-envelope" }, asOfSec: clock - 86400, publisher: "issuer", sourceUrls: ["https://example.com/terms"], assertion: "Exhaustive governing terms", contentDigest: "a".repeat(64), provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-09-30", confidence: "high" }, legallyBinding: true, exhaustive: true, allocations: [{ assetClass: "cash", minShare: 0, maxShare: 1, maximumTerm: null }], ...overrides });
}
function compile(fact?: ReserveBoundedFact) {
  const fixed = makeV9TwoAssetFixedInput({ clockSec: clock, omitAlphaReserve: true });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
  if (fact) extension.assets.find((row) => row.assetId === "alpha")!.reserveBoundFacts = [fact];
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets.find((row) => row.assetId === "alpha")!;
}
describe("reserve bound compiler admission", () => {
  it("rejects live rows that impersonate reviewed research", () => {
    expect(() => buildSafetyScoreV9ReserveBoundFacts("alpha", [{
      name: "Cash", pct: 100, risk: "very-low", sourceKey: "reserve:cash", boundedFacts: [research()],
    }])).toThrow("Live bounds cannot impersonate reviewed research");
  });
  it("admits an independent envelope without inventing composition or withdrawing its charge", () => {
    const baseline = compile(), admitted = compile(research());
    expect(admitted.reserveExposures).toEqual([]);
    expect(admitted.reserveStatus).toEqual(baseline.reserveStatus);
    expect(admitted.gaps.filter((gap) => admitted.reserveStatus.gapIds.includes(gap.gapId))).toEqual(baseline.gaps.filter((gap) => baseline.reserveStatus.gapIds.includes(gap.gapId)));
    expect(admitted.reserveBoundFacts?.[0]?.status.observationState).toBe("known");
    const before = evaluateV9ReserveExposures({ ...baseline, resolvedUpstreamExposures: [], asOfSec: clock }, V9_CANDIDATE_POLICY_V1);
    const after = evaluateV9ReserveExposures({ ...admitted, resolvedUpstreamExposures: [], asOfSec: clock }, V9_CANDIDATE_POLICY_V1);
    expect(after.score).toBeGreaterThanOrEqual(before.score!);
    expect(after.unresolved).toEqual(before.unresolved);
  });
  it("a fresh review cannot renew old composition and a same-day review is not elapsed", () => {
    const source = research();
    if (source.kind !== "eligibility-envelope") throw new Error("Invalid fixture kind");
    const { kind: _kind, legallyBinding: _binding, exhaustive: _exhaustive, allocations: _allocations, ...base } = source;
    const observed = ReserveBoundedFactSchema.parse({ ...base, kind: "observed-portfolio-maturity", asOfSec: clock - 2678400 - 604800 - 1, coveredGrossValue: 100, totalGrossValue: 100, coverageAsOfSec: clock - 2678400 - 604800 - 1, denomination: "USD", observedMaximumDays: 30, instruments: [{ instrumentId: "bill", maturityAtSec: clock + 30 * 86400, grossMarkedValue: 100, denomination: "USD" }] });
    expect(compile(observed).reserveBoundFacts?.[0]?.rejectionReason).toBe("snapshot-stale");
    expect(compile(research({ provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-10-01", confidence: "high" } })).reserveBoundFacts?.[0]?.rejectionReason).toBe("review-day-not-elapsed");
  });
  it("rejects unmatched exact keys and future source clocks", () => {
    const unmatched = compile(research({ scope: { kind: "exposure", exposureKey: "missing:key" } }));
    expect(unmatched.reserveBoundFacts?.[0]?.rejectionReason).toBe("scope-unmatched");
    const future = compile(research({ asOfSec: clock + 1 }));
    expect(future.reserveBoundFacts?.[0]?.rejectionReason).toBe("snapshot-future");
    expect(future.reserveExposures).toEqual([]);
  });
  it("isolates equal-generation contradictory bounds to the affected asset", () => {
    const fixed = makeV9TwoAssetFixedInput({ clockSec: clock });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const baseline = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    extension.assets.find((row) => row.assetId === "alpha")!.reserveBoundFacts = [research(), research({ factKey: "conflicting", allocations: [{ assetClass: "bank-deposit", minShare: 0, maxShare: 1, maximumTerm: null }] })];
    const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const alpha = facts.assets.find((row) => row.assetId === "alpha")!;
    expect(alpha.reserveStatus.observationState).not.toBe("known");
    expect(alpha.gaps).toContainEqual(expect.objectContaining({ responsibility: "producer-failed", path: { kind: "local-component", componentKey: "asset-compilation" } }));
    const beta = facts.assets.find((row) => row.assetId === "beta")!;
    expect(beta.reserveStatus).toEqual(baseline.assets.find((row) => row.assetId === "beta")!.reserveStatus);
    expect(beta.gaps.some((gap) => gap.path.kind === "local-component" && gap.path.componentKey === "asset-compilation")).toBe(false);
  });
});
