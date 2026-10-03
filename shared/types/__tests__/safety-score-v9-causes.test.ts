import { describe, expect, it } from "vitest";
import {
  V9EvidenceCauseProofSchema, V9EvidenceGapClassificationsV1Schema,
  createV9EvidenceGapClassificationsV1Schema, v9EvidenceCauseScopeKey,
  type V9EvidenceCauseScope, type V9EvidenceGapClassification,
} from "../safety-score-v9-causes";
import { createV9EvidenceReference, resolveV9EvidenceCause } from "../../lib/safety-score-v9/evidence";

const clock = Date.parse("2026-10-03T00:01:00Z") / 1000;
const scope: V9EvidenceCauseScope = {
  pillar: "exit", componentKey: "exit-route", factorKey: "cost", routeKey: "redemption:g1:main",
  exposureId: null, requiredDatum: "same-notional fee formula",
};
const entry: V9EvidenceGapClassification = {
  id: "usdt-main-fee", assetId: "usdt-tether", scope, cause: "B", assertion: "required-data-public",
  reviewedAt: "2026-10-03T00:01:00Z", reviewer: "primary-source-curator",
  sources: [{
    url: "https://issuer.example/terms", observedAt: "2026-10-03T00:00:59Z", datumAsOf: "2026-10-03",
    location: "Redemption / fee formula", excerpt: "Fee = 0.1% of the redeemed notional.",
    assertion: "The exact required same-notional fee formula is public and not yet evaluated by Pharos.",
  }],
};
const registrySchema = createV9EvidenceGapClassificationsV1Schema({
  assetIds: new Set([entry.assetId]), scopeKeys: new Set([v9EvidenceCauseScopeKey(entry.assetId, scope)]),
  asOfSec: clock, researchMaxAgeSec: 365 * 86400,
});
const resolverContext = {
  assetId: entry.assetId, scope, asOfSec: clock, sourceGenerationId: "route:g1", evidenceReferences: [],
};

function pipeline() {
  const proof = {
    cause: "A" as const, producerState: "producer-failed" as const, sourceId: "route-reader",
    sourceGenerationId: "route:g1", observedAtSec: clock, evidenceRefIds: ["attempt:g1"], rejectionCode: "rpc-timeout",
  };
  const reference = createV9EvidenceReference({
    evidenceId: "attempt:g1", sourceId: proof.sourceId, sourceGenerationId: proof.sourceGenerationId,
    disposition: "rejected", observedAtSec: clock,
    rejection: { code: proof.rejectionCode, reason: "Timed out at the captured source.", rejectedAtSec: clock },
    causeBinding: { assetId: entry.assetId, scope, producerState: proof.producerState, rejectionCode: proof.rejectionCode, adverseFactId: null },
  }, clock);
  return { proof, reference, verdict: { assetId: entry.assetId, scope, proof } };
}

describe("cause proofs and exact authored classification admission", () => {
  it("defaults absent proof to U without guessing from observation or legacy responsibility", () => {
    expect(resolveV9EvidenceCause(resolverContext)).toMatchObject({
      causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] }, responsibility: "unresearched",
    });
    expect(V9EvidenceCauseProofSchema.safeParse({ cause: "B", reviewedAt: entry.reviewedAt, url: entry.sources[0]!.url }).success).toBe(false);
  });

  it("admits A only for the exact captured asset, datum, clock, generation and rejection", () => {
    const { reference, verdict } = pipeline();
    const args = { ...resolverContext, evidenceReferences: [reference], runtimeVerdict: verdict };
    expect(resolveV9EvidenceCause(args).causeProof.cause).toBe("A");
    for (const invalid of [
      { ...args, sourceGenerationId: "route:g2" },
      { ...args, assetId: "usdc-circle" },
      { ...args, scope: { ...scope, requiredDatum: "holder eligibility" } },
      { ...args, asOfSec: clock - 1 },
      { ...args, evidenceReferences: [] },
      { ...args, evidenceReferences: [{ ...reference, rejection: { ...reference.rejection!, code: "different-error" } }] },
      { ...args, evidenceReferences: [{ ...reference, causeBinding: undefined }] },
    ]) expect(() => resolveV9EvidenceCause(invalid)).toThrow();
  });

  it("admits midnight UTC research at its exact timestamp, with no date-only day-elapsed lag", () => {
    expect(registrySchema.parse({ schemaVersion: 1, entries: [entry] }).entries[0]!.reviewedAt).toBe(entry.reviewedAt);
    const admitted = resolveV9EvidenceCause({ ...resolverContext, classification: entry });
    expect(admitted).toMatchObject({ causeProof: { cause: "B" }, responsibility: "public-data-uncurated" });
    expect(admitted.evidenceReferences[0]!.observedAtSec).toBe(clock);
    expect(resolveV9EvidenceCause({ ...resolverContext, asOfSec: clock - 1, classification: entry }).causeProof.cause).toBe("U");
    expect(registrySchema.safeParse({ schemaVersion: 1, entries: [{ ...entry, reviewedAt: "2026-10-03" }] }).success).toBe(false);
  });

  it("requires scoped C search and sources rather than issuer labels or a failed fetch", () => {
    const c = { ...entry, cause: "C" as const, assertion: "researched-nondisclosure" as const,
      searchedSurfaces: ["https://issuer.example/terms", "https://issuer.example/reports"],
      rationale: "The current same-notional redemption fee formula was not disclosed on either authoritative surface.",
    };
    expect(resolveV9EvidenceCause({ ...resolverContext, classification: c })).toMatchObject({ causeProof: { cause: "C" }, responsibility: "issuer-undisclosed" });
    for (const invalid of [
      { ...c, searchedSurfaces: [] }, { ...c, rationale: "" }, { ...c, sources: [] },
      { ...c, assertion: "required-data-public" }, { ...entry, sources: [{ ...entry.sources[0], assertion: "" }] },
      { ...entry, sources: [{ ...entry.sources[0], url: "ftp://issuer.example/terms" }] },
      { ...entry, sourceGapId: "invented-capture-evidence" },
    ]) expect(V9EvidenceGapClassificationsV1Schema.safeParse({ schemaVersion: 1, entries: [invalid] }).success).toBe(false);
  });

  it("rejects duplicate, contradictory, noncatalog and wrong-scope classifications", () => {
    const c = { ...entry, id: "conflict", cause: "C" as const, assertion: "researched-nondisclosure" as const,
      searchedSurfaces: [entry.sources[0]!.url], rationale: "The required field is absent.",
    };
    for (const entries of [
      [entry, entry], [entry, c], [{ ...entry, assetId: "tether" }],
      [{ ...entry, scope: { ...scope, exposureId: "selected-slice" } }],
      [{ ...entry, sources: [{ ...entry.sources[0], observedAt: "2026-10-03T00:01:01Z" }] }],
      [{ ...entry, reviewedAt: "2026-02-30T00:01:00Z" }],
    ]) expect(registrySchema.safeParse({ schemaVersion: 1, entries }).success).toBe(false);
  });

  it("bounds research freshness independently of the numerical datum clock", () => {
    const expired = { ...entry, reviewedAt: "2025-10-02T00:01:00Z",
      sources: [{ ...entry.sources[0]!, observedAt: "2025-10-02T00:00:59Z", datumAsOf: "2025-10-01" }],
    };
    expect(resolveV9EvidenceCause({ ...resolverContext, classification: expired }).causeProof.cause).toBe("U");
    const boundary = { ...entry, reviewedAt: new Date((clock - 365 * 86400) * 1000).toISOString().replace(".000Z", "Z"),
      sources: [{ ...entry.sources[0]!, observedAt: new Date((clock - 365 * 86400) * 1000).toISOString().replace(".000Z", "Z"), datumAsOf: null }],
    };
    expect(resolveV9EvidenceCause({ ...resolverContext, classification: boundary }).causeProof.cause).toBe("B");
    expect(resolveV9EvidenceCause({ ...resolverContext, asOfSec: clock + 1, classification: boundary }).causeProof.cause).toBe("U");
  });

  it("requires an admitted measured adverse fact for D", () => {
    const { reference } = pipeline();
    expect(() => resolveV9EvidenceCause({ ...resolverContext, evidenceReferences: [reference],
      adverseProof: { cause: "D", adverseFactId: "incident", evidenceRefIds: [reference.evidenceId] },
    })).toThrow(/measured adverse/);
    const measured = createV9EvidenceReference({
      evidenceId: "observed:incident", sourceId: "incident-reader", sourceGenerationId: "route:g1",
      disposition: "observed", observedAtSec: clock,
      causeBinding: { assetId: entry.assetId, scope, producerState: null, rejectionCode: null, adverseFactId: "incident" },
    }, clock);
    expect(resolveV9EvidenceCause({ ...resolverContext, evidenceReferences: [measured],
      adverseProof: { cause: "D", adverseFactId: "incident", evidenceRefIds: [measured.evidenceId] },
    }).causeProof.cause).toBe("D");
  });

  it("admits dated typed nondisclosure only after its UTC review day has elapsed", () => {
    const typedReview = {
      id: "typed-fee-review", assetId: entry.assetId, scope, cause: "C", assertion: "researched-nondisclosure",
      reviewedAt: "2026-10-02", sources: ["https://issuer.example/terms"],
      rationale: "The authored review found no disclosed same-notional fee formula.",
    };
    const dayEnd = Date.parse("2026-10-03T00:00:00Z") / 1000;
    expect(resolveV9EvidenceCause({ ...resolverContext, asOfSec: dayEnd - 1, typedReview }).causeProof.cause).toBe("U");
    const result = resolveV9EvidenceCause({ ...resolverContext, asOfSec: dayEnd, typedReview });
    expect(result.causeProof).toMatchObject({ cause: "C", proofOrigin: "typed-review", reviewedAt: "2026-10-02" });
    expect(result.evidenceReferences[0]!.sourceId).toBe("typed-review-gap-classifications-v1");
  });

  it("keeps optional typed conversion failures at U with captured history and a diagnostic", () => {
    const historical = createV9EvidenceReference({
      evidenceId: "historical-reviewed-source", sourceId: "typed-review", sourceGenerationId: "old",
      disposition: "published", observedAtSec: clock - 1000, publishedAtSec: clock - 1000, maxAgeSec: 100,
    }, clock);
    for (const typedReview of [
      { id: "bad", assetId: entry.assetId, scope, cause: "C", assertion: "researched-nondisclosure", reviewedAt: "not-a-date", sources: ["https://issuer.example/terms"], rationale: "Authored assertion." },
      { id: "bad", assetId: entry.assetId, scope, cause: "C", assertion: "researched-nondisclosure", reviewedAt: "2026-10-02", sources: [], rationale: "" },
      { id: "bad", assetId: entry.assetId, scope, cause: "B", reviewedAt: "2026-10-02", sources: ["https://issuer.example/terms"] },
    ]) {
      const result = resolveV9EvidenceCause({ ...resolverContext, evidenceReferences: [historical], typedReview });
      expect(result.causeProof.cause).toBe("U");
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "cause-proof-conversion-failed", scope })]);
      expect(result.evidenceReferences[0]!.freshness.state).toBe("stale");
      expect(result.evidenceReferences[0]!.publishedAtSec).toBe(clock - 1000);
    }
  });
});
