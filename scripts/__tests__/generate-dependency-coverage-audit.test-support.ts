import type { DependencyReview, ReserveReview } from "@shared/types/stablecoin-meta-schemas";
import type { DependencyTargetDisposition } from "@shared/data/coverage-dispositions/dependency-target-dispositions";

export function dependencyReview(relationships: DependencyReview["relationships"]): DependencyReview {
  return {
    reviewedAt: "2026-07-12", reviewer: "fixture reviewer", confidence: "verified",
    sources: [{ label: "Docs", url: "https://example.test/manual" }],
    rationale: "Fixture dependency review.", relationships,
  };
}

export function reserveReview(overrides: Partial<ReserveReview>): ReserveReview {
  return {
    reviewedAt: "2026-07-12", reviewer: "fixture reviewer", confidence: "verified",
    sources: [{ label: "Reserve report", url: "https://example.test/reserves" }],
    rationale: "Fixture reserve review.", compositionBasis: "Fixture reserve report",
    scope: "selected-slices", knownUnknownExposure: "Fixture exposure.", knownUnknownExposurePct: 0,
    ...overrides,
  };
}

export function targetDisposition(
  targetId: string,
  expectedLifecycle: DependencyTargetDisposition["expectedLifecycle"],
): DependencyTargetDisposition {
  return {
    targetId, expectedLifecycle, action: "retain-reviewed-link",
    reviewer: "reviewer", reviewedAt: "2026-07-12",
    sources: [{ label: "Docs", url: "https://example.test/target" }],
    rationale: "Fixture reviewed unavailable target.",
  };
}
