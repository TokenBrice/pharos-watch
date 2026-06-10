import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { CRON_TIMEOUT_MS } from "../../lib/cron-lease";
import { runCronDurationWatchdog } from "../cron-duration-watchdog";

const WEBHOOK_URL = "https://example.com/webhook";
const NOW = new Date("2026-06-10T03:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const SINCE_SEC = NOW_SEC - 7 * 86400;
const SYNC_TIMEOUT_MS = CRON_TIMEOUT_MS["sync-stablecoins"];

function statsMatcher(stats: { n: number; avg_ms: number; max_ms: number; cap_hits: number }): MockTableConfig {
  return {
    match: "FROM cron_runs",
    matchBinds: [SYNC_TIMEOUT_MS, "sync-stablecoins", SINCE_SEC],
    rows: [stats],
    first: stats,
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
});
