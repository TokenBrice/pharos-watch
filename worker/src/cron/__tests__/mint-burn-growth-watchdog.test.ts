import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
  runMintBurnGrowthWatchdog,
} from "../mint-burn-growth-watchdog";

const WEBHOOK_URL = "https://example.com/webhook";

describe("runMintBurnGrowthWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T03:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns ok below the threshold without alerting", async () => {
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: 1_430_000 },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1_430_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("degrades and alerts when the growth budget is exceeded", async () => {
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1 },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(result.metadata))).toMatchObject({ alerted: true });
    expect(
      db.getHistory().some(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === "mint-burn-growth-watchdog:alert:direct:v1",
      ),
    ).toBe(true);
  });

  it("suppresses re-alerts inside the weekly cooldown", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1 },
      },
      {
        match: "cache",
        matchBinds: ["mint-burn-growth-watchdog:alert:direct:v1"],
        rows: [],
        first: {
          key: "mint-burn-growth-watchdog:alert:direct:v1",
          value: JSON.stringify({ lastAlertedAt: nowSec - 3600, rowCount: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD }),
          updated_at: nowSec - 3600,
        },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db, WEBHOOK_URL);

    expect(result.status).toBe("degraded");
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.metadata))).toMatchObject({ alerted: false, suppressedByCooldown: true });
  });

  it("ignores the legacy marker and writes only the direct-delivery marker", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1 },
      },
      {
        match: "cache",
        rows: [],
        first: {
          key: "mint-burn-growth-watchdog:alert",
          value: JSON.stringify({ lastAlertedAt: nowSec - 3600, rowCount: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD }),
          updated_at: nowSec - 3600,
        },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db, WEBHOOK_URL);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(result.metadata))).toMatchObject({ alerted: true, suppressedByCooldown: false });
  });

  it("does not advance the direct marker when webhook delivery fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failed", { status: 500 })));
    const db = mockD1([
      {
        match: "mint_burn_events",
        rows: [],
        first: { row_count: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD + 1 },
      },
    ]);

    const result = await runMintBurnGrowthWatchdog(db, WEBHOOK_URL);

    expect(JSON.parse(String(result.metadata))).toMatchObject({ alerted: false, suppressedByCooldown: false });
    expect(
      db.getHistory().some(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO cache") &&
          entry.binds[0] === "mint-burn-growth-watchdog:alert:direct:v1",
      ),
    ).toBe(false);
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("growth watchdog aborted"));

    await expect(runMintBurnGrowthWatchdog(mockD1(), WEBHOOK_URL, controller.signal)).rejects.toThrow(
      "growth watchdog aborted",
    );
  });
});
