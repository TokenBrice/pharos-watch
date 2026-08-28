import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const { runTelegramInactiveCleanup } = await import("../telegram-inactive-cleanup");

const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (databases.length > 0) databases.pop()?.close();
});

const ONE_DAY_SEC = 86_400;
const INACTIVE_RETENTION_SEC = 180 * ONE_DAY_SEC;
const RUN_INTERVAL_SEC = 7 * ONE_DAY_SEC;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";

function setupLatestSchemaSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const result = createLatestSchemaSqlite();
  databases.push(result.sqlite);
  return result;
}

type GlobalAlertColumn =
  | "global_alert_dews"
  | "global_alert_depeg"
  | "global_alert_safety"
  | "global_alert_launch"
  | "global_alert_reserve"
  | "global_alert_freeze";

function insertSubscriber(
  sqlite: DatabaseSync,
  chatId: string,
  lastActiveAt: number,
  globalAlert?: GlobalAlertColumn,
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
       VALUES (?, ?, ?)`,
    )
    .run(chatId, lastActiveAt, lastActiveAt);
  if (globalAlert) {
    sqlite.prepare(`UPDATE telegram_subscribers SET ${globalAlert} = 1 WHERE chat_id = ?`).run(chatId);
  }
}

interface SubscriptionState {
  alertDews: number;
  alertDepeg: number;
  alertSafety: number;
  alertLaunch: number;
  alertReserve: number;
  alertFreeze: number;
  alertDewsOverride: number;
  alertDepegOverride: number;
  alertSafetyOverride: number;
  alertLaunchOverride: number;
  alertReserveOverride: number;
  alertFreezeOverride: number;
  dewsMinBand: string | null;
  safetyMode: string | null;
  depegWorseningBpsStep: number | null;
  alertSnoozeUntilTs: number | null;
}

const EMPTY_SUBSCRIPTION_STATE: SubscriptionState = {
  alertDews: 0,
  alertDepeg: 0,
  alertSafety: 0,
  alertLaunch: 0,
  alertReserve: 0,
  alertFreeze: 0,
  alertDewsOverride: 0,
  alertDepegOverride: 0,
  alertSafetyOverride: 0,
  alertLaunchOverride: 0,
  alertReserveOverride: 0,
  alertFreezeOverride: 0,
  dewsMinBand: null,
  safetyMode: null,
  depegWorseningBpsStep: null,
  alertSnoozeUntilTs: null,
};

function insertSubscription(
  sqlite: DatabaseSync,
  chatId: string,
  overrides: Partial<SubscriptionState> = {},
): void {
  const state = { ...EMPTY_SUBSCRIPTION_STATE, ...overrides };
  sqlite
    .prepare(
      `INSERT INTO telegram_subscriptions (
         chat_id,
         stablecoin_id,
         alert_dews,
         alert_depeg,
         alert_safety,
         alert_launch,
         alert_reserve,
         alert_freeze,
         alert_dews_override,
         alert_depeg_override,
         alert_safety_override,
         alert_launch_override,
         alert_reserve_override,
         alert_freeze_override,
         dews_min_band,
         safety_mode,
         depeg_worsening_bps_step,
         alert_snooze_until_ts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatId,
      `coin-${chatId}`,
      state.alertDews,
      state.alertDepeg,
      state.alertSafety,
      state.alertLaunch,
      state.alertReserve,
      state.alertFreeze,
      state.alertDewsOverride,
      state.alertDepegOverride,
      state.alertSafetyOverride,
      state.alertLaunchOverride,
      state.alertReserveOverride,
      state.alertFreezeOverride,
      state.dewsMinBand,
      state.safetyMode,
      state.depegWorseningBpsStep,
      state.alertSnoozeUntilTs,
    );
}

function listSubscriberIds(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare("SELECT chat_id FROM telegram_subscribers ORDER BY chat_id").all() as Array<{ chat_id: string }>)
    .map((row) => row.chat_id);
}

describe("runTelegramInactiveCleanup", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("inactive cleanup aborted"));
    const { db } = setupLatestSchemaSqlite();
    await expect(runTelegramInactiveCleanup(db, controller.signal)).rejects.toThrow(
      "inactive cleanup aborted",
    );
  });

  it("deletes inactive subscribers with no children and writes the cache guard", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriber(sqlite, "stale-1", now - INACTIVE_RETENTION_SEC - 86_400);
    insertSubscriber(sqlite, "stale-2", now - INACTIVE_RETENTION_SEC - 3600);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(listSubscriberIds(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(CACHE_LAST_RUN_KEY)).toBeTruthy();
    const metadata = JSON.parse(result.metadata!) as {
      cutoffSec: number;
      deleted: number;
      cappedAtLimit: boolean;
    };
    expect(metadata.deleted).toBe(2);
    expect(metadata.cappedAtLimit).toBe(false);
  });

  it("preserves recently-active subscribers and chats with meaningful child state", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - INACTIVE_RETENTION_SEC - 1;
    for (const chatId of ["has-sub", "has-preset", "has-pending-alert", "has-pending-disambig", "has-recap", "eligible"]) {
      insertSubscriber(sqlite, chatId, staleAt);
    }
    insertSubscriber(sqlite, "active", now - 3600);
    insertSubscription(sqlite, "has-sub", { alertDews: 1 });
    sqlite.prepare(
      `INSERT INTO telegram_preset_subscriptions
         (chat_id, preset_id, alert_dews, created_at, updated_at)
       VALUES ('has-preset', 'usd-top25', 1, ?, ?)`,
    ).run(staleAt, staleAt);
    sqlite.prepare(
      "INSERT INTO telegram_pending_alerts (chat_id, message_html, created_at) VALUES ('has-pending-alert', 'pending', ?)",
    ).run(staleAt);
    sqlite.prepare(
      `INSERT INTO telegram_pending_disambiguation
         (chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at)
       VALUES ('has-pending-disambig', '[]', '[]', 'USD', '[]', '[]', ?)`,
    ).run(now + ONE_DAY_SEC);
    sqlite.prepare(
      `INSERT INTO telegram_recap_preferences (chat_id, enabled, created_at, updated_at)
       VALUES ('has-recap', 1, ?, ?)`,
    ).run(staleAt, staleAt);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual([
      "active",
      "has-pending-alert",
      "has-pending-disambig",
      "has-preset",
      "has-recap",
      "has-sub",
    ]);
  });

  it("preserves inactive subscribers that only have global alert flags", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - INACTIVE_RETENTION_SEC - 1;
    const globalAlerts: Array<[string, GlobalAlertColumn]> = [
      ["global-dews", "global_alert_dews"],
      ["global-depeg", "global_alert_depeg"],
      ["global-safety", "global_alert_safety"],
      ["global-launch", "global_alert_launch"],
      ["global-reserve", "global_alert_reserve"],
      ["global-freeze", "global_alert_freeze"],
    ];
    for (const [chatId, column] of globalAlerts) insertSubscriber(sqlite, chatId, staleAt, column);
    insertSubscriber(sqlite, "eligible", staleAt);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual([
      "global-depeg",
      "global-dews",
      "global-freeze",
      "global-launch",
      "global-reserve",
      "global-safety",
    ]);
  });

  it("caps deletions at 100 per run and marks cappedAtLimit when reached", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 150; i++) {
      insertSubscriber(sqlite, `stale-${i}`, now - INACTIVE_RETENTION_SEC - (i + 1));
    }

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(100);
    expect(listSubscriberIds(sqlite)).toHaveLength(50);
    const metadata = JSON.parse(result.metadata!) as { cappedAtLimit: boolean };
    expect(metadata.cappedAtLimit).toBe(true);
  });

  it("skips real work when the cache guard is still warm", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(CACHE_LAST_RUN_KEY, String(now - ONE_DAY_SEC), now - ONE_DAY_SEC);
    insertSubscriber(sqlite, "stale-1", now - INACTIVE_RETENTION_SEC - 1);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(0);
    expect(listSubscriberIds(sqlite)).toEqual(["stale-1"]);
    const metadata = JSON.parse(result.metadata!) as { skipped: string };
    expect(metadata.skipped).toBe("cache-guard");
  });

  it("runs again after the 7-day interval elapses", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(CACHE_LAST_RUN_KEY, String(now - RUN_INTERVAL_SEC - 60), now - RUN_INTERVAL_SEC - 60);
    insertSubscriber(sqlite, "stale-1", now - INACTIVE_RETENTION_SEC - 1);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual([]);
  });

  it("clears telegram_chat_delivery_diagnostics when a chat is purged", async () => {
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    insertSubscriber(sqlite, "stale-1", now - INACTIVE_RETENTION_SEC - ONE_DAY_SEC);
    sqlite.prepare(
      "INSERT INTO telegram_chat_delivery_diagnostics (chat_id, updated_at) VALUES (?, ?), (?, ?)",
    ).run("stale-1", now, "active", now);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_chat_delivery_diagnostics").all()).toEqual([
      { chat_id: "active" },
    ]);
  });

  it("does not warn or expire live follows across the inactivity boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Bot API call"));
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);

    insertSubscriber(sqlite, "empty-179d", now - 179 * ONE_DAY_SEC);
    insertSubscriber(sqlite, "empty-181d", now - 181 * ONE_DAY_SEC);
    insertSubscriber(sqlite, "live-175d", now - 175 * ONE_DAY_SEC);
    insertSubscription(sqlite, "live-175d", { alertDepeg: 1 });
    insertSubscriber(sqlite, "live-365d", now - 365 * ONE_DAY_SEC);
    insertSubscription(sqlite, "live-365d", { alertReserve: 1 });

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual(["empty-179d", "live-175d", "live-365d"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).not.toHaveProperty("warningPass");
  });

  it("prunes zero-effect rows but preserves every current form of subscription intent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const { sqlite, db } = setupLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - INACTIVE_RETENTION_SEC - ONE_DAY_SEC;

    const meaningfulRows: Array<[string, Partial<SubscriptionState>]> = [
      ["alert-dews", { alertDews: 1 }],
      ["alert-depeg", { alertDepeg: 1 }],
      ["alert-safety", { alertSafety: 1 }],
      ["alert-launch", { alertLaunch: 1 }],
      ["alert-reserve", { alertReserve: 1 }],
      ["alert-freeze", { alertFreeze: 1 }],
      ["override-dews", { alertDewsOverride: 1 }],
      ["override-depeg", { alertDepegOverride: 1 }],
      ["override-safety", { alertSafetyOverride: 1 }],
      ["override-launch", { alertLaunchOverride: 1 }],
      ["override-reserve", { alertReserveOverride: 1 }],
      ["override-freeze", { alertFreezeOverride: 1 }],
      ["tuning-dews", { dewsMinBand: "AMBER" }],
      ["tuning-safety", { safetyMode: "critical" }],
      ["tuning-depeg", { depegWorseningBpsStep: 25 }],
      ["coin-snooze", { alertSnoozeUntilTs: now + ONE_DAY_SEC }],
    ];
    for (const [chatId, state] of meaningfulRows) {
      insertSubscriber(sqlite, chatId, staleAt);
      insertSubscription(sqlite, chatId, state);
    }

    insertSubscriber(sqlite, "zero-effect", staleAt);
    insertSubscription(sqlite, "zero-effect");

    insertSubscriber(sqlite, "preset-follow", staleAt);
    sqlite.prepare(
      `INSERT INTO telegram_preset_subscriptions
         (chat_id, preset_id, alert_dews, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run("preset-follow", "usd-top25", staleAt, staleAt);

    insertSubscriber(sqlite, "pending-alert", staleAt);
    sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (chat_id, message_html, created_at)
       VALUES (?, ?, ?)`,
    ).run("pending-alert", "pending", staleAt);

    insertSubscriber(sqlite, "pending-interaction", staleAt);
    sqlite.prepare(
      `INSERT INTO telegram_pending_disambiguation (
         chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates,
         remaining_tickers, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("pending-interaction", "[]", "[]", "USD", "[]", "[]", now + ONE_DAY_SEC);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(listSubscriberIds(sqlite)).toEqual(
      [...meaningfulRows.map(([chatId]) => chatId), "pending-alert", "pending-interaction", "preset-follow"].sort(),
    );
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = ?")
        .get("zero-effect"),
    ).toEqual({ count: 0 });
  });
});
