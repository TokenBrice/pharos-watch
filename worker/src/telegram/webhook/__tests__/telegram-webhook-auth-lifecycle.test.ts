import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeJsonRequest } from "../../../test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSpy,
  handleTelegramWebhook,
  makeWebhookRequest,
  makeMyChatMemberRequest,
  makeChatMigrationRequest,
  sentMessageBody,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
} from "./telegram-webhook.test-support.ts";
import { handleMyChatMember, type TelegramChatMemberUpdated } from "../telegram-webhook-group-welcome";
import * as cache from "../../../lib/db-cache";
import { TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC, TELEGRAM_PROCESSING_STALE_SEC } from "../../common/constants";


const LIFECYCLE_MIGRATION_FALLBACKS = [
  { match: "INSERT INTO telegram_subscriptions", rows: [] },
  { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
  { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
  { match: "DELETE FROM telegram_subscriptions", rows: [] },
  { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
  { match: "DELETE FROM telegram_subscribers", rows: [] },
  { match: "UPDATE OR IGNORE telegram_deliveries", rows: [] },
  { match: "DELETE FROM telegram_deliveries", rows: [] },
  { match: "DELETE FROM telegram_jobs", rows: [] },
  { match: "UPDATE telegram_jobs SET payload_json", rows: [] },
  { match: "SET cursor = COALESCE", rows: [] },
  { match: "UPDATE telegram_change_log", rows: [] },
  { match: "INSERT INTO telegram_rollup_state", rows: [] },
  { match: "DELETE FROM telegram_rollup_state", rows: [] },
];

const makeLifecycleDb = (
  tables: Parameters<typeof makeTelegramWebhookDb>[0] = [],
  options: Parameters<typeof makeTelegramWebhookDb>[1] = {},
) => makeTelegramWebhookDb(tables, {
  ...options,
  fallbackTables: [...(options.fallbackTables ?? []), ...LIFECYCLE_MIGRATION_FALLBACKS],
}, "lifecycle");

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("returns 200 for invalid secret", async () => {
    const db = makeLifecycleDb([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start", "wrong-secret"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warn.mock.calls[0]?.[0] ?? "{}")) as {
      action?: string;
      signal?: string;
      invalidSecretWindowCount?: number;
    };
    expect(record.action).toBe("auth-invalid-secret");
    expect(record.signal).toBe("invalid_secret");
    expect(record.invalidSecretWindowCount).toBe(1);
    warn.mockRestore();
  });

  it("returns 200 for missing secret without logging timing-safe compare misconfiguration", async () => {
    const db = makeLifecycleDb([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = makeJsonRequest("https://x/api/telegram-webhook", { message: { chat: { id: 123 }, text: "/start" } }, {
      headers: {},
    });

    const res = await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalledWith(
      "[auth] timingSafeCompare called with empty string — possible misconfiguration",
    );
    expect(warn).not.toHaveBeenCalledWith(
      "[telegram-webhook] auth validation failed — returning 200 to prevent retry storm",
    );
  });

  it("rate-limits a loud warning when the bot token is missing while acknowledging updates", async () => {
    const db = makeLifecycleDb([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start"),
      "test-secret",
    );
    const second = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help"),
      "test-secret",
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const missingTokenWarnings = warn.mock.calls
      .map(([record]) => JSON.parse(String(record)) as { action?: string })
      .filter((record) => record.action === "webhook-missing-bot-token");
    expect(missingTokenWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it("acknowledges malformed authenticated update bodies without creating an effect fence", async () => {
    const db = makeLifecycleDb([]);
    const request = new Request("https://x/api/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: "{",
    });

    const response = await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it("accepts the previous webhook secret during the overlap window", async () => {
    const db = makeLifecycleDb();
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start", "old-secret"),
      "test-secret",
      "bot-token",
      "old-secret",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toBeTruthy();
  });

  it.each(["processed", "processing"])("acknowledges only completed duplicate updates (%s)", async status => {
    const db = makeLifecycleDb([
      { match: "INSERT INTO telegram_processed_updates", rows: [], runMeta: { changes: 0 } },
      { match: "SELECT status, received_at FROM telegram_processed_updates", rows: [],
        first: { status, received_at: Math.floor(Date.now() / 1000) } },
    ]);
    const res = await handleTelegramWebhook(db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 502 }), "test-secret", "bot-token");
    expect(res.status).toBe(status === "processed" ? 200 : 503);
    if (status === "processing") expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some(entry => entry.sql.includes("FROM telegram_pending_disambiguation"))).toBe(false);
  });

  it("releases the claim when the processed marker fails so Telegram's retry is processed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.exec(`CREATE TRIGGER fail_terminal_marker
        BEFORE UPDATE OF status ON telegram_processed_updates
        WHEN NEW.status = 'processed'
        BEGIN SELECT RAISE(ABORT, 'processed marker unavailable'); END`);
      const first = await handleTelegramWebhook(db,
        makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_500 }), "test-secret", "bot-token");
      expect(first.status).toBe(500);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_processed_updates").get()).toEqual({ count: 0 });

      sqlite.exec("DROP TRIGGER fail_terminal_marker");
      const retry = await handleTelegramWebhook(db,
        makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_500 }), "test-secret", "bot-token");
      expect(retry.status).toBe(200);
      // The accepted trade-off: the reply may repeat once on redelivery.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(sqlite.prepare("SELECT status FROM telegram_processed_updates WHERE update_id = 5500").get())
        .toEqual({ status: "processed" });

      const duplicate = await handleTelegramWebhook(db,
        makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_500 }), "test-secret", "bot-token");
      expect(duplicate.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      sqlite.close();
      errorSpy.mockRestore();
    }
  });

  it("processes a my_chat_member update left stuck in effect-fence 'planned' state", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare(`INSERT INTO telegram_processed_updates
        (update_id, received_at, update_type, chat_id, status, effect_state, claim_owner, claim_generation, intent_kind)
        VALUES (5600, ?, 'my_chat_member', '123', 'processing', 'planned', 'old-owner', 1, 'member:lifecycle')`)
        .run(Math.floor(Date.now() / 1000) - 3_600);

      const res = await handleTelegramWebhook(db,
        makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_600 }), "test-secret", "bot-token");

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT status, update_type FROM telegram_processed_updates WHERE update_id = 5600").get())
        .toEqual({ status: "processed", update_type: "message" });
    } finally {
      sqlite.close();
    }
  });

  it.each([false, true])("cleans up only the failed welcome's owner (replaced: %s)", async (replaced) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    fetchSpy.mockImplementationOnce(async () => {
      if (replaced) sqlite.exec("UPDATE cache SET value = 'pending:replacement'");
      return new Response("blocked", { status: 403 });
    });
    try {
      expect((await handleTelegramWebhook(db, makeMyChatMemberRequest(), "test-secret", "bot-token")).status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT value FROM cache").all()).toEqual(replaced ? [{ value: "pending:replacement" }] : []);
    } finally { sqlite.close(); }
  });

  it.each(["empty", "sent", "expired", "INSERT INTO cache", "UPDATE cache SET updated_at", "UPDATE cache SET value"])("welcome claim: %s", async (mode) => {
    vi.useFakeTimers();
    let threw = false, reads = 0;
    const fault = mode.includes("cache"), readCache = cache.getCache;
    const { sqlite, db } = createLatestSchemaSqlite({ rowsWritten: (sql, changes) => {
      if (fault && !threw && sql.includes(mode)) { threw = true; throw new Error("Network connection lost"); }
      if (sql.includes("INSERT INTO cache") && changes > 0) claimed();
      return changes;
    } });
    let claimed!: () => void;
    const acquired = new Promise<void>((resolve) => { claimed = resolve; });
    const read = vi.spyOn(cache, "getCache").mockImplementation(async (...args) => {
      const row = await readCache(...args);
      if (++reads === 2) await acquired; // Return the contender's stale read after the first acquisition.
      return row;
    });
    try {
      const payload = (await makeMyChatMemberRequest().json() as { my_chat_member: TelegramChatMemberUpdated }).my_chat_member;
      if (mode !== "empty") sqlite.prepare("INSERT INTO cache VALUES (?, '1', ?)")
        .run("telegram:group-welcome:-123", Math.floor(Date.now() / 1000) - (mode === "sent" ? 0 : TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC));
      const first = handleMyChatMember(db, "bot-token", payload);
      const deliveries = Promise.allSettled(fault || mode === "sent" ? [first] : [first, handleMyChatMember(db, "bot-token", payload)]);
      await vi.runAllTimersAsync();
      await deliveries;
      expect(fetchSpy).toHaveBeenCalledTimes(mode === "sent" ? 0 : 1);
      expect(threw).toBe(fault);
      expect(sqlite.prepare("SELECT value FROM cache").all()).toEqual([{ value: "1" }]);
    } finally {
      read.mockRestore(); sqlite.close(); vi.useRealTimers();
    }
  });

  it.each([1, 59])("crash redelivery: welcome starts %is after ingress", async (lag) => {
    vi.useFakeTimers();
    const { sqlite, db } = createLatestSchemaSqlite(), now = Math.floor(Date.now() / 1000);
    const deliver = () => handleTelegramWebhook(db, makeMyChatMemberRequest({ updateId: 5610 }), "test-secret", "bot-token");
    try {
      sqlite.prepare("INSERT INTO telegram_processed_updates (update_id, received_at, status) VALUES (5610, ?, 'processing')")
        .run(now - TELEGRAM_PROCESSING_STALE_SEC);
      sqlite.prepare("INSERT INTO cache VALUES ('telegram:group-welcome:-123', 'pending:crashed', ?)")
        .run(now - TELEGRAM_PROCESSING_STALE_SEC + lag);
      const busy = await deliver();
      expect([busy.status, busy.headers.get("Retry-After")]).toEqual([503, String(lag)]);
      expect(sqlite.prepare("SELECT status FROM telegram_processed_updates").all()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(lag * 1000);
      expect((await deliver()).status).toBe(200);
      expect((await deliver()).status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT status FROM telegram_processed_updates").all()).toEqual([{ status: "processed" }]);
    } finally { sqlite.close(); vi.useRealTimers(); }
  });

  it.each([
    ["1", 100, "pending:new", 200, true], ["pending:old", 200, "1", 100, false],
    ["pending:old", 90000, "1", 100, true], ["1", 100, "pending:new", 90000, false],
  ] as const)("merge welcome deadlines: %s/%i, %s/%i", async (old, oldAt, next, nextAt, oldWins) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache VALUES ('telegram:group-welcome:-123', ?, ?), ('telegram:group-welcome:-100123', ?, ?)")
        .run(old, oldAt, next, nextAt);
      expect((await handleTelegramWebhook(db,
        makeChatMigrationRequest({ chatId: -123, migrateToChatId: -100123 }), "test-secret", "bot-token")).status).toBe(200);
      expect(sqlite.prepare("SELECT value, updated_at FROM cache").all())
        .toEqual([{ value: oldWins ? old : next, updated_at: oldWins ? oldAt : nextAt }]);
    } finally { sqlite.close(); }
  });

  it("returns ok when a my_chat_member welcome cache read fails", async () => {
    const db = makeLifecycleDb([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        throwError: new Error("cache unavailable"),
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ from: { id: 999, first_name: "Alice <Ops>" } }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
  });

  it.each([
    { chatId: 123, chatType: "private" as const },
    { oldStatus: "member", newStatus: "administrator" },
  ])("ignores member updates outside bot-added group transitions: %j", async patch => {
    const db = makeLifecycleDb([]);
    await handleTelegramWebhook(db, makeMyChatMemberRequest(patch), "test-secret", "bot-token");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it.each([
    [-123, "group", "member"], [-100123, "channel", "administrator"],
  ] as const)("cleans subscriber and lifecycle caches when removed from %s (%s)", async (chatId, chatType, oldStatus) => {
    const db = makeLifecycleDb();
    const res = await handleTelegramWebhook(db,
      makeMyChatMemberRequest({ chatId, chatType, oldStatus, newStatus: "left" }), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(history.some(entry => entry.sql.includes("DELETE FROM telegram_subscribers") && entry.binds.includes(String(chatId)))).toBe(true);
    for (const key of [`telegram:group-welcome:${chatId}`, `telegram:chat-admins:${chatId}`]) {
      expect(history.some(entry => entry.sql.includes("DELETE FROM cache WHERE key = ?") && entry.binds.includes(key))).toBe(true);
    }
  });

  it.each(["to", "from"] as const)("migrates stored chat state on migrate_%s_chat_id service messages", async direction => {
    const db = makeLifecycleDb([{ match: "INSERT INTO telegram_subscribers", rows: [] }]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await handleTelegramWebhook(db, makeChatMigrationRequest(direction === "to"
      ? { chatId: -123, migrateToChatId: -100123, updateId: 700 }
      : { chatId: -100123, migrateFromChatId: -123, updateId: 701 }), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(history.find(entry => entry.sql.includes("INSERT INTO telegram_subscribers"))?.binds.slice(0, 2)).toEqual(["-100123", "-123"]);
    expect(history.some(entry => entry.sql.includes("INSERT INTO cache") &&
      entry.binds[0] === "telegram:group-welcome:-100123" && entry.binds[1] === "telegram:group-welcome:-123")).toBe(true);
    expect(history.some(entry => entry.sql.includes("DELETE FROM telegram_subscribers WHERE chat_id = ?") && entry.binds[0] === "-123")).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"action":"chat-migration"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"message":"telegram chat id migrated"'));
    info.mockRestore();
  });

  it.each([
    ["a transient D1 failure", "D1 DB is overloaded. Requests queued for too long.", 500],
    ["a deterministic failure", "D1_ERROR: UNIQUE constraint failed: telegram_subscribers.chat_id", 200],
  ] as const)("handles %s during chat migration", async (_label, message, status) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeLifecycleDb([
      {
        match: "INSERT INTO telegram_subscribers",
        rows: [],
        throwError: new Error(message),
      },
    ]);

    const response = await handleTelegramWebhook(
      db,
      makeChatMigrationRequest({ chatId: -123, migrateToChatId: -100123, updateId: 504 }),
      "test-secret",
      "bot-token",
    );

    expect(response.status).toBe(status);
    const history = db.getHistory();
    const released = history.some((entry) =>
      entry.sql.includes("DELETE FROM telegram_processed_updates") && entry.binds.includes(504));
    const marked = history.find((entry) => entry.sql.includes("status = 'processed'"));
    // Transient: release so Telegram redelivers. Deterministic: ack with an error class
    // instead of failing forever and holding back later updates.
    expect(released).toBe(status === 500);
    expect(marked?.binds.includes("chat-migration") ?? false).toBe(status === 200);
    const record = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({ action: "chat-migration" });
    error.mockRestore();
  });



  it("processes older out-of-order update ids without using the old high-watermark cache", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "UPDATE telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 100 }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toBeTruthy();
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:last-update-id"))).toBe(false);
  });
});
