import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { queryBlacklistGapMetrics } from "../blacklist-gaps";

describe("queryBlacklistGapMetrics", () => {
  it("returns extended recoverable-gap telemetry", async () => {
    const db = mockD1([
      {
        match: "blacklist-gap-aggregate",
        rows: [],
        first: {
          total: 100,
          missing: 4,
          missing_recent: 1,
          oldest_gap_age_sec: 86400,
          never_attempted: 2,
          repeated_failures: 1,
          unrecoverable: 3,
        },
      },
      {
        match: "blacklist-gap-status-distribution",
        rows: [
          { amount_status: "resolved", n: 93 },
          { amount_status: "recoverable_pending", n: 4 },
          { amount_status: "permanently_unavailable", n: 3 },
        ],
      },
      {
        match: "blacklist-gap-source-distribution",
        rows: [
          { amount_source: "event", n: 93 },
          { amount_source: "unavailable", n: 7 },
        ],
      },
    ], { requireMatch: true });

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, 86_400);

    expect(result).toEqual({
      totalEvents: 100,
      missingAmounts: 4,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.04,
      unrecoverableMissingAmounts: 3,
      oldestRecoverableAgeSec: 86_400,
      neverAttemptedCount: 2,
      repeatedFailureCount: 1,
      statusDistribution: {
        resolved: 93,
        recoverable_pending: 4,
        permanently_unavailable: 3,
      },
      sourceDistribution: {
        event: 93,
        unavailable: 7,
      },
    });
  });
});
