import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { CRON_TIMEOUT_MS } from "../../lib/cron-lease";
import { runCronDurationWatchdog } from "../cron-duration-watchdog";

const NOW = new Date("2026-06-10T03:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const SINCE_SEC = NOW_SEC - 7 * 86400;
const SYNC_TIMEOUT_MS = CRON_TIMEOUT_MS["sync-stablecoins"];
const LIVE_RESERVES_TIMEOUT_MS = CRON_TIMEOUT_MS["sync-live-reserves"];
const STALE_SLOT_CHILD_ERROR = "scheduled slot heartbeat stale; child job progress abandoned";
const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";
const STALE_SLOT_METADATA_REASON = "stale-slot-reconciled";

function statsMatcher(stats: {
  n: number;
  avg_ms: number;
  max_ms: number;
  cap_hits: number;
  recent_cap_hits?: number;
  budget_truncations?: number;
  recent_budget_truncations?: number;
  latest_cap_hit_at?: number | null;
  latest_budget_truncation_at?: number | null;
}): MockTableConfig {
  const row = {
    budget_truncations: 0,
    latest_cap_hit_at: null,
    latest_budget_truncation_at: null,
    recent_cap_hits: stats.recent_cap_hits ?? stats.cap_hits,
    recent_budget_truncations:
      stats.recent_budget_truncations ?? stats.budget_truncations ?? 0,
    ...stats,
  };
  return {
    match: "FROM cron_runs",
    matchBinds: [
      SYNC_TIMEOUT_MS,
      SYNC_TIMEOUT_MS,
      NOW_SEC - 24 * 3600,
      SYNC_TIMEOUT_MS,
      NOW_SEC - 24 * 3600,
      "sync-stablecoins",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
    ],
    rows: [row],
    first: row,
  };
}

function liveReservesStatsMatcher(stats: {
  n: number;
  avg_ms: number;
  max_ms: number;
  cap_hits: number;
  recent_cap_hits?: number;
  budget_truncations?: number;
  recent_budget_truncations?: number;
  latest_cap_hit_at?: number | null;
  latest_budget_truncation_at?: number | null;
}): MockTableConfig {
  const row = {
    budget_truncations: 0,
    latest_cap_hit_at: null,
    latest_budget_truncation_at: null,
    recent_cap_hits: stats.recent_cap_hits ?? stats.cap_hits,
    recent_budget_truncations:
      stats.recent_budget_truncations ?? stats.budget_truncations ?? 0,
    ...stats,
  };
  return {
    match: "FROM cron_runs",
    matchBinds: [
      LIVE_RESERVES_TIMEOUT_MS,
      LIVE_RESERVES_TIMEOUT_MS,
      NOW_SEC - 24 * 3600,
      LIVE_RESERVES_TIMEOUT_MS,
      NOW_SEC - 24 * 3600,
      "sync-live-reserves",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
    ],
    rows: [row],
    first: row,
  };
}

function slotStatsMatcher(rows: Record<string, unknown>[]): MockTableConfig {
  return {
    match: "FROM cron_slot_executions",
    rows,
    first: rows[0] ?? null,
  };
}

function durationStageBreakdownMatcher(rows: Record<string, unknown>[]): MockTableConfig {
  return {
    match: "GROUP BY stage_label",
    matchBinds: [
      SYNC_TIMEOUT_MS,
      "sync-stablecoins",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
      SYNC_TIMEOUT_MS,
    ],
    rows,
  };
}

function durationSamplesMatcher(rows: Record<string, unknown>[]): MockTableConfig {
  return {
    match: "SELECT started_at, duration_ms, status, error, metadata",
    matchBinds: [
      "sync-stablecoins",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
      SYNC_TIMEOUT_MS,
    ],
    rows,
  };
}

describe("runCronDurationWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays ok while averages sit under the 80% ceiling ratio", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.7), max_ms: SYNC_TIMEOUT_MS, cap_hits: 1 }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBeUndefined();
  });

  it("degrades when the 7d average crosses 80% of the ceiling", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.85), max_ms: SYNC_TIMEOUT_MS, cap_hits: 1 }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      breaching: ["sync-stablecoins"],
    });
  });

  it("degrades on repeated at-cap runs even with a healthy average", async () => {
    const db = mockD1([
      statsMatcher({
        n: 660,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS,
        cap_hits: 3,
        latest_cap_hit_at: NOW_SEC - 60,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({ breaching: ["sync-stablecoins"] });
  });

  it("degrades on repeated at-cap runs for low-cadence jobs below the trend sample floor", async () => {
    const db = mockD1([
      statsMatcher({
        n: 3,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS,
        cap_hits: 3,
        latest_cap_hit_at: NOW_SEC - 60,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: ["sync-stablecoins"],
      breaching: ["sync-stablecoins"],
    });
  });

  it("does not degrade when repeated at-cap history has fewer than three hits in the recent window", async () => {
    const db = mockD1([
      statsMatcher({
        n: 660,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS,
        cap_hits: 8,
        recent_cap_hits: 2,
        latest_cap_hit_at: NOW_SEC - 60,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);
    const metadata = JSON.parse(String(result.metadata));

    expect(result.status).toBeUndefined();
    expect(metadata.runtimeBreaching).toEqual([]);
    expect(metadata.stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job: "sync-stablecoins",
          capHits: 8,
          recentCapHits: 2,
        }),
      ]),
    );
  });

  it("degrades on repeated budget truncations below the trend sample floor", async () => {
    const db = mockD1([
      statsMatcher({
        n: 3,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS - 1,
        cap_hits: 0,
        budget_truncations: 3,
        latest_budget_truncation_at: NOW_SEC - 60,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: ["sync-stablecoins"],
      breaching: ["sync-stablecoins"],
    });
  });

  it("keeps recovered at-cap history visible without degrading", async () => {
    const db = mockD1([
      statsMatcher({
        n: 660,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS,
        cap_hits: 3,
        recent_cap_hits: 0,
        latest_cap_hit_at: NOW_SEC - 3 * 86400,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);
    const metadata = JSON.parse(String(result.metadata));

    expect(result.status).toBeUndefined();
    expect(metadata.runtimeCapRecentWindowSec).toBe(86400);
    expect(metadata.runtimeBreaching).toEqual([]);
    expect(metadata.stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job: "sync-stablecoins",
          capHits: 3,
          latestCapHitAt: NOW_SEC - 3 * 86400,
        }),
      ]),
    );
  });

  it("includes stage diagnostics for cap-hit runtime breaches", async () => {
    const db = mockD1([
      statsMatcher({
        n: 660,
        avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5),
        max_ms: SYNC_TIMEOUT_MS,
        cap_hits: 3,
        latest_cap_hit_at: NOW_SEC - 60,
      }),
      durationStageBreakdownMatcher([
        {
          stage_label: "publication",
          runs: 2,
          avg_ms: SYNC_TIMEOUT_MS + 100,
          max_ms: SYNC_TIMEOUT_MS + 500,
          cap_hits: 2,
          budget_truncations: 0,
        },
        {
          stage_label: "run-budget-truncated",
          runs: 1,
          avg_ms: SYNC_TIMEOUT_MS - 100,
          max_ms: SYNC_TIMEOUT_MS - 100,
          cap_hits: 0,
          budget_truncations: 1,
        },
      ]),
      durationSamplesMatcher([
        {
          started_at: NOW_SEC - 60,
          duration_ms: SYNC_TIMEOUT_MS + 500,
          status: "error",
          error: "timeout",
          metadata: JSON.stringify({
            stage: "publication",
            runBudgetTruncated: true,
            deferredCoins: 7,
            ignoredVerboseKey: "not surfaced",
          }),
        },
      ]),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      durationDiagnostics: [
        {
          job: "sync-stablecoins",
          timeoutMs: SYNC_TIMEOUT_MS,
          stageBreakdown: [
            {
              stage: "publication",
              runs: 2,
              capHits: 2,
            },
            {
              stage: "run-budget-truncated",
              runs: 1,
              budgetTruncations: 1,
            },
          ],
          samples: [
            {
              startedAt: NOW_SEC - 60,
              durationMs: SYNC_TIMEOUT_MS + 500,
              metadata: {
                stage: "publication",
                runBudgetTruncated: true,
                deferredCoins: 7,
                metadataKeys: expect.arrayContaining(["deferredCoins", "ignoredVerboseKey", "stage"]),
              },
            },
          ],
        },
      ],
    });
  });

  it("ignores jobs with too few runs for a trend", async () => {
    const db = mockD1([
      statsMatcher({ n: 5, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.95), max_ms: SYNC_TIMEOUT_MS, cap_hits: 0 }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBeUndefined();
  });

  it("excludes stale-slot reconciled child rows from runtime averages", async () => {
    const db = mockD1([
      statsMatcher({ n: 20, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.2), max_ms: SYNC_TIMEOUT_MS, cap_hits: 0 }),
    ]);

    const result = await runCronDurationWatchdog(db);
    const runtimeQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM cron_runs"));

    expect(result.status).toBeUndefined();
    expect(runtimeQueries.some((entry) => entry.binds.includes(STALE_SLOT_CHILD_ERROR))).toBe(true);
    expect(runtimeQueries.some((entry) => entry.binds.includes(STALE_SLOT_METADATA_REASON))).toBe(true);
    expect(runtimeQueries.every((entry) => !entry.sql.includes("LIKE"))).toBe(true);
    expect(runtimeQueries.some((entry) => entry.sql.includes("json_extract(metadata, '$.reason')"))).toBe(true);
  });

  it("keeps live reserve run-budget truncations as runtime pressure", async () => {
    const db = mockD1([
      liveReservesStatsMatcher({
        n: 42,
        avg_ms: Math.round(LIVE_RESERVES_TIMEOUT_MS * 0.5),
        max_ms: LIVE_RESERVES_TIMEOUT_MS - 1,
        cap_hits: 0,
        budget_truncations: 3,
        latest_budget_truncation_at: NOW_SEC - 60,
      }),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: ["sync-live-reserves"],
      slotAbandonmentBreaching: [],
      breaching: ["sync-live-reserves"],
    });
  });

  it("degrades on scheduled slot abandonment separately from runtime pressure", async () => {
    const db = mockD1([
      slotStatsMatcher([{
        slot_key: "hourlyYieldSync",
        slots: 168,
        error_slots: 56,
        abandoned_slots: 56,
        latest_abandoned_at: NOW_SEC - 60,
      }]),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: [],
      slotAbandonmentBreaching: ["hourlyYieldSync"],
      breaching: ["hourlyYieldSync"],
    });
    expect(db.getHistory().some((entry) => entry.binds.includes(STALE_SLOT_ERROR))).toBe(true);
    expect(db.getHistory().every((entry) => !entry.sql.includes("LIKE"))).toBe(true);
  });

  it("separates publication failures, terminal-accounting gaps, and preserved child success", async () => {
    const db = mockD1([
      slotStatsMatcher([{
        slot_key: "halfHourlyOffset",
        slots: 142,
        error_slots: 12,
        abandoned_slots: 37,
        not_started_slots: 3,
        publication_failure_slots: 2,
        terminal_accounting_unknown_slots: 10,
        real_child_failure_slots: 1,
        successful_child_terminal_slots: 24,
        latest_abandoned_at: NOW_SEC - 60,
      }]),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      slotStats: expect.arrayContaining([
        expect.objectContaining({
          scheduleKey: "halfHourlyOffset",
          abandonedSlots: 37,
          notStartedSlots: 3,
          publicationFailureSlots: 2,
          terminalAccountingUnknownSlots: 10,
          realChildFailureSlots: 1,
          successfulChildTerminalSlots: 24,
        }),
      ]),
    });
  });

  it("executes lifecycle classification against SQLite and fails legacy ambiguity closed", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE cron_runs (
        job TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT,
        error TEXT,
        metadata TEXT
      );
      CREATE TABLE cron_slot_executions (
        slot_key TEXT NOT NULL,
        slot_started_at INTEGER NOT NULL,
        result_status TEXT,
        metadata TEXT
      );
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    const insertSlot = sqlite.prepare(
      "INSERT INTO cron_slot_executions (slot_key, slot_started_at, result_status, metadata) VALUES (?, ?, ?, ?)",
    );
    for (let index = 0; index < 20; index++) {
      insertSlot.run("halfHourlyOffset", NOW_SEC - index * 60, "ok", null);
    }
    insertSlot.run("halfHourlyOffset", NOW_SEC - 30, "degraded", JSON.stringify({
      error: STALE_SLOT_ERROR,
      staleSlotReconciliation: {
        publicationFailures: 0,
        terminalAccountingUnknown: 1,
        realChildFailures: 0,
        successfulChildTerminals: 0,
        notStartedCronRuns: 0,
      },
    }));
    insertSlot.run("halfHourlyOffset", NOW_SEC - 20, "error", JSON.stringify({
      error: STALE_SLOT_ERROR,
      staleSlotReconciliation: {
        publicationFailures: 1,
        terminalAccountingUnknown: 0,
        realChildFailures: 0,
        successfulChildTerminals: 0,
        notStartedCronRuns: 0,
      },
    }));
    insertSlot.run("halfHourlyOffset", NOW_SEC - 10, "error", JSON.stringify({ error: STALE_SLOT_ERROR }));
    insertSlot.run("halfHourlyOffset", NOW_SEC - 5, "error", JSON.stringify({
      error: STALE_SLOT_ERROR,
      staleSlotReconciliation: {
        publicationFailures: 0,
        terminalAccountingUnknown: 0,
        realChildFailures: 0,
        successfulChildTerminals: 0,
        notStartedCronRuns: 1,
      },
    }));

    const result = await runCronDurationWatchdog(createSqliteD1(sqlite));
    const metadata = JSON.parse(String(result.metadata));

    expect(result.status).toBe("degraded");
    expect(metadata.slotStats).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scheduleKey: "halfHourlyOffset",
        abandonedSlots: 4,
        notStartedSlots: 1,
        publicationFailureSlots: 1,
        terminalAccountingUnknownSlots: 2,
      }),
    ]));
    sqlite.close();
  });

  it("keeps recovered slot abandonment history visible without degrading", async () => {
    const db = mockD1([
      slotStatsMatcher([{
        slot_key: "hourlyYieldSync",
        slots: 168,
        error_slots: 42,
        abandoned_slots: 42,
        latest_abandoned_at: NOW_SEC - 3 * 86400,
      }]),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBeUndefined();
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      slotAbandonmentRecentWindowSec: 86400,
      slotAbandonmentBreaching: [],
      slotStats: expect.arrayContaining([
        expect.objectContaining({
          scheduleKey: "hourlyYieldSync",
          abandonedSlots: 42,
          latestAbandonedAt: NOW_SEC - 3 * 86400,
        }),
      ]),
    });
  });

  it("does not degrade on low-ratio slot abandonment noise", async () => {
    const db = mockD1([
      slotStatsMatcher([{
        slot_key: "quarterHourly",
        slots: 672,
        error_slots: 19,
        abandoned_slots: 14,
        latest_abandoned_at: NOW_SEC - 60,
      }]),
    ]);

    const result = await runCronDurationWatchdog(db);

    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(String(result.metadata));
    expect(metadata.slotStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleKey: "quarterHourly",
          abandonedSlots: 14,
          abandonmentRatio: 14 / 672,
        }),
      ]),
    );
  });
});
