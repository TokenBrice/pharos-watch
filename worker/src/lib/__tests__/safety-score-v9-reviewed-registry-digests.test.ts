import { describe, expect, it } from "vitest";
import access from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import incidents from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import mechanism from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import transfer from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import gaps from "@shared/data/safety-score-v9/evidence-gap-classifications-v1.json";
import {
  V9AuthoredEvidenceGapClassificationsEnvelopeSchema, V9EvidenceGapClassificationsV1Schema, V9EvidenceGapClassificationSchema,
} from "@shared/types/safety-score-v9-causes";
import { V9AccessLookthroughOverlaySchema } from "@shared/types/safety-score-v9-access-lookthrough";
import { V9AuthoredIncidentRegistryEnvelopeSchema } from "@shared/types/safety-score-v9-incidents";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "@shared/types/safety-score-v9-mechanism-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "@shared/types/safety-score-v9-transfer-overlays";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { domainDigest, compareText } from "@shared/lib/safety-score-v9/primitives";
import { computeSafetyScoreV9AccessClaimGraphReviewsDigest } from "../safety-score-v9/extension-access-lookthrough";
import { SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST } from "../safety-score-v9/extension-incidents";
import { SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST } from "../safety-score-v9/extension-mechanism";
import { computeSafetyScoreV9ReviewedTransferFactsDigest } from "../safety-score-v9/extension-transfer";
import { canonicalizeReviewedRegistryDigest, createReviewedAssetRegistry, createReviewedRegistryReferenceExpander, expandReviewedRegistryReferences, reviewedRegistryDigestKey } from "@shared/lib/safety-score-v9/reviewed-registry";
import { buildIncidentRuntime } from "../../../../scripts/lib/safety-score-v9-incident-runtime";

describe("reviewed registry provenance identity", () => {
  it("keeps all four full-file digest identities from eager schema admission", () => {
    expect(computeSafetyScoreV9AccessClaimGraphReviewsDigest()).toBe(domainDigest("safety-score-v9.access-lookthrough-reviews.v1", V9AccessLookthroughOverlaySchema.parse(access)));
    // Authored providers have no assetId. The current runtime pipeline admits
    // their fan-outs with the strict provider schema as well as every local row.
    const eagerIncidents = buildIncidentRuntime(V9AuthoredIncidentRegistryEnvelopeSchema.parse(incidents));
    expect(SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST).toBe(eagerIncidents.digest);
    // Deliberate incident curation rotates this independent full-file pin.
    expect(eagerIncidents.digest).toBe("371ecdb8c911dc5f08db0dddf3f33055517ce23d8a3aee887073381950cc0f6f");
    expect(SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.mechanism-review-overlays.v1", overlays: SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanism) })));
    expect(computeSafetyScoreV9ReviewedTransferFactsDigest()).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.reviewed-transfer-overlays.v1", schemaVersion: 1, reviews: SafetyScoreV9ReviewedTransferFileSchema.parse(transfer).reviews.sort((a, b) => compareText(a.assetId, b.assetId)) })));
  });

  it("preserves sorted evidence, schema defaults and trimmed fields without admitting malformed rows", () => {
    const authored = {
      schemaVersion: 1, note: "Fixture", overlays: [{
        assetId: "alpha", archetype: "cdp", reviewedAt: "1970-01-01", sources: [{ label: "Primary", url: "https://example.com/review" }],
        notes: "Fixture", metrics: {}, components: {}, venueShares: [{ venueKey: "venue", share: 1 }],
        collateralizationMeasurement: { measurementId: " pin ", ratio: 1, rationale: " reviewed ", sourceUrl: "https://example.com/review" },
      }],
    };
    const canonical = canonicalizeReviewedRegistryDigest(authored, {}, { "overlays.*.venueShares.*.failureDomains": [] }, ["overlays.*.collateralizationMeasurement.measurementId", "overlays.*.collateralizationMeasurement.rationale"]);
    expect(stableJsonStringifyV1(canonical)).toBe(stableJsonStringifyV1(SafetyScoreV9MechanismReviewOverlayFileSchema.parse(authored)));
    const damaged = { incidents: [{ assetId: "alpha", incidentId: "z", occurredAt: "invalid" }, { assetId: "beta", incidentId: "a" }] };
    const digestValue = canonicalizeReviewedRegistryDigest(damaged, { incidents: reviewedRegistryDigestKey("incidentId") });
    expect(digestValue).toEqual({ incidents: [damaged.incidents[1], damaged.incidents[0]] });
    expect(domainDigest("fixture", digestValue)).not.toBe(domainDigest("fixture", { incidents: [damaged.incidents[1]] }));
  });

  it("expands the exact ordered pre-normalization gap payload before strict admission", () => {
    const expanded = expandReviewedRegistryReferences(V9AuthoredEvidenceGapClassificationsEnvelopeSchema.parse(gaps), "entries", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    });
    expect(V9EvidenceGapClassificationsV1Schema.parse(expanded).entries).toHaveLength(gaps.entries.length);
    // Full authored-registry identity pin; deliberate curation rotates this snapshot.
    expect(sha256Hex(stableJsonStringifyV1(expanded))).toBe("d2e13516a6da3cdae213e06cd274d3938f138f8eddf293441a3101e29cf2fcc3");
    expect(V9EvidenceGapClassificationsV1Schema.safeParse(gaps).success).toBe(false);
  });

  it("preserves ordered reference expansion independently of live registry curation", () => {
    const authored = {
      schemaVersion: 1,
      entries: [{ assetId: "alpha", id: "ordered", sourcesRefs: ["second", "first"], searchedSurfacesRefs: ["surface"] }],
      sourceObservations: [{ id: "first", value: { label: "First" } }, { id: "second", value: { label: "Second" } }],
      searchedSurfaceObservations: [{ id: "surface", value: "https://issuer.example/reports" }],
    };
    expect(expandReviewedRegistryReferences(authored, "entries", {
      sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations",
    })).toEqual({
      schemaVersion: 1,
      entries: [{ assetId: "alpha", id: "ordered", sources: [{ label: "Second" }, { label: "First" }],
        searchedSurfaces: ["https://issuer.example/reports"] }],
    });
    expect(authored.entries[0]).toHaveProperty("sourcesRefs", ["second", "first"]);
  });

  it("keeps shared observations independent by review scope and isolates a dangling asset", () => {
    const source = { url: "https://example.com/source", observedAt: "1970-01-01T00:00:00Z",
      datumAsOf: null, location: "Report", excerpt: "Published report", assertion: "Required datum is public." };
    const entry = { id: "first", assetId: "alpha", cause: "B", assertion: "required-data-public",
      reviewedAt: "1970-01-01T01:00:00Z", reviewer: "Reviewer", sourcesRefs: ["shared"],
      scope: { pillar: "control", componentKey: "mint", factorKey: null, routeKey: null,
        exposureId: null, requiredDatum: "mint" } };
    const rows = [entry,
      { ...entry, id: "second", reviewedAt: "1970-01-01T02:00:00Z", scope: { ...entry.scope, componentKey: "upgrade", requiredDatum: "upgrade" } },
      { ...entry, id: "broken", assetId: "beta", sourcesRefs: ["missing"] }];
    const registry = createReviewedAssetRegistry({
      rows, schema: V9EvidenceGapClassificationSchema, path: "classifications.entries",
      keyOf: (row) => String(row.id),
      expandRow: createReviewedRegistryReferenceExpander({ sources: [{ id: "shared", value: source }] }, "classifications.entries"),
    });
    expect(() => registry.getAll("beta")).toThrow(/Dangling observation reference/);
    const admitted = registry.getAll("alpha");
    expect(admitted).toHaveLength(2);
    expect(admitted.map((row) => [row.id, row.scope.requiredDatum, row.reviewedAt])).toEqual([
      ["first", "mint", "1970-01-01T01:00:00Z"], ["second", "upgrade", "1970-01-01T02:00:00Z"],
    ]);
    expect(admitted[0]!.sources).toEqual(admitted[1]!.sources);
    expect(Object.isFrozen(source)).toBe(true);
    expect(rows[0]).not.toHaveProperty("sources");
  });

  it.each(["sources", "searchedSurfaces"] as const)("isolates duplicate %s table IDs to referencing assets", (field) => {
    const source = { url: "https://example.com/source", observedAt: "1970-01-01T00:00:00Z",
      datumAsOf: null, location: "Report", excerpt: "Published report", assertion: "Required datum is not disclosed." };
    const tables = {
      sources: [{ id: "shared", value: source }],
      searchedSurfaces: [{ id: "shared", value: "https://example.com/source" }],
    };
    const duplicateValue = field === "sources" ? source : "https://example.com/source";
    const duplicates = [{ id: "ambiguous", value: duplicateValue }, { id: "ambiguous", value: duplicateValue },
      { id: "unused", value: duplicateValue }, { id: "unused", value: duplicateValue }];
    const entry = { id: "first", assetId: "alpha", cause: "C", assertion: "researched-nondisclosure",
      reviewedAt: "1970-01-01T01:00:00Z", reviewer: "Reviewer",
      sourcesRefs: ["shared"], searchedSurfacesRefs: ["shared"], rationale: "Required datum is not disclosed.",
      scope: { pillar: "control", componentKey: "mint", factorKey: null, routeKey: null,
        exposureId: null, requiredDatum: "mint" } };
    const rows = [entry, { ...entry, id: "broken", assetId: "beta", [`${field}Refs`]: ["ambiguous"] }];
    const registry = createReviewedAssetRegistry({
      rows, schema: V9EvidenceGapClassificationSchema, path: "classifications.entries",
      keyOf: (row) => String(row.id),
      expandRow: createReviewedRegistryReferenceExpander({
        ...tables, [field]: [...tables[field], ...duplicates],
      }, "classifications.entries"),
    });
    const unaffected = registry.getAll("alpha");
    expect(unaffected).toHaveLength(1);
    expect(unaffected[0]!.sources).toEqual([source]);
    expect(() => registry.getAll("beta")).toThrow(/Duplicate observation reference: ambiguous/);
    expect(registry.getAll("alpha")).toBe(unaffected);
    expect(registry.getAll("not-reviewed")).toEqual([]);
  });
});
