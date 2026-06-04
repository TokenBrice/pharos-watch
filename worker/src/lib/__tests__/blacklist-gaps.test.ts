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

  it("skips distribution scans when the caller only needs diagnostic gap metrics", async () => {
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
    ], { requireMatch: true });

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, {
      recentWindowSec: 86_400,
      includeDistributions: false,
    });

    expect(result.statusDistribution).toEqual({});
    expect(result.sourceDistribution).toEqual({});
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-gap-status-distribution"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist-gap-source-distribution"))).toBe(false);
  });

  it("serves fresh cached diagnostic metrics without rescanning blacklist_events", async () => {
    const metrics = {
      totalEvents: 100,
      missingAmounts: 4,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.04,
      unrecoverableMissingAmounts: 3,
      oldestRecoverableAgeSec: 86_400,
      neverAttemptedCount: 2,
      repeatedFailureCount: 1,
      statusDistribution: {},
      sourceDistribution: {},
    };
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [{
          key: "blacklist:gap-metrics:v1:86400:core",
          value: JSON.stringify({
            version: 1,
            includeDistributions: false,
            recentWindowSec: 86_400,
            metrics,
          }),
          updated_at: 1_700_000_000 - 60,
        }],
      },
    ], { requireMatch: true });

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, {
      recentWindowSec: 86_400,
      includeDistributions: false,
      cacheTtlSec: 300,
    });

    expect(result).toEqual({
      ...metrics,
      oldestRecoverableAgeSec: 86_460,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist_events"))).toBe(false);
  });
});
