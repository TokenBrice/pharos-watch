import { describe, expect, it } from "vitest";
import { ReserveBoundedFactSchema, type ReserveBoundedFact } from "@shared/types/reserve-bounded-facts";
import { makeV9FixedInput, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9ReserveBoundFacts } from "../safety-score-v9/extension-reserve-bounds";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveSlice } from "@shared/types/reserves";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import rawReserveBounds from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";

// Authoritative D1 snapshot fetched 2026-10-02 20:15:17Z (Ethereum block 26106961).
const ousdRows: ReserveSlice[] = [{
  sourceKey: "origin-vault-balances:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  name: "USDC deployed through Origin OUSD strategies", pct: 100, risk: "medium", coinId: "usdc-circle", depType: "collateral",
  boundedFacts: [ReserveBoundedFactSchema.parse({
    factKey: "idle-native:origin-vault-balances:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    scope: { kind: "exposure", exposureKey: "origin-vault-balances:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    asOfSec: 1790972111, publisher: "Origin vault onchain balances",
    sourceUrls: ["https://etherscan.io/address/0xE75D77B1865Ae93c7eaa3040B038D7aA7BC02F70"],
    assertion: "Same-block idle USDC balance divided by total vault USDC checkBalance; not stressed cash realization",
    contentDigest: "36adeea7e9e018c172260ae2a44082c81d14d1eefaeb329efc3577da25cced30",
    provenance: { kind: "producer-observation", observer: "origin-vault-balances", sourceId: "origin-vault-check-balance", sourceGenerationId: "ethereum:26106961", observedAtSec: 1790972111, maxAgeSec: 10800, confidence: "high" },
    kind: "currently-liquid-fraction", assetId: "usdc-circle", unit: "USDC", chain: "ethereum",
    currentlyWithdrawable: 5649.644277, totalHeld: 6104872.890713, snapshotAtSec: 1790972111,
    availabilityMeaning: "currently-withdrawable-native-asset",
  })],
}];
const clock = 1790849876;
const metaById = new Map<string, V9ExtensionRegistryMeta>([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }], ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }]]);
function research(overrides: Record<string, unknown> = {}): ReserveBoundedFact {
  return ReserveBoundedFactSchema.parse({ factKey: "envelope", kind: "eligibility-envelope", scope: { kind: "reserve-envelope" }, asOfSec: clock - 86400, publisher: "issuer", sourceUrls: ["https://example.com/terms"], assertion: "Exhaustive governing terms", contentDigest: "a".repeat(64), provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-09-30", confidence: "high" }, legallyBinding: true, exhaustive: true, allocations: [{ assetClass: "cash", minShare: 0, maxShare: 1, maximumTerm: null }], ...overrides });
}
function compile(fact?: ReserveBoundedFact) {
  const fixed = makeV9TwoAssetFixedInput({ clockSec: clock, omitAlphaReserve: true });
  const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
  const extension = fact ? {
    ...baseline,
    assets: baseline.assets.map((row) => row.assetId === "alpha" ? { ...row, reserveBoundFacts: [fact] } : row),
  } : baseline;
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets.find((row) => row.assetId === "alpha")!;
}
describe("reserve bound compiler admission", () => {
  it("rejects live rows that impersonate reviewed research", () => {
    expect(() => buildSafetyScoreV9ReserveBoundFacts("alpha", [{
      name: "Cash", pct: 100, risk: "very-low", sourceKey: "reserve:cash", boundedFacts: [research()],
    }], { clockSec: clock })).toThrow("Live bounds cannot impersonate reviewed research");
  });
  it.each([[true, 28800], [true, null], [false, null]] as const)("compiles the OUSD research/live collision without changing quantities (generation matches: %s, source budget: %s)", (generationMatches, liveMaxAgeSec) => {
    const assetId = "ousd-origin-protocol";
    const { baseInputGenerationId: _baseGeneration, ...draft } = makeV9FixedInput({ assetId, clockSec: 1790972600, reserves: ousdRows });
    const fixed = createReportCardsFixedInput({
      ...draft,
      liveReserveProvenanceMap: {
        [assetId]: {
          source: "origin-vault-balances", fetchedAt: 1790972117,
          boundedFactsGeneration: { sourceGenerationId: generationMatches ? "ethereum:26106961" : "ethereum:26106960", observedAtSec: 1790972111, maxAgeSec: 10800 },
        },
      },
    });
    // This historical same-block reserve collision must not import a later,
    // unrelated mint review and quarantine the asset before bounds admission.
    const meta = { ...ACTIVE_META_BY_ID.get(assetId)!, mintAuthority: undefined };
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: new Map([[assetId, meta]]) });
    extension.sources.liveReserves.maxAgeSec = liveMaxAgeSec;
    const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const asset = facts.assets.find((row) => row.assetId === assetId)!;
    expect(asset.gaps.some((gap) => gap.path.kind === "local-component" && gap.path.componentKey === "asset-compilation")).toBe(false);
    expect(asset.reserveExposures.map((row) => row.weight)).toEqual([1]);
    const bounds = asset.reserveBoundFacts!;
    expect(bounds.map((row) => row.fact).filter((fact) => fact.kind === "currently-liquid-fraction").map((fact) => [fact.asOfSec, fact.currentlyWithdrawable, fact.totalHeld])).toEqual([
      [1790972111, 5649.644277, 6104872.890713],
    ]);
    const live = bounds.find((row) => row.fact.provenance.kind === "producer-observation")!;
    expect(live.status.observationState).toBe(generationMatches ? "known" : "unsupported");
    expect(live.rejectionReason).toBe(generationMatches ? null : "producer-generation-mismatch");
    expect(live.freshnessMaxAgeSec).toBe(10800);
    expect(bounds.some((row) => row.fact.provenance.kind === "reviewed-research")).toBe(false);
  });
  it("does not hide a genuine duplicate inside the live source", () => {
    expect(() => buildSafetyScoreV9ReserveBoundFacts("ousd-origin-protocol", [...ousdRows, ...ousdRows], { clockSec: 1790972600 })).toThrow("Duplicate canonical key");
  });
  it("omits expired observations instead of reviving the older reviewed quantity", () => {
    expect(buildSafetyScoreV9ReserveBoundFacts("ousd-origin-protocol", ousdRows, {
      clockSec: 1790972111 + 10801,
      liveMaxAgeSec: null,
      liveProvenance: { source: "origin-vault-balances", fetchedAt: 1790972117, boundedFactsGeneration: { sourceGenerationId: "ethereum:26106961", observedAtSec: 1790972111, maxAgeSec: 10800 } },
    })).toEqual([]);
  });
  it.each(["fresh", "generation-mismatch", "expired"] as const)("selects an admissible live revision or the current authored revision (%s)", (state) => {
    const clockSec = 1791070000;
    const reviewed = ReserveBoundedFactSchema.parse(rawReserveBounds.assets["stac-securitize"][0]);
    if (reviewed.scope.kind === "reserve-envelope") throw new Error("Expected exact scope");
    const observedAtSec = clockSec - (state === "expired" ? 10801 : 100);
    const observation = ReserveBoundedFactSchema.parse({
      ...reviewed, asOfSec: observedAtSec, coverageAsOfSec: observedAtSec, observedMaximumDays: 6000,
      provenance: { kind: "producer-observation", observer: "fixture", sourceId: "fixture", sourceGenerationId: "api:current", observedAtSec, maxAgeSec: 10800, confidence: "high" },
    });
    const selected = buildSafetyScoreV9ReserveBoundFacts("stac-securitize", [{
      sourceKey: reviewed.scope.exposureKey, name: "CLO portfolio", pct: 100, risk: "high", boundedFacts: [observation],
    }], {
      clockSec,
      liveProvenance: { source: "fixture", fetchedAt: observedAtSec, boundedFactsGeneration: { sourceGenerationId: state === "generation-mismatch" ? "api:other" : "api:current", observedAtSec, maxAgeSec: 10800 } },
    });
    expect(selected).toEqual([state === "fresh" ? observation : reviewed]);
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
    const baselineExtension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const baseline = compileSafetyScoreV9FactSetFromFixedInput(fixed, baselineExtension);
    const extension = {
      ...baselineExtension,
      assets: baselineExtension.assets.map((row) => row.assetId === "alpha" ? {
        ...row,
        reserveBoundFacts: [research(), research({ factKey: "conflicting", allocations: [{ assetClass: "bank-deposit", minShare: 0, maxShare: 1, maximumTerm: null }] })],
      } : row),
    };
    const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const alpha = facts.assets.find((row) => row.assetId === "alpha")!;
    expect(alpha.reserveStatus.observationState).not.toBe("known");
    expect(alpha.gaps).toContainEqual(expect.objectContaining({ responsibility: "producer-failed", path: { kind: "local-component", componentKey: "asset-compilation" } }));
    const beta = facts.assets.find((row) => row.assetId === "beta")!;
    expect(beta.reserveStatus).toEqual(baseline.assets.find((row) => row.assetId === "beta")!.reserveStatus);
    expect(beta.gaps.some((gap) => gap.path.kind === "local-component" && gap.path.componentKey === "asset-compilation")).toBe(false);
  });
});
