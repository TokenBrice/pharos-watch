import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { queryBlacklistGapMetrics } from "../blacklist-gaps";

describe("queryBlacklistGapMetrics", () => {
  it("returns extended recoverable-gap telemetry", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [],
        first: {
          total: 100,
          missing: 4,
          missing_recent: 1,
          oldest_gap_age_sec: 86400,
          never_attempted: 2,
          repeated_failures: 1,
        },
      },
    ], { requireMatch: true });

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, 86_400);

    expect(result).toEqual({
      totalEvents: 100,
      missingAmounts: 4,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.04,
      oldestRecoverableAgeSec: 86_400,
      neverAttemptedCount: 2,
      repeatedFailureCount: 1,
    });
  });
});
