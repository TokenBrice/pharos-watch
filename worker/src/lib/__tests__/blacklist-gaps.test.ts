import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { materializeBlacklistGapMetrics, queryBlacklistGapMetrics } from "../blacklist-gaps";

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

  it("prefers fresh producer snapshots before request-cache fallback", async () => {
    const metrics = {
      totalEvents: 20,
      missingAmounts: 2,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.1,
      unrecoverableMissingAmounts: 0,
      oldestRecoverableAgeSec: 3600,
      neverAttemptedCount: 1,
      repeatedFailureCount: 0,
      statusDistribution: {},
      sourceDistribution: {},
    };
    const db = mockD1([
      {
        match: "blacklist-gap-metrics-cache-read",
        rows: [{
          key: "blacklist:gap-metrics:producer:v1:86400:core",
          value: JSON.stringify({
            version: 1,
            includeDistributions: false,
            recentWindowSec: 86_400,
            metrics,
          }),
          updated_at: 1_700_000_000 - 120,
        }],
      },
    ], { requireMatch: true });

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, {
      recentWindowSec: 86_400,
      includeDistributions: false,
      producerSnapshotTtlSec: 43_200,
      cacheTtlSec: 300,
    });

    expect(result.oldestRecoverableAgeSec).toBe(3720);
    expect(db.getHistory()).toHaveLength(1);
    expect(db.getHistory()[0]?.binds).toEqual(["blacklist:gap-metrics:producer:v1:86400:core"]);
  });

  it("materializes full and core producer snapshots from one live full query", async () => {
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
      { match: "blacklist-gap-metrics-cache-write", rows: [] },
    ], { requireMatch: true });

    const result = await materializeBlacklistGapMetrics(db, 1_700_000_000, 86_400, 1_699_999_000);

    expect(result).toEqual({ written: 2 });
    const writes = db.getHistory().filter((entry) => entry.sql.includes("blacklist-gap-metrics-cache-write"));
    expect(writes.map((entry) => entry.binds[0]).sort()).toEqual([
      "blacklist:gap-metrics:producer:v1:86400:core",
      "blacklist:gap-metrics:producer:v1:86400:full",
    ]);
    expect(writes.every((entry) => entry.binds[2] === 1_699_999_000)).toBe(true);
    expect(writes.every((entry) => {
      const payload = JSON.parse(String(entry.binds[1])) as { materializedAt?: number };
      return payload.materializedAt === 1_700_000_000;
    })).toBe(true);
    expect(db.getHistory().filter((entry) => entry.sql.includes("blacklist-gap-aggregate"))).toHaveLength(1);
    expect(db.getHistory().filter((entry) => entry.sql.includes("blacklist-gap-status-distribution"))).toHaveLength(1);
    expect(db.getHistory().filter((entry) => entry.sql.includes("blacklist-gap-source-distribution"))).toHaveLength(1);
  });
});
