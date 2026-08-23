import { makeJsonRequest } from "./api-request-response.test-support";
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
} from "./telegram-webhook.test-support";


const makeLifecycleDb = (
  tables: Parameters<typeof makeTelegramWebhookDb>[0] = [],
  options: Parameters<typeof makeTelegramWebhookDb>[1] = {},
) => makeTelegramWebhookDb(tables, options, "lifecycle");

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
    const db = makeLifecycleDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start", "old-secret"),
      "test-secret",
      "bot-token",
      "old-secret",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Welcome");
  });

  it("skips duplicate update ids that are already processed", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at, effect_state, claim_owner, claim_generation",
        rows: [],
        first: {
          status: "processed",
          received_at: 1_700_000_000,
          effect_state: "started",
          claim_owner: "owner-processed",
          claim_generation: 1,
        },
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 500 }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_pending_disambiguation"))).toBe(false);
  });

  it("does not replay command effects when the terminal processed marker fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstDb = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "SET effect_state = 'started'",
        rows: [],
        runMeta: { changes: 1 },
      },
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SET status = 'processed'",
        rows: [],
        throwError: new Error("processed marker unavailable"),
      },
      {
        match: "SET status = 'failed'",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    const first = await handleTelegramWebhook(
      firstDb,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_500 }),
      "test-secret",
      "bot-token",
    );
    expect(first.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const retryDb = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at, effect_state, claim_owner, claim_generation",
        rows: [],
        first: {
          status: "failed",
          received_at: Math.floor(Date.now() / 1000),
          effect_state: "started",
          claim_owner: "owner-first",
          claim_generation: 1,
        },
      },
    ]);
    const retry = await handleTelegramWebhook(
      retryDb,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 5_500 }),
      "test-secret",
      "bot-token",
    );

    expect(retry.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(retryDb.getHistory().some((entry) => entry.sql.includes("FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
    errorSpy.mockRestore();
  });

  it("welcomes a group when my_chat_member reports the bot was added", async () => {
    const db = makeLifecycleDb([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ from: { id: 999, username: "alice" } }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody();
    expect(body.text).toContain("Thanks for adding Pharos Watch");
    expect(body.text).toContain("@alice");
    const replyMarkup = body.reply_markup as { inline_keyboard?: Array<Array<{ url?: string }>> };
    expect(replyMarkup.inline_keyboard?.flat().some((button) => button.url?.includes("/pharoswatchbot/"))).toBe(true);

    const cacheWrite = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(cacheWrite).toBeDefined();
    expect(cacheWrite!.binds[0]).toBe("telegram:group-welcome:-123");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_chat_delivery_diagnostics"))).toBe(false);
  });

  it("does not cache group welcome idempotency when Telegram send fails", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    const db = makeLifecycleDb([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ from: { id: 999, username: "alice" } }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_chat_delivery_diagnostics"))).toBe(false);
  });

  it("suppresses duplicate group welcomes while the idempotency cache is fresh", async () => {
    const db = makeLifecycleDb([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        first: {
          key: "telegram:group-welcome:-123",
          value: "1",
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
    ]);

    await handleTelegramWebhook(db, makeMyChatMemberRequest(), "test-secret", "bot-token");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
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

  it("ignores private my_chat_member updates", async () => {
    const db = makeLifecycleDb([]);

    await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ chatId: 123, chatType: "private" }),
      "test-secret",
      "bot-token",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it("cleans up group subscriber state when my_chat_member reports bot removal", async () => {
    const db = makeLifecycleDb();

    const res = await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ oldStatus: "member", newStatus: "left" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(
      history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers") && entry.binds.includes("-123")),
    ).toBe(true);
    expect(
      history.some(
        (entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts") && entry.binds.includes("-123"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("DELETE FROM cache WHERE key = ?") && entry.binds.includes("telegram:group-welcome:-123"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("DELETE FROM cache WHERE key = ?") && entry.binds.includes("telegram:chat-admins:-123"),
      ),
    ).toBe(true);
  });

  it("cleans up channel subscriber state when my_chat_member reports bot removal", async () => {
    const db = makeLifecycleDb();

    const res = await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({
        chatId: -100123,
        chatType: "channel",
        oldStatus: "administrator",
        newStatus: "left",
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(
      history.some(
        (entry) => entry.sql.includes("DELETE FROM telegram_subscribers") && entry.binds.includes("-100123"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("DELETE FROM cache WHERE key = ?") &&
          entry.binds.includes("telegram:group-welcome:-100123"),
      ),
    ).toBe(true);
  });

  it("ignores my_chat_member status changes that are not bot-added transitions", async () => {
    const db = makeLifecycleDb([]);

    await handleTelegramWebhook(
      db,
      makeMyChatMemberRequest({ oldStatus: "member", newStatus: "administrator" }),
      "test-secret",
      "bot-token",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it("migrates stored chat state on migrate_to_chat_id service messages", async () => {
    const db = makeLifecycleDb();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const res = await handleTelegramWebhook(
      db,
      makeChatMigrationRequest({
        chatId: -123,
        migrateToChatId: -100123,
        updateId: 700,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscribers") &&
          entry.binds[0] === "-100123" &&
          entry.binds[1] === "-123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("UPDATE telegram_pending_alerts SET chat_id = ? WHERE chat_id = ?") &&
          entry.binds[0] === "-100123" &&
          entry.binds[1] === "-123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("UPDATE OR IGNORE telegram_pending_alerts") &&
          entry.sql.includes("SET dedupe_key = ? || substr(dedupe_key, length(?) + 1)") &&
          entry.binds.slice(0, 3).join("|") === "-100123|-123|-100123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("DELETE FROM telegram_pending_alerts") &&
          entry.sql.includes("substr(dedupe_key, 1, length(?))") &&
          entry.binds.slice(0, 2).join("|") === "-100123|-123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("UPDATE telegram_alert_job_targets") &&
          entry.sql.includes("SET pending_dedupe_key = ? || substr(pending_dedupe_key, length(?) + 1)") &&
          entry.binds.slice(0, 3).join("|") === "-100123|-123|-100123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("UPDATE OR IGNORE telegram_alert_job_targets") &&
          entry.sql.includes("SET target_key = ? || substr(target_key, length(?) + 1)") &&
          entry.binds.slice(0, 3).join("|") === "-100123|-123|-100123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO cache") &&
          entry.binds[0] === "telegram:group-welcome:-100123" &&
          entry.binds[1] === "telegram:group-welcome:-123",
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("DELETE FROM telegram_subscribers WHERE chat_id = ?") && entry.binds[0] === "-123",
      ),
    ).toBe(true);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('"action":"chat-migration"'),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('"message":"telegram chat id migrated"'),
    );
    info.mockRestore();
  });

  it("migrates stored chat state on migrate_from_chat_id service messages", async () => {
    const db = makeLifecycleDb();

    await handleTelegramWebhook(
      db,
      makeChatMigrationRequest({
        chatId: -100123,
        migrateFromChatId: -123,
        updateId: 701,
      }),
      "test-secret",
      "bot-token",
    );

    const subscriberMigration = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
    expect(subscriberMigration?.binds.slice(0, 2)).toEqual(["-100123", "-123"]);
  });

  it("acknowledges a failed migration while emitting bounded error telemetry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeLifecycleDb([
      {
        match: "INSERT INTO telegram_subscribers",
        rows: [],
        throwError: new Error("D1 migration write unavailable"),
      },
    ]);

    const response = await handleTelegramWebhook(
      db,
      makeChatMigrationRequest({ chatId: -123, migrateToChatId: -100123 }),
      "test-secret",
      "bot-token",
    );

    expect(response.status).toBe(200);
    const record = JSON.parse(String(error.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({ action: "chat-migration", errorClass: "d1" });
    error.mockRestore();
  });

  it("returns a retryable status for duplicate update ids still in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at, effect_state, claim_owner, claim_generation",
        rows: [],
        first: {
          status: "processing",
          received_at: Math.floor(Date.now() / 1000),
          effect_state: "unstarted",
          claim_owner: "owner-current",
          claim_generation: 1,
        },
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 502 }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_pending_disambiguation"))).toBe(false);
    warn.mockRestore();
  });

  it("reclaims stale in-flight update ids so a Telegram retry can process them", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at, effect_state, claim_owner, claim_generation",
        rows: [],
        first: {
          status: "processing",
          received_at: Math.floor(Date.now() / 1000) - 600,
          effect_state: "unstarted",
          claim_owner: "owner-stale",
          claim_generation: 1,
        },
      },
      {
        match: "UPDATE telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
      { match: "telegram_pending_disambiguation", rows: [] },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 503 }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Commands");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("UPDATE telegram_processed_updates") && entry.sql.includes("status = 'processing'"),
        ),
    ).toBe(true);
  });

  it("reclaims failed update ids so Telegram retries can process them", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at, effect_state, claim_owner, claim_generation",
        rows: [],
        first: {
          status: "failed",
          received_at: 1_700_000_000,
          effect_state: "unstarted",
          claim_owner: "owner-failed",
          claim_generation: 1,
        },
      },
      {
        match: "UPDATE telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
      { match: "telegram_pending_disambiguation", rows: [] },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help", "test-secret", { updateId: 501 }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Commands");
    const processedUpdate = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("UPDATE telegram_processed_updates") && entry.sql.includes("status = 'processed'"),
      );
    expect(processedUpdate).toBeDefined();
  });

  it("processes older out-of-order update ids without using the old high-watermark cache", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 1 },
      },
      { match: "telegram_pending_disambiguation", rows: [] },
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
    expect(sentMessageBody().text).toContain("Commands");
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:last-update-id"))).toBe(false);
  });
});
