import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { makeV9CohortFixedInput, V9_EVALUATION_TEST_TIMEOUT_MS } from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";
import { assessV9Publication } from "../safety-score-v9/publication-assessment";
import supplyRegistry from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";

describe("reviewed registry provenance identity", () => {
  // Full authored-registry admission exceeds 20s under weekly V8 coverage.
  it("keeps all four full-file digest identities from eager schema admission", () => {
    expect(computeSafetyScoreV9AccessClaimGraphReviewsDigest()).toBe(domainDigest("safety-score-v9.access-lookthrough-reviews.v1", V9AccessLookthroughOverlaySchema.parse(access)));
    // Authored providers have no assetId. The current runtime pipeline admits
    // their fan-outs with the strict provider schema as well as every local row.
    const eagerIncidents = buildIncidentRuntime(V9AuthoredIncidentRegistryEnvelopeSchema.parse(incidents));
    expect(SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST).toBe(eagerIncidents.digest);
    expect(SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.mechanism-review-overlays.v1", overlays: SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanism) })));
    expect(computeSafetyScoreV9ReviewedTransferFactsDigest()).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.reviewed-transfer-overlays.v1", schemaVersion: 1, reviews: SafetyScoreV9ReviewedTransferFileSchema.parse(transfer).reviews.sort((a, b) => compareText(a.assetId, b.assetId)) })));
  }, 60_000);

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
    const expanded = expandReviewedRegistryReferences(V9AuthoredEvidenceGapClassificationsEnvelopeSchema.parse(gaps), "entries", { sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations" });
    expect(V9EvidenceGapClassificationsV1Schema.parse(expanded).entries).toHaveLength(gaps.entries.length);
    expect(V9EvidenceGapClassificationsV1Schema.safeParse(gaps).success).toBe(false);
  });

  it("preserves ordered reference expansion independently of live registry curation", () => {
    const authored = {
      schemaVersion: 1, entries: [{ assetId: "alpha", id: "ordered", sourcesRefs: ["second", "first"], searchedSurfacesRefs: ["surface"] }],
      sourceObservations: [{ id: "first", value: { label: "First" } }, { id: "second", value: { label: "Second" } }],
      searchedSurfaceObservations: [{ id: "surface", value: "https://issuer.example/reports" }],
    };
    const expanded = expandReviewedRegistryReferences(authored, "entries", { sources: "sourceObservations", searchedSurfaces: "searchedSurfaceObservations" });
    expect(expanded).toEqual({
      schemaVersion: 1, entries: [{ assetId: "alpha", id: "ordered", sources: [{ label: "Second" }, { label: "First" }],
        searchedSurfaces: ["https://issuer.example/reports"] }],
    });
    expect(sha256Hex(stableJsonStringifyV1(expanded))).toBe("6d1ff3776c5ac090018795418756a520beb920f379b7b9978db2463ccb4c99f3");
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

const schema = z.object({
  assetId: z.string(),
  sources: z.array(z.object({ label: z.string(), url: z.string() })),
});

describe("reviewed registry admitted graph retention", () => {
  it("reuses schema-equivalent authored evidence despite nested key insertion order", () => {
    const row = { sources: [{ url: "https://example.com", label: "Evidence" }], assetId: "alpha" };
    const registry = createReviewedAssetRegistry({ rows: [row], schema, path: "reviews" });
    expect(registry.get("alpha")).toBe(row);
    expect(registry.getAll("alpha")).toBe(registry.getAll("alpha"));
    expect(registry.get("alpha")).toEqual(schema.parse(row));
  });

  it("shares unchanged child evidence when a schema default requires a new row", () => {
    const row = { assetId: "alpha", sources: [{ url: "https://example.com", label: "Evidence" }] };
    const defaulted = schema.extend({ reviewed: z.boolean().default(false) });
    const admitted = createReviewedAssetRegistry({ rows: [row], schema: defaulted, path: "reviews" }).get("alpha")!;
    expect(admitted).not.toBe(row);
    expect(admitted.sources).toBe(row.sources);
    expect(admitted).toEqual(defaulted.parse(row));
    expect(row).not.toHaveProperty("reviewed");
  });

  it("retains schema transforms, defaults, stripped keys and array order", () => {
    const row = { assetId: "alpha", sources: [{ label: "  Evidence  ", url: "https://example.com", extra: true }] };
    const transformed = schema.extend({
      sources: z.array(z.object({ url: z.string(), label: z.string().trim() })),
      reviewed: z.boolean().default(false),
    });
    const registry = createReviewedAssetRegistry({ rows: [row], schema: transformed, path: "reviews" });
    expect(registry.get("alpha")).toEqual(transformed.parse(row));
    expect(registry.get("alpha")).not.toBe(row);
    const reverse = schema.transform(value => ({ ...value, sources: [...value.sources].reverse() }));
    const ordered = { assetId: "alpha", sources: [{ label: "A", url: "a" }, { label: "B", url: "b" }] };
    expect(createReviewedAssetRegistry({ rows: [ordered], schema: reverse, path: "reviews" }).get("alpha")).toEqual(reverse.parse(ordered));
  });

  it("rejects malformed evidence before reuse and preserves healthy peers", () => {
    const good = { assetId: "beta", sources: [{ label: "Evidence", url: "https://example.com" }] };
    const registry = createReviewedAssetRegistry({ rows: [{ assetId: "alpha", sources: [{ label: 3 }] }, good], schema, path: "reviews" });
    expect(() => registry.get("alpha")).toThrow("reviews.0.sources.0.label");
    expect(registry.get("beta")).toBe(good);
    expect(registry.get("absent")).toBeUndefined();
  });
});

// Alpha is the malformed/duplicate review owner and beta its healthy peer. The
// nine further assets keep ten of the eleven candidates healthy, because a
// producer failure holds globally below nine healthy in ten: that keeps one
// quarantined asset on the publish path without paying for a 20-asset build.
const extraIds = Array.from({ length: 9 }, (_, index) => `gamma-${String(index + 1).padStart(2, "0")}`);
const fixedInput = makeV9CohortFixedInput(extraIds);
const mechanismPath = "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
const transferPath = "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
const supplyPath = "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
const deploymentKey = `ethereum:0x${"1".repeat(40)}`;
const economicPlan = {
  assetId: "alpha", reviewer: "Fixture reviewer", reviewedAtSec: 1, expiresAtSec: 86401,
  evidenceUrls: ["https://example.com/accounting"], economicScope: "All holder claims",
  sourceId: "reference", accountingFamily: "independent-liability", commonClaimUnit: "claim",
  exhaustive: true, inFlightTreatment: "observed-reconciled",
  deployments: [{
    deploymentKey, chainId: "ethereum", address: deploymentKey.split(":")[1],
    holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: deploymentKey,
    read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null,
  }],
  excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], escrows: [],
  referencePriceSource: null, liabilityInFlightSource: null,
};
const exclusionReview = { ...supplyRegistry.providerRowExclusionReviews[0]!, assetId: "alpha" };

const mechanismReview = {
  assetId: "alpha", archetype: "fiat-cash", reviewedAt: "1970-01-01",
  sources: [{ label: "Primary evidence", url: "https://example.com/review" }],
  notes: "Fixture review", metrics: {}, components: {},
};
const transferReview = {
  assetId: "alpha", reviewedAt: "1970-01-01", reviewer: "Fixture reviewer",
  deployments: [{ chainId: "ethereum", contractOrTokenId: "0x1234", scope: "canonical", posture: "permissionless",
    evidence: "Fixture evidence", sources: [{ label: "Primary evidence", url: "https://example.com/review" }] }],
};

async function runCandidate(path: string, rows: unknown[], exclusions: unknown[] = []) {
  vi.resetModules();
  vi.doMock(path, () => ({ default: path === supplyPath
    ? { ...supplyRegistry, reviews: rows, providerRowExclusionReviews: exclusions }
    : { schemaVersion: 1, note: "Fixture registry", [path === mechanismPath ? "overlays" : "reviews"]: rows } }));
  // Re-import after each JSON replacement to exercise the module-load envelope boundary.
  const { buildSafetyScoreV9Candidate } = await import("../safety-score-v9/candidate");
  return buildSafetyScoreV9Candidate({
    fixedInput, publishedAtSec: fixedInput.clockSec,
    registry: {
      registryFingerprint: fixedInput.registryFingerprint,
      metaById: new Map(fixedInput.activeAssetIds.map((id) => [id, alphaMeta({
        id,
        reserves: [{ name: "Custodied cash", pct: 100, risk: "very-low", assetClass: "cash",
          issuerOrObligor: `issuer:${id}`, riskFactors: ["custody", "counterparty"], liquidityHorizon: "immediate", maturityDaysMax: 0 }],
        reserveReview: { reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "verified",
          sources: [{ label: "Reserve report", url: "https://example.com/reserves" }], rationale: "Fixture review",
          compositionBasis: "Fixture report", compositionAsOf: "1970-01-01", scope: "full-composition",
          knownUnknownExposure: "None", knownUnknownExposurePct: 0 },
      })])),
    },
  });
}

afterEach(() => {
  vi.doUnmock(mechanismPath);
  vi.doUnmock(transferPath);
  vi.doUnmock(supplyPath);
  vi.resetModules();
});

describe("reviewed registry asset isolation", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it.each([
    { name: "mechanism", path: mechanismPath, review: mechanismReview, bad: { ...mechanismReview, reviewedAt: "not-a-date" }, field: "mechanismReviews.overlays.0.reviewedAt" },
    { name: "transfer", path: transferPath, review: transferReview, bad: { ...transferReview, deployments: [{ ...transferReview.deployments[0], posture: "invalid-posture" }] }, field: "transferReviews.reviews.0.deployments.0.posture" },
  ])("publishes healthy B while malformed $name evidence quarantines A with its exact path", async ({ path, review, bad, field }) => {
    const healthyB = { ...structuredClone(review), assetId: "beta" };
    const clean = await runCandidate(path, [review, healthyB]);
    expect(clean.quarantines).toEqual([]);
    const isolated = await runCandidate(path, [bad, healthyB]);
    expect(isolated.extension.assets.find((asset) => asset.assetId === "alpha")?.admissionQuarantine).toMatchObject({ code: "fact-build-failed", path: field });
    expect(isolated.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed", message: expect.any(String) }]);
    expect(isolated.candidate.cards.find((card) => card.id === "alpha")).toMatchObject({ ratingStatus: "pipeline-gap", grade: null, score: null });
    const healthyCard = isolated.candidate.cards.find((card) => card.id === "beta")!;
    expect(healthyCard).toMatchObject({ ratingStatus: "rated", grade: expect.any(String), score: expect.any(Number) });
    expect(stableJsonStringifyV1(healthyCard)).toBe(stableJsonStringifyV1(clean.candidate.cards.find((card) => card.id === "beta")));
    expect(assessV9Publication({
      inputHealth: {
        dex: { state: "current", generationId: fixedInput.dexGenerationId, updatedAtSec: fixedInput.clockSec },
        redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
        liveReserves: { state: "available", coverageRatio: 1 },
      }, candidate: isolated.candidate, acceptedPublication: null, coverageFloors: [],
      quarantinedAssetIds: ["alpha"], quarantineAffectedAssetIds: isolated.quarantineAffectedAssetIds,
    })).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha"] });
  });

  it("quarantines only the owner of duplicate asset reviews", async () => {
    const result = await runCandidate(transferPath, [transferReview, structuredClone(transferReview), { ...structuredClone(transferReview), assetId: "beta" }]);
    expect(result.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed", message: expect.any(String) }]);
    expect(result.extension.assets.find((asset) => asset.assetId === "alpha")?.admissionQuarantine?.path).toBe("transferReviews.reviews.1.assetId");
    expect(result.candidate.cards.find((card) => card.id === "beta")?.grade).not.toBe("NR");
  });

  it.each([
    {
      name: "malformed economic plan",
      plans: [{ ...economicPlan, reviewedAtSec: "not-a-time" }],
      exclusions: [],
      field: "supplyAttribution.reviews.0.reviewedAtSec",
    },
    {
      name: "duplicate provider exclusion",
      plans: [economicPlan],
      exclusions: [exclusionReview, structuredClone(exclusionReview), { ...exclusionReview, assetId: "beta" }],
      field: "supplyAttribution.providerRowExclusionReviews.1.providerChainLabel",
    },
    {
      name: "malformed provider exclusion",
      plans: [economicPlan],
      exclusions: [{ ...exclusionReview, reviewedAtSec: "not-a-time" }, { ...exclusionReview, assetId: "beta" }],
      field: "supplyAttribution.providerRowExclusionReviews.0.reviewedAtSec",
    },
  ])("cold-imports $name and publishes the healthy asset unchanged", async ({ plans, exclusions, field }) => {
    const healthyPlans = [economicPlan];
    const healthyExclusions = [exclusionReview, { ...exclusionReview, assetId: "beta" }];
    const clean = await runCandidate(supplyPath, healthyPlans, healthyExclusions);
    expect(clean.quarantines).toEqual([]);
    const isolated = await runCandidate(supplyPath, plans, exclusions);
    expect(isolated.extension.assets.find(asset => asset.assetId === "alpha")?.admissionQuarantine).toMatchObject({
      code: "fact-build-failed", path: field,
    });
    expect(isolated.quarantines).toEqual([{
      assetId: "alpha", code: "fact-build-failed", message: expect.any(String),
    }]);
    expect(isolated.candidate.cards.find(card => card.id === "alpha")).toMatchObject({ ratingStatus: "pipeline-gap", grade: null, score: null });
    const healthyCard = isolated.candidate.cards.find(card => card.id === "beta")!;
    expect(healthyCard).toMatchObject({ ratingStatus: "rated", grade: expect.any(String), score: expect.any(Number) });
    expect(stableJsonStringifyV1(healthyCard)).toBe(stableJsonStringifyV1(clean.candidate.cards.find(card => card.id === "beta")));
    expect(assessV9Publication({
      inputHealth: {
        dex: { state: "current", generationId: fixedInput.dexGenerationId, updatedAtSec: fixedInput.clockSec },
        redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
        liveReserves: { state: "available", coverageRatio: 1 },
      }, candidate: isolated.candidate, acceptedPublication: null, coverageFloors: [],
      quarantinedAssetIds: ["alpha"], quarantineAffectedAssetIds: isolated.quarantineAffectedAssetIds,
    })).toEqual({ decision: "publish", reasons: [], affectedAssetIds: ["alpha"] });
  });
});
