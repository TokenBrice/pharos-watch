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
import { handleMyChatMember } from "../telegram-webhook-group-welcome";


const LIFECYCLE_MIGRATION_FALLBACKS = [
  { match: "INSERT INTO telegram_subscriptions", rows: [] },
  { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
  { match: "INSERT OR IGNORE INTO telegram_pending_disambiguation", rows: [] },
  { match: "UPDATE OR IGNORE telegram_pending_alerts", rows: [] },
  { match: "UPDATE telegram_pending_alerts", rows: [] },
  { match: "DELETE FROM telegram_pending_alerts", rows: [] },
  { match: "DELETE FROM telegram_recap_targets", rows: [] },
  { match: "DELETE FROM telegram_recap_preferences", rows: [] },
  { match: "UPDATE OR IGNORE telegram_freeze_alert_targets", rows: [] },
  { match: "DELETE FROM telegram_freeze_alert_targets", rows: [] },
  { match: "UPDATE OR IGNORE telegram_alert_source_resolution_targets", rows: [] },
  { match: "DELETE FROM telegram_alert_source_resolution_targets", rows: [] },
  { match: "UPDATE telegram_alert_job_targets", rows: [] },
  { match: "UPDATE OR IGNORE telegram_alert_job_targets", rows: [] },
  { match: "DELETE FROM telegram_alert_job_targets", rows: [] },
  { match: "UPDATE OR IGNORE telegram_alert_job_target_items", rows: [] },
  { match: "DELETE FROM telegram_alert_job_target_items", rows: [] },
  { match: "UPDATE OR IGNORE telegram_alert_planning_subscribers", rows: [] },
  { match: "DELETE FROM telegram_alert_planning_subscribers", rows: [] },
  { match: "UPDATE telegram_alert_target_plans", rows: [] },
  { match: "DELETE FROM telegram_alert_target_plans", rows: [] },
  { match: "UPDATE OR IGNORE telegram_transport_failure_observations", rows: [] },
  { match: "DELETE FROM telegram_transport_failure_observations", rows: [] },
  { match: "UPDATE telegram_alert_dead_letters", rows: [] },
  { match: "DELETE FROM telegram_alert_dead_letters", rows: [] },
  { match: "DELETE FROM telegram_alert_target_plan_items", rows: [] },
  { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
  { match: "DELETE FROM telegram_subscriptions", rows: [] },
  { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
  { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
  { match: "DELETE FROM telegram_subscribers", rows: [] },
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

  it("skips duplicate update ids that are already processed", async () => {
    const db = makeLifecycleDb([
      {
        match: "INSERT INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates",
        rows: [],
        first: { status: "processed", received_at: 1_700_000_000 },
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
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_webhook_operation_mutations").get())
        .toEqual({ count: 0 });
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

  it("deletes the claimed group welcome marker when Telegram send fails", async () => {
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
    expect(db.getHistory().some((entry) => entry.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(true);
    expect(db.getHistory().some(
      (entry) =>
        entry.sql.includes("DELETE FROM cache WHERE key = ?") &&
        entry.binds[0] === "telegram:group-welcome:-123",
    )).toBe(true);
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
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO cache"))).toBe(false);
  });

  it("atomically claims a group welcome before concurrent sends", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const payload = {
        chat: { id: -123, type: "supergroup" },
        from: { id: 999, username: "alice" },
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member" },
      };

      await Promise.all([
        handleMyChatMember(db, "bot-token", payload),
        handleMyChatMember(db, "bot-token", payload),
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get("telegram:group-welcome:-123"))
        .toEqual({ key: "telegram:group-welcome:-123" });
    } finally {
      sqlite.close();
    }
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
    const db = makeLifecycleDb([{ match: "INSERT INTO telegram_subscribers", rows: [] }]);
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
    const db = makeLifecycleDb([{ match: "INSERT INTO telegram_subscribers", rows: [] }]);

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

  it("returns a retryable status for duplicate update ids still in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeLifecycleDb([
      {
        match: "INSERT INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates",
        rows: [],
        first: { status: "processing", received_at: Math.floor(Date.now() / 1000) },
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
