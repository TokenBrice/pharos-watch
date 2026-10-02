import { describe, expect, it } from "vitest";
import { admitV10ReserveObservation, admitV10ReserveReportScope, resolveV10ReserveScopeWeights } from "../safety-score-v9/reserve-scope";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { LiveReserveSnapshotProvenanceSchema, ReserveObservationEnvelopeSchema } from "../../types/safety-score-v9-reserve-scope";
import type { ProofOfReservesLatestReport } from "../../types/stablecoin-meta-schemas";
import type { ReviewedEconomicDeploymentPartition } from "../../types/safety-score-v9-supply-attribution";

const policy = V9_CANDIDATE_POLICY_V1.policy;
const clockSec = Date.parse("2026-10-02T12:00:00Z") / 1000;
const asOfSec = Date.parse("2026-08-31T12:00:00Z") / 1000;
const ref = "ethereum:0x1111111111111111111111111111111111111111";
const generation = `report-cards-input:v1:${"a".repeat(64)}`;
const report: ProofOfReservesLatestReport = {
  periodEnd: "2026-08-31", publishedAt: "2026-09-08", publishedAtBasis: "signed-date-standin", assuranceMethod: "examination",
  scope: "assets-and-liabilities", liabilityReconciliation: "partial", reviewer: "fixture", confidence: "verified",
  sources: [{ label: "Report", url: "https://example.com/report" }],
  coverage: { scopeId: "trust", liabilityBookKey: "issuer:trust", deploymentRefs: [ref], liabilityExclusions: [],
    denominator: { periodEnd: "2026-08-31", asOfSec, currency: "USD", unitBasis: "token-units", decimals: 18,
      totalCoveredLiabilities: "50", included: [{ identity: { deploymentRef: ref, bookKey: "issuer:trust", account: null }, amount: "50", evidenceRefIds: ["source:report"] }],
      excluded: [], completeness: "complete", evidenceRefIds: ["source:report"], sourceSha256: "a".repeat(64) },
    reconciliationWithinScope: "full", assetsAsOfSec: asOfSec, reviewedAtSec: clockSec - 1, confidence: "verified",
    currentBookPartition: { baseInputGenerationId: generation, sourceGeneration: "current-supply", observedAtSec: clockSec - 60,
      completeness: "complete", evidenceRefIds: ["source:current-books"], books: [
        { deploymentRef: ref, bookKey: "issuer:trust", currentLiabilityUsd: 25, exclusions: [] },
        { deploymentRef: ref, bookKey: "issuer:legacy", currentLiabilityUsd: 75, exclusions: [] },
      ] },
  },
};
const partition = { model: "reviewed-economic-deployment-partition-v1", baseInputGenerationId: generation, sourceGeneration: "current-supply",
  observedAtSec: clockSec - 60, scoringClockSec: clockSec, quantitativeCompleteness: true, unattributedSupplyUsd: 0,
  aggregate: { supplyUsd: 100 }, deployments: [{ deploymentKey: ref, currentSupplyUsd: 100 }] } as ReviewedEconomicDeploymentPartition;
function admit(value = report, currentPartition: ReviewedEconomicDeploymentPartition | null = partition) {
  return admitV10ReserveReportScope({ report: value, deploymentRefs: [ref], clockSec, policy, currentPartition, baseInputGenerationId: generation })!;
}
describe("V10 scoped report admission", () => {
  it("uses the current exact book share rather than historical report tokens", () => {
    expect(admit()).toMatchObject({ admitted: true, currentLiabilityShare: 0.25, wholeAssetComposition: false });
    expect(admit(report, null)).toMatchObject({ admitted: true, currentLiabilityShare: null, rejectionCodes: ["current-partition-unavailable"] });
  });
  it("rejects incompatible checkpoints and assets-only financial interpretations", () => {
    const changed = structuredClone(report); changed.coverage!.assetsAsOfSec++;
    expect(admit(changed)).toMatchObject({ admitted: false, currentLiabilityShare: null });
    expect(admit({ ...report, scope: "assets-only" }).rejectionCodes).toContain("financial-method-ineligible");
    expect(admit({ ...report, assuranceMethod: "onchain-proof" }).currentLiabilityShare).toBeNull();
  });
  it("withholds unknown exclusions and generation mismatches", () => {
    const changed = structuredClone(report);
    changed.coverage!.liabilityExclusions.push({ id: "frozen", identity: { deploymentRef: ref, bookKey: "issuer:trust", account: "holder:1" }, kind: "frozen",
      reason: "Still owed", amount: null, currency: "USD", unitBasis: "token-units", asOfSec,
      source: { url: "https://example.com/report", accessedAtSec: clockSec - 1, sha256: "a".repeat(64) }, economicallyOwed: true });
    expect(admit(changed).currentLiabilityShare).toBeNull();
    expect(admit(report, { ...partition, sourceGeneration: "another-run" }).currentLiabilityShare).toBeNull();
  });
  it.each([["review-boundary", clockSec - 1, true], ["after-review", clockSec, false], ["after-clock", clockSec + 1, false]] as const)(
    "gates exclusion evidence at %s even with a complete current partition", (_, accessedAtSec, admitted) => {
      const changed = structuredClone(report);
      changed.coverage!.liabilityExclusions.push({ id: "treasury", identity: { deploymentRef: ref, bookKey: "issuer:trust", account: "issuer:treasury" }, kind: "treasury",
        reason: "Not economically owed", amount: "5", currency: "USD", unitBasis: "token-units", asOfSec,
        source: { url: "https://example.com/report", accessedAtSec, sha256: "a".repeat(64) }, economicallyOwed: false });
      changed.coverage!.denominator.excluded.push("treasury");
      changed.coverage!.currentBookPartition!.books[0].exclusions.push({ id: "treasury", currentAmountUsd: 5 });
      const result = admit(changed);
      expect(result.admitted).toBe(admitted);
      expect(result.currentLiabilityShare).toBe(admitted ? 0.2 : null);
      if (!admitted) expect(result.rejectionCodes).toContain(accessedAtSec > clockSec ? "future-evidence" : "checkpoint-mismatch");
    },
  );

  it("rejects all overlapping claims rather than selecting the favorable first one", () => {
    const first = admit();
    const result = resolveV10ReserveScopeWeights([first, { ...first, scopeId: "duplicate" }]);
    expect(result.scopes.map(row => row.currentLiabilityShare)).toEqual([null, null]);
    expect(result.unknownShare).toBe(1);
  });
  it("admits native liabilities only through the pinned current partition authority", () => {
    const nativeRef = "gnosis:native:xdai";
    const changed = structuredClone(report);
    changed.coverage!.nativeLiabilityRef = nativeRef;
    changed.coverage!.deploymentRefs = [nativeRef];
    changed.coverage!.denominator.included[0].identity.deploymentRef = nativeRef;
    changed.coverage!.currentBookPartition!.books.forEach(row => { row.deploymentRef = nativeRef; });
    const nativePartition = { ...partition, deployments: [{ ...partition.deployments[0], deploymentKey: nativeRef }] };
    expect(admit(changed, nativePartition)).toMatchObject({ admitted: true, currentLiabilityShare: 0.25 });
    expect(admit(changed, null)).toMatchObject({ admitted: false, currentLiabilityShare: null });
  });
});
const structure = ReserveObservationEnvelopeSchema.parse({ kind: "standing-structure", scopeId: "feeder", liabilityBookKey: "feeder:lp", deploymentRefs: [],
  reviewer: "fixture", confidence: "verified", sources: [{ url: "https://example.com/feeder", accessedAtSec: clockSec, sha256: "b".repeat(64) }],
  reviewedAtSec: clockSec, expiresAtSec: clockSec + policy.semantic.evidence.evidenceExpiry.standingStructureMaxAgeSec,
  observedAtSec: null, sourceGeneration: "review:1", sourceSha256: "b".repeat(64), completeness: "complete", obligations: [], wholeHolderClaim: true, instrumentKey: "feeder:lp" });
if (structure.kind !== "standing-structure") throw new Error("Expected a standing-structure fixture");
it("admits only a timely whole-holder standing identity without holdings or liability assurance", () => {
  const input = { observation: structure, deploymentRefs: [], clockSec: structure.expiresAtSec, policy };
  expect(admitV10ReserveObservation(input)).toMatchObject({ admitted: true, wholeAssetComposition: true, currentLiabilityShare: null, observedAtSec: null });
  expect(admitV10ReserveObservation({ ...input, clockSec: structure.expiresAtSec + 1 }).admitted).toBe(false);
  expect(admitV10ReserveObservation({ ...input, observation: { ...structure, wholeHolderClaim: false } }).admitted).toBe(false);
});
it.each(["standing-structure", "portfolio-observation"] as const)("retains diagnostic %s envelopes but rejects composition with omitted or unresolved obligations", (kind) => {
  for (const disposition of ["omitted", "unresolved"] as const) {
    const base = { ...structure, obligations: [{ key: "undisclosed-reserves", disposition, reason: "No denominator evidence" }] };
    const { wholeHolderClaim: _whole, instrumentKey: _instrument, ...common } = base;
    const observation = kind === "standing-structure" ? base : {
      ...common, kind, observedAtSec: clockSec,
      wholeAssetDenominator: { amount: "100", asOfSec: clockSec, unitBasis: "USD", sourceSha256: "b".repeat(64) },
    };
    const parsed = ReserveObservationEnvelopeSchema.parse(observation);
    expect(admitV10ReserveObservation({ observation: parsed, deploymentRefs: [], clockSec, policy }))
      .toMatchObject({ admitted: false, wholeAssetComposition: false, rejectionCodes: ["denominator-incomplete"] });
  }
});
it("retains malformed observation failure without letting it become admitted evidence", () => {
  const value = LiveReserveSnapshotProvenanceSchema.parse({ source: "xdai-bridge", fetchedAt: clockSec,
    reserveObservation: { kind: "onchain-accounting", scopeId: "broken" } });
  expect(value.reserveObservation).toBeUndefined();
  expect(value.reserveObservationFailure).toMatchObject({ code: "producer-failed", reason: "malformed-reserve-observation" });
});
