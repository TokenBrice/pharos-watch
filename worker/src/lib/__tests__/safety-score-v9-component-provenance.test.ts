import { describe, expect, it } from "vitest";
import { SafetyScoreV9MechanismReviewOverlaySchema } from "@shared/types/safety-score-v9-mechanism-overlays";
import { expandOverlayReview } from "../safety-score-v9/extension-mechanism";

const source = { label: "Pinned bridge state", url: "https://example.org/bridge" };
const overlay = SafetyScoreV9MechanismReviewOverlaySchema.parse({
  assetId: "test-asset", archetype: "cdp", reviewedAt: "2026-08-08", sources: [source], notes: "Historical portfolio; independently reviewed adverse bridge state.",
  metrics: { collateralizationRatio: 1.041014, liquidationCapacityRatio: null },
  metricApplicability: { liquidationCapacityRatio: { state: "unavailable", rationale: "No liquidation inventory", sourceUrl: source.url } },
  components: {
    collateralizationParameters: { quality: "adequate" },
    branchIsolation: { quality: "weak", review: { reviewedAt: "2026-10-10", reviewer: "Test reviewer", rationale: "Pinned isolation is disabled", sources: [source] } },
  },
});

describe("independent mechanism component provenance", () => {
  it("does not renew collateralization or sibling evidence", () => {
    const review = expandOverlayReview(overlay, null, Date.parse("2026-10-11T00:00:00Z") / 1000);
    expect(review.archetype).toBe("cdp");
    if (review.archetype !== "cdp") throw new Error("wrong family");
    expect(review.collateralizationRatio).toBe(1.041014);
    expect(review.branchIsolation.quality).toBe("weak");
    expect(review.branchIsolation.status.observationState).toBe("known");
    expect(overlay.reviewedAt).toBe("2026-08-08");
    expect(review.collateralizationParameters.quality).toBe("adequate");
  });
  it.each([
    ["2026-10-09T23:59:59Z", "missing"],
    ["2026-10-10T12:00:00Z", "unsupported"],
    ["2027-10-10T00:00:00Z", "stale"],
  ])("withholds future, same-day and expired component at %s", (clock, state) => {
    const review = expandOverlayReview(overlay, null, Date.parse(clock) / 1000);
    if (review.archetype !== "cdp") throw new Error("wrong family");
    expect(review.branchIsolation.quality).toBeNull();
    expect(review.branchIsolation.status.observationState).toBe(state);
    expect(review.collateralizationParameters.quality).toBe("adequate");
  });
  it("rejects unpinned component sources and incomplete reviews", () => {
    const changed = structuredClone(overlay);
    changed.components.branchIsolation.review!.sources[0]!.url = "https://example.org/unpinned";
    expect(SafetyScoreV9MechanismReviewOverlaySchema.safeParse(changed).success).toBe(false);
    const incomplete = { ...overlay, components: { branchIsolation: { quality: "weak", review: { reviewedAt: "2026-10-10" } } } };
    expect(SafetyScoreV9MechanismReviewOverlaySchema.safeParse(incomplete).success).toBe(false);
  });
});
