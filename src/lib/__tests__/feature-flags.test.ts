import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG_LIFECYCLE,
  FEATURE_FLAGS,
  type FeatureFlagLifecycle,
} from "../feature-flags";

describe("feature flag lifecycle", () => {
  it("keeps lifecycle metadata aligned with the boolean flag API", () => {
    expect(Object.keys(FEATURE_FLAG_LIFECYCLE)).toEqual(Object.keys(FEATURE_FLAGS));

    for (const lifecycle of Object.values(FEATURE_FLAG_LIFECYCLE)) {
      expect(lifecycle.owner).toBe("tokenbrice");
      expect(lifecycle.retirementCriterion.trim()).not.toBe("");
    }
  });

  it("stagger dates for every temporary flag and keeps hero verdict permanent", () => {
    const temporary = Object.values(FEATURE_FLAG_LIFECYCLE).filter(
      (lifecycle): lifecycle is FeatureFlagLifecycle & { expiresAt: string } =>
        "expiresAt" in lifecycle,
    );
    const expiries = temporary.map((lifecycle) => lifecycle.expiresAt);

    expect(temporary).toHaveLength(6);
    expect(new Set(expiries).size).toBe(temporary.length);
    expect(expiries).toEqual([
      "2026-10-15",
      "2026-11-01",
      "2026-11-15",
      "2026-12-01",
      "2026-12-15",
      "2027-01-05",
    ]);
    expect("expiresAt" in FEATURE_FLAG_LIFECYCLE.heroVerdict).toBe(false);
  });
});
