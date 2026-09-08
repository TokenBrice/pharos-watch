import { describe, expect, it } from "vitest";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  expandOverlayReview,
  MechanismReviewOverlaySchema,
  type MechanismReviewOverlay,
} from "../safety-score-v9/extension-mechanism";

function expectNonScoring(overlay: MechanismReviewOverlay, keys: string[]) {
  const expanded = expandOverlayReview(overlay) as unknown as Record<
    string,
    { quality: string | null; status: { observationState: string; gapIds: string[] } }
  >;
  for (const key of keys) {
    expect(expanded[key], `${overlay.assetId}:${key}`).toMatchObject({
      quality: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(expanded[key].status.gapIds).not.toHaveLength(0);
  }
}

describe("Safety Score V9 evidence-only mechanism curation", () => {
  it("keeps an authored unavailable component non-scoring", () => {
    const overlay = MechanismReviewOverlaySchema.parse({
      assetId: "fixture-fiat",
      archetype: "fiat-cash",
      reviewedAt: "2026-08-08",
      notes: "Reviewed issuer nondisclosure; no positive quality claim.",
      metrics: {},
      sources: [{ label: "Issuer disclosure", url: "https://example.com/disclosure" }],
      components: {
        custodyContinuity: {
          applicability: "unavailable",
          rationale: "The issuer has not published custody continuity evidence.",
          sourceUrl: "https://example.com/disclosure",
        },
      },
    });
    expectNonScoring(overlay, ["custodyContinuity"]);
  });

  it("keeps all currently authored unavailable components non-scoring", () => {
    for (const value of mechanismReviewOverlaysAsset.overlays) {
      const overlay = MechanismReviewOverlaySchema.parse(value);
      const keys = Object.entries(overlay.components)
        .filter(([, component]) => "applicability" in component && component.applicability === "unavailable")
        .map(([key]) => key);
      expectNonScoring(overlay, keys);
    }
  });
});
