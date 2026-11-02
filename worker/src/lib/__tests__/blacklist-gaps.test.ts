import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { BLACKLIST_PROOF_CATCHUP_WINDOW_SEC, BLACKLIST_RECENT_WINDOW_SEC, getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import {
  BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
  materializeBlacklistGapMetrics,
  queryBlacklistGapMetrics,
} from "../blacklist-gaps";
import { getBlacklistGapMetricsCacheKey } from "../blacklist-cache-keys";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("queryBlacklistGapMetrics", () => {
  it.each(["classificationMissingAmounts", "classificationWatchCount"])("rejects cached metrics missing internal %s", async (field) => {
    const now = 1_800_000_000;
    const { sqlite, db } = fixtures.open();
    const metrics = await queryBlacklistGapMetrics(db, now, { includeDistributions: false });
    const cached: Record<string, unknown> = { ...metrics, missingAmounts: 5, missingRatio: 1 };
    delete cached[field];
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      getBlacklistGapMetricsCacheKey({ recentWindowSec: BLACKLIST_RECENT_WINDOW_SEC, includeDistributions: false }, "request"),
      JSON.stringify({ version: 3, recentWindowSec: BLACKLIST_RECENT_WINDOW_SEC, includeDistributions: false, metrics: cached }),
      now,
    );
    expect(await queryBlacklistGapMetrics(db, now, { includeDistributions: false, cacheTtlSec: 300 })).toEqual(metrics);
  });

  it.each([
    ["queued EVM freeze", "ethereum", "blacklist", "recoverable_pending", BLACKLIST_RECENT_WINDOW_SEC + 1, 0, 1],
    ["recent queued EVM freeze", "ethereum", "blacklist", "recoverable_pending", 60, 0, 1],
    ["catch-up boundary", "ethereum", "blacklist", "recoverable_pending", BLACKLIST_PROOF_CATCHUP_WINDOW_SEC, 0, 1],
    ["expired EVM freeze", "ethereum", "blacklist", "recoverable_pending", BLACKLIST_PROOF_CATCHUP_WINDOW_SEC + 1, 1, 0],
    ["failed EVM freeze", "ethereum", "blacklist", "provider_failed", BLACKLIST_RECENT_WINDOW_SEC + 1, 1, 0],
    ["ambiguous EVM freeze", "ethereum", "blacklist", "ambiguous", 60, 1, 1],
    ["Tron freeze", "tron", "blacklist", "recoverable_pending", BLACKLIST_RECENT_WINDOW_SEC + 1, 1, 0],
    ["EVM destroy", "ethereum", "destroy", "recoverable_pending", BLACKLIST_RECENT_WINDOW_SEC + 1, 1, 0],
    ["recent Tron freeze", "tron", "blacklist", "recoverable_pending", 60, 1, 1],
    ["recent EVM destroy", "ethereum", "destroy", "recoverable_pending", 60, 1, 1],
    ["legacy re-review", "ethereum", "blacklist", "permanently_unavailable", 60, 0, 0],
  ] as const)("classifies %s while retaining raw gap counts", async (_name, chainId, eventType, status, age, missing, recent) => {
    const now = 1_800_000_000;
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url, amount_status)
      VALUES ('event', 'USDT', ?, ?, ?, 'address', 'tx', 1, ?, '', '', ?)`)
      .run(chainId, chainId, eventType, now - age, status);

    const metrics = await queryBlacklistGapMetrics(db, now, { includeDistributions: false });
    const rawMissing = status === "permanently_unavailable" ? 0 : 1;
    expect(metrics).toMatchObject({
      totalEvents: 1,
      missingAmounts: rawMissing,
      recentMissingAmounts: age <= BLACKLIST_RECENT_WINDOW_SEC ? rawMissing : 0,
      missingRatio: rawMissing,
      classificationMissingAmounts: missing,
      classificationWatchCount: recent,
    });
    expect(getBlacklistGapStatus({ missingRatio: metrics.classificationMissingAmounts })).toBe(missing ? "stale" : "healthy");
  });

  it("rejects an absent aggregate without writing fabricated metrics", async () => {
    const db = mockD1([
      { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
      { match: "blacklist-gap-aggregate", rows: [], first: null },
    ]);
    await expect(queryBlacklistGapMetrics(db, 1_700_000_000, {
      includeDistributions: false,
      cacheTtlSec: 300,
    })).rejects.toThrow("blacklist-gap-aggregate-missing");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT"))).toBe(false);
  });

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
    ]);

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, 86_400);

    expect(result).toEqual({
      totalEvents: 100,
      missingAmounts: 4,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.04,
      classificationMissingAmounts: 4,
      classificationWatchCount: 1,
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
    ]);

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
      classificationMissingAmounts: 4,
      classificationWatchCount: 1,
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
          key: "blacklist:gap-metrics:v3:86400:core",
          value: JSON.stringify({
            version: 3,
            includeDistributions: false,
            recentWindowSec: 86_400,
            metrics,
          }),
          updated_at: 1_700_000_000 - 60,
        }],
      },
    ]);

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
      classificationMissingAmounts: 2,
      classificationWatchCount: 1,
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
          key: "blacklist:gap-metrics:producer:v3:86400:core",
          value: JSON.stringify({
            version: 3,
            includeDistributions: false,
            recentWindowSec: 86_400,
            metrics,
          }),
          updated_at: 1_700_000_000 - 120,
        }],
      },
    ]);

    const result = await queryBlacklistGapMetrics(db, 1_700_000_000, {
      recentWindowSec: 86_400,
      includeDistributions: false,
      producerSnapshotTtlSec: 43_200,
      cacheTtlSec: 300,
    });

    expect(result.oldestRecoverableAgeSec).toBe(3720);
    expect(db.getHistory()).toHaveLength(1);
    expect(db.getHistory()[0]?.binds).toEqual(["blacklist:gap-metrics:producer:v3:86400:core"]);
  });

  it("rejects producer snapshots past the surface freshness budget", async () => {
    const now = 1_800_000_000;
    const { sqlite, db } = fixtures.open();
    const options = { recentWindowSec: 86_400, includeDistributions: false };
    const metrics = (totalEvents: number) => ({
      totalEvents,
      missingAmounts: 2,
      recentMissingAmounts: 1,
      recentWindowSec: 86_400,
      missingRatio: 0.1,
      classificationMissingAmounts: 2,
      classificationWatchCount: 1,
      unrecoverableMissingAmounts: 0,
      oldestRecoverableAgeSec: 3600,
      neverAttemptedCount: 1,
      repeatedFailureCount: 0,
      statusDistribution: {},
      sourceDistribution: {},
    });
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(
      getBlacklistGapMetricsCacheKey(options, "producer"),
      JSON.stringify({
        version: 3,
        includeDistributions: false,
        recentWindowSec: 86_400,
        metrics: metrics(999),
      }),
      now - 7 * 3600,
    );
    insert.run(
      getBlacklistGapMetricsCacheKey(options, "request"),
      JSON.stringify({
        version: 3,
        includeDistributions: false,
        recentWindowSec: 86_400,
        metrics: metrics(20),
      }),
      now - 60,
    );

    const result = await queryBlacklistGapMetrics(db, now, {
      ...options,
      producerSnapshotTtlSec: BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
      cacheTtlSec: 300,
    });

    expect(result.totalEvents).toBe(20);
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
    ]);

    const result = await materializeBlacklistGapMetrics(db, 1_700_000_000, 86_400, 1_699_999_000);

    expect(result).toEqual({ written: 2 });
    const writes = db.getHistory().filter((entry) => entry.sql.includes("blacklist-gap-metrics-cache-write"));
    expect(writes.map((entry) => entry.binds[0]).sort()).toEqual([
      "blacklist:gap-metrics:producer:v3:86400:core",
      "blacklist:gap-metrics:producer:v3:86400:full",
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
