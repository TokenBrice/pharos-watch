import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { CRON_TIMEOUT_MS } from "../../lib/cron-lease";
import { runCronDurationWatchdog } from "../cron-duration-watchdog";

const WEBHOOK_URL = "https://example.com/webhook";
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
  budget_truncations?: number;
}): MockTableConfig {
  return {
    match: "FROM cron_runs",
    matchBinds: [
      SYNC_TIMEOUT_MS,
      "sync-stablecoins",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
    ],
    rows: [{ budget_truncations: 0, ...stats }],
    first: { budget_truncations: 0, ...stats },
  };
}

function liveReservesStatsMatcher(stats: {
  n: number;
  avg_ms: number;
  max_ms: number;
  cap_hits: number;
  budget_truncations?: number;
}): MockTableConfig {
  return {
    match: "FROM cron_runs",
    matchBinds: [
      LIVE_RESERVES_TIMEOUT_MS,
      "sync-live-reserves",
      SINCE_SEC,
      STALE_SLOT_CHILD_ERROR,
      STALE_SLOT_METADATA_REASON,
    ],
    rows: [{ budget_truncations: 0, ...stats }],
    first: { budget_truncations: 0, ...stats },
  };
}

function slotStatsMatcher(rows: Record<string, unknown>[]): MockTableConfig {
  return {
    match: "FROM cron_slot_executions",
    rows,
    first: rows[0] ?? null,
  };
}

describe("runCronDurationWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays ok while averages sit under the 80% ceiling ratio", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.7), max_ms: SYNC_TIMEOUT_MS, cap_hits: 1 }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("degrades and alerts when the 7d average crosses 80% of the ceiling", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.85), max_ms: SYNC_TIMEOUT_MS, cap_hits: 1 }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      breaching: ["sync-stablecoins"],
      alerted: true,
    });
  });

  it("alerts on repeated at-cap runs even with a healthy average", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.5), max_ms: SYNC_TIMEOUT_MS, cap_hits: 3 }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({ breaching: ["sync-stablecoins"] });
  });

  it("ignores jobs with too few runs for a trend", async () => {
    const db = mockD1([
      statsMatcher({ n: 5, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.95), max_ms: SYNC_TIMEOUT_MS, cap_hits: 0 }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses re-alerts inside the weekly cooldown", async () => {
    const db = mockD1([
      statsMatcher({ n: 660, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.85), max_ms: SYNC_TIMEOUT_MS, cap_hits: 1 }),
      {
        match: "cache",
        matchBinds: ["cron-duration-watchdog:alert"],
        rows: [],
        first: {
          key: "cron-duration-watchdog:alert",
          value: JSON.stringify({ lastAlertedAt: NOW_SEC - 3600 }),
          updated_at: NOW_SEC - 3600,
        },
      },
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.metadata))).toMatchObject({ alerted: false, suppressedByCooldown: true });
  });

  it("excludes stale-slot reconciled child rows from runtime averages", async () => {
    const db = mockD1([
      statsMatcher({ n: 20, avg_ms: Math.round(SYNC_TIMEOUT_MS * 0.2), max_ms: SYNC_TIMEOUT_MS, cap_hits: 0 }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);
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
      }),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: ["sync-live-reserves"],
      slotAbandonmentBreaching: [],
      breaching: ["sync-live-reserves"],
      alerted: true,
    });
  });

  it("alerts on scheduled slot abandonment separately from runtime pressure", async () => {
    const db = mockD1([
      slotStatsMatcher([{
        slot_key: "hourlyYieldSync",
        slots: 168,
        error_slots: 56,
        abandoned_slots: 56,
        latest_abandoned_at: NOW_SEC - 60,
      }]),
    ]);

    const result = await runCronDurationWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      runtimeBreaching: [],
      slotAbandonmentBreaching: ["hourlyYieldSync"],
      breaching: ["hourlyYieldSync"],
      alerted: true,
    });
    expect(db.getHistory().some((entry) => entry.binds.includes(STALE_SLOT_ERROR))).toBe(true);
    expect(db.getHistory().every((entry) => !entry.sql.includes("LIKE"))).toBe(true);
  });
});
