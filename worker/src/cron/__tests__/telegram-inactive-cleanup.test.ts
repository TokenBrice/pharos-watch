import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

const { runTelegramInactiveCleanup } = await import("../telegram-inactive-cleanup");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
  global_alert_dews?: number;
  global_alert_depeg?: number;
  global_alert_safety?: number;
  global_alert_launch?: number;
  global_alert_reserve?: number;
  global_alert_freeze?: number;
}

interface ChildRow {
  chat_id: string;
}

interface RecapPreferenceRow extends ChildRow {
  enabled: number;
}

const ONE_DAY_SEC = 86_400;
const INACTIVE_RETENTION_SEC = 180 * ONE_DAY_SEC;
const RUN_INTERVAL_SEC = 7 * ONE_DAY_SEC;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";

interface StubState {
  subscribers: SubscriberRow[];
  subscriptions: ChildRow[];
  presets: ChildRow[];
  pendingAlerts: ChildRow[];
  pendingDisambig: ChildRow[];
  recapPreferences: RecapPreferenceRow[];
  diagnostics: ChildRow[];
  cache: Map<string, { value: string; updated_at: number }>;
}

function deleteFromChild(rows: ChildRow[], chatId: string): number {
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].chat_id === chatId) {
      rows.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

function createStubDb(state: StubState): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as unknown as D1PreparedStatement;
      },
      run: async () => {
        if (
          sql.startsWith("INSERT INTO cache")
          || sql.startsWith("INSERT OR REPLACE INTO cache")
        ) {
          const [key, value, updatedAt] = bound as [string, string, number];
          state.cache.set(key, { value, updated_at: updatedAt });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.diagnostics, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_subscriptions WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.subscriptions, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_preset_subscriptions WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.presets, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_pending_alerts WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.pendingAlerts, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_pending_disambiguation WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.pendingDisambig, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_subscribers WHERE chat_id")) {
          const [chatId] = bound as [string];
          let removed = 0;
          for (let i = state.subscribers.length - 1; i >= 0; i--) {
            if (state.subscribers[i].chat_id === chatId) {
              state.subscribers.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => {
        if (sql.startsWith("SELECT value FROM cache WHERE key = ?")) {
          const [key] = bound as [string];
          const row = state.cache.get(key);
          return row ? { value: row.value } : null;
        }
        if (sql.startsWith("SELECT value, updated_at FROM cache WHERE key = ?")) {
          const [key] = bound as [string];
          const row = state.cache.get(key);
          return row ? { value: row.value, updated_at: row.updated_at } : null;
        }
        return null;
      },
      all: async () => {
        if (sql.includes("FROM telegram_subscribers s")) {
          const [cutoffSec, limit] = bound as [number, number];
          const hasChild = (chatId: string) =>
            state.subscriptions.some((r) => r.chat_id === chatId)
            || state.presets.some((r) => r.chat_id === chatId)
          || state.pendingAlerts.some((r) => r.chat_id === chatId)
            || state.pendingDisambig.some((r) => r.chat_id === chatId)
            || state.recapPreferences.some((r) => r.chat_id === chatId && r.enabled === 1);
          const hasGlobalAlert = (sub: SubscriberRow) =>
            sub.global_alert_dews === 1
            || sub.global_alert_depeg === 1
            || sub.global_alert_safety === 1
            || sub.global_alert_launch === 1
            || sub.global_alert_reserve === 1
            || sub.global_alert_freeze === 1;
          const eligible = state.subscribers
            .filter((sub) => sub.last_active_at < cutoffSec && !hasChild(sub.chat_id) && !hasGlobalAlert(sub))
            .sort((a, b) => a.last_active_at - b.last_active_at)
            .slice(0, limit)
            .map((row) => ({ chat_id: row.chat_id }));
          return { results: eligible, success: true, meta: {} };
        }
        return { results: [], success: true, meta: {} };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    batch: async (stmts: D1PreparedStatement[]) => {
      const results: unknown[] = [];
      for (const s of stmts) {
        results.push(await (s as unknown as { run: () => Promise<unknown> }).run());
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function makeState(): StubState {
  return {
    subscribers: [],
    subscriptions: [],
    presets: [],
    pendingAlerts: [],
    pendingDisambig: [],
    recapPreferences: [],
    diagnostics: [],
    cache: new Map(),
  };
}

function setupLatestSchemaSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = join(process.cwd(), "worker/migrations");
  const migrationFiles = readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test replays checked-in migrations only.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertSubscriber(sqlite: DatabaseSync, chatId: string, lastActiveAt: number): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
       VALUES (?, ?, ?)`,
    )
    .run(chatId, lastActiveAt, lastActiveAt);
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
    const db = createStubDb(makeState());
    await expect(runTelegramInactiveCleanup(db, controller.signal)).rejects.toThrow(
      "inactive cleanup aborted",
    );
  });

  it("deletes inactive subscribers with no children and writes the cache guard", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push(
      { chat_id: "stale-1", last_active_at: now - INACTIVE_RETENTION_SEC - 86_400 },
      { chat_id: "stale-2", last_active_at: now - INACTIVE_RETENTION_SEC - 3600 },
    );
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(state.subscribers).toHaveLength(0);
    const cached = state.cache.get(CACHE_LAST_RUN_KEY);
    expect(cached).toBeTruthy();
    const metadata = JSON.parse(result.metadata!) as {
      cutoffSec: number;
      deleted: number;
      cappedAtLimit: boolean;
    };
    expect(metadata.deleted).toBe(2);
    expect(metadata.cappedAtLimit).toBe(false);
  });

  it("preserves recently-active subscribers and chats with meaningful child state", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push(
      { chat_id: "active", last_active_at: now - 3600 },
      { chat_id: "has-sub", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-preset", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-pending-alert", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-pending-disambig", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-recap", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "eligible", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
    );
    state.subscriptions.push({ chat_id: "has-sub" });
    state.presets.push({ chat_id: "has-preset" });
    state.pendingAlerts.push({ chat_id: "has-pending-alert" });
    state.pendingDisambig.push({ chat_id: "has-pending-disambig" });
    state.recapPreferences.push({ chat_id: "has-recap", enabled: 1 });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers.map((row) => row.chat_id).sort()).toEqual([
      "active",
      "has-pending-alert",
      "has-pending-disambig",
      "has-preset",
      "has-recap",
      "has-sub",
    ]);
  });

  it("preserves inactive subscribers that only have global alert flags", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push(
      {
        chat_id: "global-dews",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_dews: 1,
      },
      {
        chat_id: "global-depeg",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_depeg: 1,
      },
      {
        chat_id: "global-safety",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_safety: 1,
      },
      {
        chat_id: "global-launch",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_launch: 1,
      },
      {
        chat_id: "global-reserve",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_reserve: 1,
      },
      {
        chat_id: "global-freeze",
        last_active_at: now - INACTIVE_RETENTION_SEC - 1,
        global_alert_freeze: 1,
      },
      { chat_id: "eligible", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
    );
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers.map((row) => row.chat_id).sort()).toEqual([
      "global-depeg",
      "global-dews",
      "global-freeze",
      "global-launch",
      "global-reserve",
      "global-safety",
    ]);
  });

  it("caps deletions at 100 per run and marks cappedAtLimit when reached", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 150; i++) {
      state.subscribers.push({
        chat_id: `stale-${i}`,
        last_active_at: now - INACTIVE_RETENTION_SEC - (i + 1),
      });
    }
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(100);
    expect(state.subscribers).toHaveLength(50);
    const metadata = JSON.parse(result.metadata!) as { cappedAtLimit: boolean };
    expect(metadata.cappedAtLimit).toBe(true);
  });

  it("skips real work when the cache guard is still warm", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.cache.set(CACHE_LAST_RUN_KEY, {
      value: String(now - 86_400), // ran 1 day ago — under the 7-day interval
      updated_at: now - 86_400,
    });
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 1,
    });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(0);
    expect(state.subscribers).toHaveLength(1);
    const metadata = JSON.parse(result.metadata!) as { skipped: string };
    expect(metadata.skipped).toBe("cache-guard");
  });

  it("runs again after the 7-day interval elapses", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.cache.set(CACHE_LAST_RUN_KEY, {
      value: String(now - RUN_INTERVAL_SEC - 60), // ran just over a week ago
      updated_at: now - RUN_INTERVAL_SEC - 60,
    });
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 1,
    });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers).toHaveLength(0);
  });

  it("clears telegram_chat_delivery_diagnostics when a chat is purged", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 86_400,
    });
    state.diagnostics.push({ chat_id: "stale-1" });
    state.diagnostics.push({ chat_id: "active" }); // unrelated row must survive
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers).toHaveLength(0);
    expect(state.diagnostics.map((row) => row.chat_id)).toEqual(["active"]);
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
    sqlite.close();
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
    sqlite.close();
  });
});
