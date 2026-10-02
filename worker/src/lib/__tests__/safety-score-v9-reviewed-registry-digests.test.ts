import { describe, expect, it } from "vitest";
import access from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import incidents from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import mechanism from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import operational from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import transfer from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { V9AccessLookthroughOverlaySchema } from "@shared/types/safety-score-v9-access-lookthrough";
import { V9ReviewedIncidentRegistrySchema } from "@shared/types/safety-score-v9-incidents";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "@shared/types/safety-score-v9-mechanism-overlays";
import { SafetyScoreV9OperationalResilienceOverlayFileSchema } from "@shared/types/safety-score-v9-operational-resilience-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "@shared/types/safety-score-v9-transfer-overlays";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { domainDigest, compareText } from "@shared/lib/safety-score-v9/primitives";
import { computeSafetyScoreV9AccessClaimGraphReviewsDigest } from "../safety-score-v9/extension-access-lookthrough";
import { SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST } from "../safety-score-v9/extension-incidents";
import { SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST } from "../safety-score-v9/extension-mechanism";
import { SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST } from "../safety-score-v9/extension-operational-resilience";
import { computeSafetyScoreV9ReviewedTransferFactsDigest } from "../safety-score-v9/extension-transfer";
import { canonicalizeReviewedRegistryDigest, reviewedRegistryDigestKey } from "../safety-score-v9/extension-reviewed-registry";

describe("reviewed registry provenance identity", () => {
  it("keeps all five full-file digest identities from eager schema admission", () => {
    expect(computeSafetyScoreV9AccessClaimGraphReviewsDigest()).toBe(domainDigest("safety-score-v9.access-lookthrough-reviews.v1", V9AccessLookthroughOverlaySchema.parse(access)));
    expect(SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.incident-reviews.v1", payload: V9ReviewedIncidentRegistrySchema.parse(incidents) })));
    expect(SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.mechanism-review-overlays.v1", overlays: SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanism) })));
    expect(SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST).toBe(sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.operational-resilience-overlays.v1", payload: SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(operational) })));
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
});
