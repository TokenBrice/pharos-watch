import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG_LIFECYCLE,
  FEATURE_FLAGS,
  type FeatureFlagLifecycle,
} from "../feature-flags";

describe("feature flag lifecycle", () => {
  it("keeps lifecycle metadata aligned with the boolean flag API", () => {
    expect(new Set(Object.keys(FEATURE_FLAG_LIFECYCLE))).toEqual(new Set(Object.keys(FEATURE_FLAGS)));

    for (const lifecycle of Object.values(FEATURE_FLAG_LIFECYCLE)) {
      expect(lifecycle.owner.trim()).not.toBe("");
      expect(lifecycle.retirementCriterion.trim()).not.toBe("");
    }
  });

  it("requires valid temporary expiry dates and keeps hero verdict permanent", () => {
    const temporary = Object.values(FEATURE_FLAG_LIFECYCLE).filter(
      (lifecycle): lifecycle is FeatureFlagLifecycle & { expiresAt: string } =>
        "expiresAt" in lifecycle,
    );
    for (const { expiresAt } of temporary) {
      expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(expiresAt).toISOString().slice(0, 10)).toBe(expiresAt);
    }
    expect("expiresAt" in FEATURE_FLAG_LIFECYCLE.heroVerdict).toBe(false);
  });
});
