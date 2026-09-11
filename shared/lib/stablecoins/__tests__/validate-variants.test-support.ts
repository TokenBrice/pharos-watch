import type { StablecoinMeta } from "../../../types";

export function makeWrapperReview(explicitRole: boolean): NonNullable<StablecoinMeta["dependencyReview"]> {
  return {
    reviewedAt: "2026-07-21",
    reviewer: "test",
    confidence: "verified",
    sources: [{ label: "Wrapper evidence", url: "https://example.com/wrapper" }],
    rationale: "The reviewed relationship is a direct 1:1 wrapper claim.",
    relationships: [{
      id: "parent-a",
      weight: 1,
      type: "wrapper",
      ...(explicitRole ? { economicRole: "serial-claim" as const } : {}),
      reason: "Every child unit is a direct claim on one parent unit.",
    }],
  };
}
