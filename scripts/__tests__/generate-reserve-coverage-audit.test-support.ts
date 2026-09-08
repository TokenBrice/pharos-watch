import type { StablecoinMeta } from "@shared/types";

type ReserveReview = NonNullable<StablecoinMeta["reserveReview"]>;

export function reviewedReserve(
  overrides: Pick<ReserveReview, "knownUnknownExposure" | "knownUnknownExposurePct"> & Partial<ReserveReview>,
): ReserveReview {
  return {
    reviewedAt: "2026-07-01",
    reviewer: "Fixture reviewer",
    confidence: "verified",
    sources: [{ label: "Review", url: "https://example.com/review" }],
    rationale: "Fixture review rationale",
    compositionBasis: "Fixture disclosure",
    compositionAsOf: "2026-07-01",
    scope: "full-composition",
    ...overrides,
  };
}
