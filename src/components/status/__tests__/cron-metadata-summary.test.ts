import { describe, expect, it } from "vitest";
import { summarizeCronMetadata } from "../cron-metadata-summary";

describe("summarizeCronMetadata", () => {
  it("surfaces when the redemption missing-capacity tail is within tolerance", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 146,
      configured: 146,
      resolved: 144,
      unresolved: 2,
      coverageRatio: 144 / 146,
      unresolvedMissingCapacity: 2,
      unresolvedCritical: 0,
      missingCapacityOkThreshold: 2,
      dynamic: 5,
      estimated: 139,
      static: 2,
    });

    expect(summary).toContain("missing-capacity tail 2 within 2-coin tolerance");
  });

  it("surfaces when the redemption missing-capacity tail exceeds tolerance", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 101,
      configured: 101,
      resolved: 98,
      unresolved: 3,
      coverageRatio: 98 / 101,
      unresolvedMissingCapacity: 3,
      unresolvedCritical: 0,
      missingCapacityOkThreshold: 2,
      dynamic: 0,
      estimated: 98,
      static: 3,
    });

    expect(summary).toContain("missing-capacity tail 3 exceeds 2-coin tolerance");
  });

  it("surfaces redemption availability impairments", () => {
    const summary = summarizeCronMetadata("sync-redemption-backstops", {
      synced: 148,
      configured: 148,
      resolved: 147,
      unresolved: 1,
      unresolvedMissingCapacity: 0,
      unresolvedCritical: 1,
      availabilityDegraded: 1,
      dynamic: 5,
      estimated: 142,
      static: 1,
    });

    expect(summary).toContain("availability impaired 1");
  });
});
