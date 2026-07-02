import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  lastSendMessageBody,
  makeTelegramUpdateRequest,
  telegramApiCallBody,
  telegramCallBody,
} from "../../test-helpers/__shared/telegram";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { handleTelegramWebhook, TELEGRAM_GROUP_ADMIN_GATING } = await import("../telegram-webhook");
const { resolveTicker } = await import("../../lib/telegram-alerts");
const { FROZEN_STABLECOINS } = await import("@shared/lib/stablecoins/registry");
const { resetTelegramInvalidSecretLogStateForTests } = await import("../../lib/telegram-log");
const { encodeWatchlistToken } = await import("../../lib/telegram-watchlist-token");

function makeWebhookRequest(
  chatId: number,
  text: string,
  secret = "test-secret",
  options: {
    chatType?: string;
    fromId?: number;
    fromUsername?: string;
    includeFrom?: boolean;
    updateId?: number;
  } = {},
): Request {
  const message: Record<string, unknown> = {
    chat: { id: chatId, username: "testuser", type: options.chatType ?? "private" },
    text,
  };
  if (options.includeFrom !== false) {
    message.from = { id: options.fromId ?? 999, username: options.fromUsername ?? "requester" };
  }
  return makeTelegramUpdateRequest({ message }, { secret, updateId: options.updateId });
}

function makeMyChatMemberRequest(
  options: {
    chatId?: number;
    chatType?: string;
    oldStatus?: string;
    newStatus?: string;
    from?: { id?: number; username?: string; first_name?: string };
    secret?: string;
    updateId?: number;
  } = {},
): Request {
  return makeTelegramUpdateRequest(
    {
      my_chat_member: {
        chat: {
          id: options.chatId ?? -123,
          type: options.chatType ?? "supergroup",
          title: "Stablecoin desk",
        },
        from: options.from ?? { id: 999, username: "requester" },
        old_chat_member: { status: options.oldStatus ?? "left" },
        new_chat_member: { status: options.newStatus ?? "member" },
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function makeChatMigrationRequest(options: {
  chatId: number;
  migrateToChatId?: number;
  migrateFromChatId?: number;
  updateId?: number;
  secret?: string;
}): Request {
  return makeTelegramUpdateRequest(
    {
      message: {
        chat: { id: options.chatId, type: "supergroup" },
        ...(options.migrateToChatId != null ? { migrate_to_chat_id: options.migrateToChatId } : {}),
        ...(options.migrateFromChatId != null ? { migrate_from_chat_id: options.migrateFromChatId } : {}),
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function makeCallbackRequest(
  data: string,
  options: {
    chatId?: number;
    chatType?: string;
    fromId?: number;
    fromUsername?: string;
    messageId?: number;
    updateId?: number;
    secret?: string;
  } = {},
): Request {
  return makeTelegramUpdateRequest(
    {
      callback_query: {
        id: "cb1",
        data,
        from: { id: options.fromId ?? 999, username: options.fromUsername ?? "requester" },
        message: {
          chat: { id: options.chatId ?? 123, type: options.chatType ?? "private" },
          message_id: options.messageId ?? 1,
        },
      },
    },
    { secret: options.secret, updateId: options.updateId },
  );
}

function sentMessageBody(callIndex = 0): { text: string; reply_markup?: unknown } {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call?.[1]?.body || typeof call[1].body !== "string") {
    throw new Error("Expected sendToChat to call fetch with a string JSON body");
  }
  return telegramCallBody<{ text: string; reply_markup?: unknown }>(call);
}

function latestSendMessageBody(): { text: string; reply_markup?: unknown } {
  return lastSendMessageBody(fetchSpy);
}

type InlineButton = {
  text?: string;
  callback_data?: string;
  url?: string;
  web_app?: { url?: string };
};

function inlineButtons(body: { reply_markup?: unknown }): InlineButton[] {
  const markup = body.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

function expectMiniAppButton(body: { reply_markup?: unknown }, text: string, startapp: string): void {
  expect(
    inlineButtons(body).some((button) => button.text === text && button.web_app?.url?.includes(`startapp=${startapp}`)),
  ).toBe(true);
}

function makeSetupPendingRow(
  actionPayload: Record<string, unknown>,
  options: { expiresAt?: number; initiatorUserId?: string | null } = {},
): Record<string, unknown> {
  return {
    action_type: "setup-step",
    action_payload: JSON.stringify(actionPayload),
    alert_types: JSON.stringify([]),
    resolved_ids: JSON.stringify([]),
    ambiguous_ticker: "",
    candidates: JSON.stringify([]),
    remaining_tickers: JSON.stringify([]),
    expires_at: options.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: options.initiatorUserId ?? null,
  };
}

function makeStablecoinsCacheValue(overrides: Record<string, number>): string {
  return JSON.stringify({
    peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", circulating: { usd: overrides["usdt-tether"] ?? 0 } },
      { id: "usdc-circle", symbol: "USDC", circulating: { usd: overrides["usdc-circle"] ?? 0 } },
      { id: "dai-makerdao", symbol: "DAI", circulating: { usd: overrides["dai-makerdao"] ?? 0 } },
      { id: "pyusd-paypal", symbol: "PYUSD", circulating: { usd: overrides["pyusd-paypal"] ?? 0 } },
      { id: "eurc-circle", symbol: "EURC", circulating: { usd: overrides["eurc-circle"] ?? 0 } },
      { id: "xaut-tether", symbol: "XAUT", circulating: { usd: overrides["xaut-tether"] ?? 0 } },
      { id: "paxg-paxos", symbol: "PAXG", circulating: { usd: overrides["paxg-paxos"] ?? 0 } },
    ],
  });
}

describe("handleTelegramWebhook", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    resetTelegramInvalidSecretLogStateForTests();
  });

  it("returns 200 for invalid secret", async () => {
    const db = mockD1([]);
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
    const db = mockD1([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://x/api/telegram-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "/start" } }),
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

  it("accepts the previous webhook secret during the overlap window", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
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
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
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

  it("welcomes a group when my_chat_member reports the bot was added", async () => {
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([]);

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
    const db = mockD1();

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
    const db = mockD1();

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
    const db = mockD1([]);

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
    const db = mockD1();

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
  });

  it("migrates stored chat state on migrate_from_chat_id service messages", async () => {
    const db = mockD1();

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

  it("returns a retryable status for duplicate update ids still in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
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

  it("reclaims stale in-flight update ids so a Telegram retry can process them", async () => {
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
        rows: [],
        first: { status: "processing", received_at: Math.floor(Date.now() / 1000) - 600 },
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
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO telegram_processed_updates",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
        rows: [],
        first: { status: "failed", received_at: 1_700_000_000 },
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
    const db = mockD1([
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

  it("rate-limits expensive commands per chat with a graceful reply", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /brief again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM daily_digest"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("rate-limits /status before loading coin status rows", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/status USDC"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/status"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("records cooldown-store-error when the command cooldown write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        throwError: new Error("d1 cooldown boom"),
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Command traffic is busy");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM daily_digest"))).toBe(false);
    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds[1] === "command" &&
          entry.binds[3] === "/brief",
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[4]).toBe("failure");
    expect(usageRow!.binds[6]).toBe("cooldown-store-error");
    warn.mockRestore();
  });

  it("releases an acquired command cooldown when the handler throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM daily_digest", rows: [], throwError: new Error("digest read failed") },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("DELETE FROM cache WHERE key = ?") &&
            entry.binds.includes("telegram:command-cooldown:123:/brief"),
        ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("drops commands over the per-chat flood cap and replies once at first exceed", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // 21st command inside the window: counter row already at the limit of 20.
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:123"],
        rows: [{ key: "telegram:command-flood:123", value: "20", updated_at: 1_699_999_990 }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Too many commands at once");
    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds[1] === "command" &&
          entry.binds[3] === "/help",
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[4]).toBe("rate_limited");
    expect(usageRow!.binds[6]).toBe("chat-flood");
    nowSpy.mockRestore();
  });

  it("drops flooded commands silently after the first-exceed notice", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:123"],
        rows: [{ key: "telegram:command-flood:123", value: "25", updated_at: 1_699_999_990 }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("uses actor-scoped flood keys in groups before the chat-wide ceiling", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:-123:actor:222"],
        rows: [],
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:-123"],
        rows: [{ key: "telegram:command-flood:-123", value: "20", updated_at: 1_699_999_990 }],
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Commands");
    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("telegram:command-flood:-123:actor:222"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("telegram:command-flood:-123"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("drops flooded group commands for the actor that exceeded the cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:-123:actor:222"],
        rows: [{ key: "telegram:command-flood:-123:actor:222", value: "20", updated_at: 1_699_999_990 }],
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Too many commands at once");
    expect(db.getHistory().some((entry) => entry.binds.includes("actor-flood"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("fails open when the chat flood counter store errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:123"],
        rows: [],
        throwError: new Error("d1 flood boom"),
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // /help still replied despite the flood-store failure.
    expect(sentMessageBody().text.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("uses the /brief cooldown bucket for the deprecated /market alias", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/market"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /brief again");
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/brief"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/market"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("returns 200 for non-command text", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "hello"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replies to /start", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // `/start` now opens the setup wizard (P0-U2). The reply is the short
    // wizard intro plus the branch keyboard; the long-form onboarding lives
    // behind the "I'll type commands myself" branch and /help.
    expect(sentMessageBody().text).toContain("Welcome");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("replies to /help", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = sentMessageBody();
    expect(body.text).toContain("Commands");
    expect(body.text).toContain("/presets");
    expect(body.text).toContain("/sample");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/coverage");
    expectMiniAppButton(body, "Open control panel", "settings");
  });

  it("records command replies without stamping alert delivery success", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    const diagnosticInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(diagnosticInsert).toBeDefined();
    expect(diagnosticInsert!.sql).toContain("VALUES (?, NULL, ?, ?, ?, ?)");
    expect(diagnosticInsert!.binds).toEqual(["123", 1_700_000_000, 1_700_000_000, null, 1_700_000_000]);
    nowSpy.mockRestore();
  });

  it("replies to /health with chat delivery diagnostics", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        first: {
          alert_dews: 1,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 22,
          quiet_hours_end_utc: 7,
          timezone: null,
          alert_snooze_until_ts: null,
          consecutive_block_count: 0,
          consecutive_block_first_at: null,
        },
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [
          { preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null },
        ],
      },
      { match: "COUNT(*) AS active_count", first: { active_count: 3 }, rows: [] },
      { match: "SELECT last_error_class", first: { last_error_class: "rate_limit" }, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 2 }, rows: [] },
      {
        match: "FROM telegram_chat_delivery_diagnostics",
        first: {
          last_successful_delivery_at: Math.floor(Date.now() / 1000) - 60,
          last_successful_reply_at: Math.floor(Date.now() / 1000) - 60,
          recent_failure_class: null,
        },
        rows: [],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const text = latestSendMessageBody().text;
    expect(text).toContain("Bot Health");
    expect(text).toContain("Last successful alert delivery:");
    expect(text).toContain("Last successful command reply:");
    expect(text).toContain("Queued alerts for this chat: 2");
    expect(text).toContain("Recent failure class: rate_limit");
    expect(text).toContain("Alert readiness: 3 explicit coin follows; 1 dynamic preset");
  });

  it("lets /health pass through during pending disambiguation without clearing it", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to resolve ambiguously for health passthrough test");
    }
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", first: { active_count: 0 }, rows: [] },
      { match: "SELECT last_error_class", first: null, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(latestSendMessageBody().text).toContain("Bot Health");
    expect(latestSendMessageBody().text).not.toContain("pending selection");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("lets /health pass through during pending bulk confirmation without clearing it", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "subscribe",
            alertTypes: ["dews"],
            presetIds: [],
            coinIds: ["usdc-circle"],
            subscribeAll: false,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", first: { active_count: 0 }, rows: [] },
      { match: "SELECT last_error_class", first: null, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(latestSendMessageBody().text).toContain("Bot Health");
    expect(latestSendMessageBody().text).not.toContain("pending bulk confirmation");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("/settings sends the chat-level settings keyboard", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/settings"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const body = sentMessageBody() as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("<b>Settings</b>");
    const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toEqual(expect.arrayContaining(["settings:gt:dews", "settings:gt:depeg"]));
  });

  it("ignores unaddressed commands in group chats", async () => {
    const db = mockD1([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/subscribe dews USDC", "test-secret", { chatType: "supergroup" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("/start opens the setup wizard with the branch keyboard", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = sentMessageBody();
    expect(body.text).toContain("Welcome to PharosWatchBot");
    expect(body.text).toContain("@pharoswatch");
    expect(body.text).toContain("@pharoswatchers");
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
    expect(callbacks).toContain("setup:branch:custom");
    expect(callbacks).toContain("setup:branch:skip");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_pending_disambiguation") && entry.binds.includes("setup-step"),
        ),
    ).toBe(true);
  });

  it("/start setup deep-link opens the wizard", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start setup"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
  });

  it("/start in a group gives non-admins the read-only start message", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { user: { id: 7, is_bot: false, first_name: "member" }, status: "member" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = lastSendMessageBody<{ text: string }>(fetchSpy);
    expect(body.text).toContain("Quick start");
    expect(body.text).toContain("/sample");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/coverage");
    expect(body.text).not.toContain("Pick a path below");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("/start in a group does not overwrite another user's fresh setup state", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [
          {
            action_type: "setup-step",
            action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
            alert_types: "[]",
            resolved_ids: "[]",
            ambiguous_ticker: "",
            candidates: "[]",
            remaining_tickers: "[]",
            expires_at: 9_999_999_999,
            initiator_user_id: "111",
          },
        ],
      },
      {
        match: "INSERT INTO telegram_pending_disambiguation",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { user: { id: 222, is_bot: false, first_name: "admin" }, status: "administrator" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = latestSendMessageBody();
    expect(body.text).toContain("Another user has a pending selection");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
  });

  it("/start sub_<types>_<targets> in a private chat dispatches into /subscribe", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start sub_dews-depeg_usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    // The subscribe path ran (preset cache was consulted); bulk-confirm gate caught the
    // >10-coin preset and queued a confirmation rather than writing subscriptions directly.
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as {
      kind: string;
      alertTypes: string[];
      presetIds: string[];
    };
    expect(payload.kind).toBe("subscribe");
    expect(payload.alertTypes.sort()).toEqual(["depeg", "dews"]);
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("/start sub_<types>_<targets> in a group chat falls back to START_MESSAGE", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot sub_dews_usd-top25", "test-secret", {
        chatType: "supergroup",
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    // No subscribe machinery ran — no preset cache lookup, no confirm-bulk row.
    // (The per-chat command-flood counter also reads the cache table; exclude it.)
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("FROM cache WHERE key = ?") &&
          !entry.binds.some((bind) => String(bind).startsWith("telegram:command-flood:")),
      ),
    ).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
    const body = sentMessageBody().text;
    // The long-form START_MESSAGE (not the short wizard intro) is returned for groups.
    expect(body).toContain("Alert types");
    expect(body).toContain("Quick start");
    expect(body).not.toContain("Pick a path below");
  });

  it("/start status_<coinId> dispatches into /status", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1_700_000_000 }] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9999, updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start status_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("USDC");
    expect(body).toContain("CALM");
    expect(body).toContain("Safety: A");
    expect(body).toContain("Price: $0.9999");
  });

  it("rate-limits /start status_<coinId> through the /status cooldown bucket", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: ["telegram:command-cooldown:1:/status", "1", 1_700_000_000, 1_699_999_980],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-cooldown:1:/status"],
        rows: [{ updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start status_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:1:/status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("/start why_<coinId> dispatches into /why", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start why_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // /why renders the safety-grade explanation for USDC; no ticker-resolution error fires.
    const body = sentMessageBody().text;
    expect(body).not.toContain("not found");
    expect(body).not.toContain("Re-run /status");
  });

  it("/start coverage_<coinId> dispatches into /coverage", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1_700_000_000 }] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9999, updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start coverage_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("USDC");
    expect(body).not.toContain("not found");
  });

  it("handles direct /brief and deprecated /market commands", async () => {
    const db = mockD1([{ match: "FROM daily_digest", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/market"), "test-secret", "bot-token");

    expect(sentMessageBody(0).text).toContain("No digest brief is available yet");
    expect(sentMessageBody(1).text).toContain("No digest brief is available yet");
  });

  it("handles direct /top usage without running the expensive top view", async () => {
    const db = mockD1([]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/top"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toBe("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    const history = db.getHistory();
    expect(history[0]?.sql).toContain("FROM telegram_pending_disambiguation");
    expect(
      history.some((entry) => entry.binds.some((bind) => String(bind).includes("telegram:command-cooldown"))),
    ).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM depeg_events"))).toBe(false);
  });

  it("does not consume the /status cooldown when called with no args (usage reply)", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    // Two consecutive no-arg /status calls — neither should store a cooldown entry.
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/status"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/status"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(
      history.some((entry) =>
        entry.binds.some((bind) => String(bind).includes("telegram:command-cooldown:123:/status")),
      ),
    ).toBe(false);
  });

  it("handles direct /why and /coverage commands", async () => {
    const db = mockD1([
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM yield_data", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/why NOTACOIN"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/coverage USDC"), "test-secret", "bot-token");

    expect(sentMessageBody(0).text).toContain("not found");
    expect(sentMessageBody(1).text).toContain("USDC coverage");
    expect(sentMessageBody(1).text).toContain("Open coin page");
    expectMiniAppButton(sentMessageBody(1), "Open in app", "coverage_usdc-circle");
  });

  it("/start with an unknown payload falls back to the wizard intro", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start garbage_xyz"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(sent.text).toContain("Welcome to PharosWatchBot");
    expect(sent.text).toContain("Pick a path below");
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
  });

  it("/start rejects payloads over 64 characters and falls back to the wizard intro", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const longPayload = `status_${"a".repeat(60)}`; // 7 + 60 = 67 chars, well-formed otherwise
    expect(longPayload.length).toBeGreaterThan(64);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, `/start ${longPayload}`),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    // Status handler did not run — no stress_signals/price_cache queries were issued.
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    expect(sentMessageBody().text).toContain("Pick a path below");
  });

  it("/start rejects payloads containing disallowed characters and falls back to the wizard intro", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start status_usdc.circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(sentMessageBody().text).toContain("Pick a path below");
  });

  it("setup-step awaiting-ticker advances to confirm when a unique ticker is replied", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({
            step: "awaiting-ticker",
            alertTypes: ["dews"],
            target: null,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "USDC"), "test-secret", "bot-token");

    const persist = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(persist.length).toBeGreaterThan(0);
    const payload = String(persist[persist.length - 1].binds[2] ?? "");
    expect(payload).toContain('"step":"confirm-custom"');
    expect(payload).toContain('"kind":"ticker"');
    expect(payload).toContain("USDC");
  });

  it("setup-step awaiting-ticker treats slash-prefixed ticker replies as ticker input", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow({
          step: "awaiting-ticker",
          alertTypes: ["dews"],
          target: null,
        }),
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/USDC"), "test-secret", "bot-token");

    const history = db.getHistory();
    const persist = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(persist.length).toBeGreaterThan(0);
    const payload = String(persist[persist.length - 1].binds[2] ?? "");
    expect(payload).toContain('"step":"confirm-custom"');
    expect(payload).toContain('"kind":"ticker"');
    expect(payload).toContain("USDC");
    expect(history.some((entry) => entry.binds.includes("unknown_command"))).toBe(false);
  });

  it("setup-step awaiting-ticker keeps an ambiguous force-reply selection in the ticker prompt", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to resolve ambiguously for setup force-reply test");
    }
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "awaiting-ticker",
            alertTypes: ["dews"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "USDF"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("USDF");
    expect(body.text).toContain("matches");
    expect((body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply).toBe(true);
    const history = db.getHistory();
    const persistedSetupPayloads = history
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))
      .map((entry) => String(entry.binds[2] ?? ""));
    expect(persistedSetupPayloads.some((payload) => payload.includes('"step":"confirm-custom"'))).toBe(false);
  });

  it("setup:type-toggle:launch toggles Launch on in the custom alert picker", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "custom-types",
            alertTypes: ["dews", "depeg"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:type-toggle:launch"), "test-secret", "bot-token");

    const pendingWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    const latestPendingWrite = pendingWrites[pendingWrites.length - 1];
    expect(latestPendingWrite).toBeDefined();
    const payload = JSON.parse(String(latestPendingWrite!.binds[2] ?? "{}")) as {
      step?: string;
      alertTypes?: string[];
    };
    expect(payload.step).toBe("custom-types");
    expect(payload.alertTypes).toEqual(["dews", "depeg", "launch"]);

    const body = sentMessageBody();
    expect(body.text).toContain("Selected: DEWS, Depeg, Launch");
    const buttons = inlineButtons(body);
    expect(buttons).toContainEqual({ text: "✓ Launch", callback_data: "setup:type-toggle:launch" });
    expect(buttons).toContainEqual({ text: "Next →", callback_data: "setup:next" });
  });

  it("setup:target:type opens one ticker prompt with an inline cancel affordance", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "custom-target",
            alertTypes: ["dews", "launch"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:target:type"), "test-secret", "bot-token");

    const pendingWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    const latestPendingWrite = pendingWrites[pendingWrites.length - 1];
    expect(latestPendingWrite).toBeDefined();
    const payload = JSON.parse(String(latestPendingWrite!.binds[2] ?? "{}")) as {
      step?: string;
      alertTypes?: string[];
    };
    expect(payload.step).toBe("awaiting-ticker");
    expect(payload.alertTypes).toEqual(["dews", "launch"]);

    const sendCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("sendMessage"));
    expect(sendCalls).toHaveLength(1);
    const promptBody = sentMessageBody();
    expect(promptBody.text).toContain("Reply with a ticker");
    expect((promptBody.reply_markup as { force_reply?: boolean } | undefined)?.force_reply).toBeUndefined();
    expect(inlineButtons(promptBody)).toContainEqual({ text: "Cancel", callback_data: "setup:cancel" });
  });

  it("setup:branch:skip sends a slim command reference instead of the full start surface", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "branch",
            alertTypes: [],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:branch:skip"), "test-secret", "bot-token");

    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      true,
    );
    const body = sentMessageBody();
    expect(body.text).toContain("Command reference");
    expect(body.text).toContain("/help");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/list");
    expect(body.text).not.toContain("<b>Alert types</b>");
    expect(body.text).not.toContain("Other useful setups");
  });

  it("clears a stale setup-step row before reopening the setup wizard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: makeSetupPendingRow(
            {
              step: "awaiting-ticker",
              alertTypes: ["dews"],
              target: null,
            },
            {
              expiresAt: Math.floor(Date.now() / 1000) - 1,
              initiatorUserId: "999",
            },
          ),
        },
      ]);

      await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      const pendingWrites = history.filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
      );
      expect(pendingWrites.length).toBeGreaterThan(0);
      const latestPayload = JSON.parse(String(pendingWrites[pendingWrites.length - 1].binds[2] ?? "{}")) as {
        step?: string;
      };
      expect(latestPayload.step).toBe("branch");
      expect(latestSendMessageBody().text).toContain("Welcome to PharosWatchBot");
    } finally {
      warn.mockRestore();
    }
  });

  it("setup-step pending state lets a fresh slash command through after clearing wizard state", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Commands");
  });

  it("setup-step branch nudges the user when they type instead of tapping a button", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "recommended"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Tap one of the buttons above");
    const history = db.getHistory();
    // Plain text at the branch step does not clear the wizard — the user can still tap a button.
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
  });

  it("setup-step /cancel confirms cancellation instead of replying 'No pending selection'", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/cancel"), "test-secret", "bot-token");

    const body = sentMessageBody().text;
    expect(body).toContain("Setup cancelled");
    expect(body).not.toContain("No pending selection");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("handles addressed commands in group chats", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", { chatType: "group" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Commands");
    expect(sentMessageBody().text).toContain("In groups");
  });

  it("rejects channel-originated mutating commands without changing subscriptions", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-100123, "/subscribe dews USDC", "test-secret", {
        chatType: "channel",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Channel-originated mutations are not supported");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"))).toBe(false);
  });

  it("keeps discovery keyboards for addressed /coverage commands in group chats", async () => {
    const db = mockD1([
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM yield_data", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
    ]);

    const coverageRes = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/coverage@PharosWatchBot USDC", "test-secret", { chatType: "group", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    expect(coverageRes.status).toBe(200);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("/sendMessage"))
      .map(([, init]) => JSON.parse((init?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    const coverageBody = sentBodies.find((body) => body.text.includes("USDC coverage"));
    expect(coverageBody).toBeDefined();
    const coverageButtons = inlineButtons(coverageBody!);
    expect(coverageButtons).toEqual(
      expect.arrayContaining([
        { text: "Why?", callback_data: "why:usdc-circle" },
        { text: "Coverage", callback_data: "coverage:usdc-circle" },
        { text: "Subscribe", callback_data: "quicksub:usdc-circle" },
      ]),
    );
    expect(coverageButtons.some((button) => button.web_app)).toBe(false);
  });

  it("ignores commands addressed to the channel handle in group chats", async () => {
    const db = mockD1([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@pharoswatch", "test-secret", { chatType: "supergroup" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("handles /subscribe validation: no tickers", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews"), "test-secret", "bot-token");

    expect(sentMessageBody().text.toLowerCase()).toContain("ticker");
  });

  it("handles /subscribe validation: no types", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe USDC"), "test-secret", "bot-token");

    expect(sentMessageBody().text.toLowerCase()).toContain("alert type");
  });

  it("handles /list with no subscriptions", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("No active subscriptions");
    expect(body.text).toContain("/presets");
    expectMiniAppButton(body, "Open control panel", "watchlist");
    expectMiniAppButton(body, "Browse presets", "presets");
  });

  it("allows non-admin group users to view /list without an admin lookup", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/list@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("No active subscriptions");
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
  });

  it("allows non-admin group users to open read-only /settings and /timezone views", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/settings@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/timezone@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("sendMessage"))
      .map((call) => JSON.parse((call[1]?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    expect(sentBodies.some((body) => body.text.includes("<b>Settings</b>"))).toBe(true);
    const timezoneBody = sentBodies.find((body) => body.text.includes("Current timezone"));
    expect(timezoneBody).toBeDefined();
    expect(timezoneBody?.reply_markup).toBeUndefined();
    expect(timezoneBody?.text).not.toContain("keyboard");
  });

  it("denies mutating group commands when Telegram omits from.id", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatAdministrators")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        includeFrom: false,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("keeps group admin denial copy short and caps admin hints at three names", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      if (target.includes("getChatAdministrators")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { status: "creator", user: { id: 1, username: "admin1" } },
              { status: "administrator", user: { id: 2, username: "admin2" } },
              { status: "administrator", user: { id: 3, username: "admin3" } },
              { status: "administrator", user: { id: 4, username: "admin4" } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    const text = latestSendMessageBody().text;
    expect(text).toContain("Only group admins can /mute");
    expect(text).toContain("@admin1");
    expect(text).toContain("@admin2");
    expect(text).toContain("@admin3");
    expect(text).toContain("and 1 more");
    expect(text).not.toContain("@admin4");
    expect(text).not.toContain("change alert settings");
  });

  it("denies /pause for non-admin group users", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/pause@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("denies mutating /timezone args for non-admin group users", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/timezone@PharosWatchBot Europe/Paris", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("does not grant group mutation access from a stale cached admin membership", async () => {
    const cachedAdmin = JSON.stringify({
      status: "administrator",
      userId: "7",
      username: "oldadmin",
      firstName: "Old Admin",
    });
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:chat-member:-123:7",
            value: cachedAdmin,
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
        first: null,
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "demoted" }, status: "member" } }),
          { status: 200 },
        );
      }
      if (String(url).includes("getChatAdministrators")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:chat-member:-123:7"))).toBe(false);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("soft gating mode warns a non-admin but still executes the gated mutation", async () => {
    const original = TELEGRAM_GROUP_ADMIN_GATING.mode;
    TELEGRAM_GROUP_ADMIN_GATING.mode = "soft";
    try {
      const db = mockD1([
        { match: "telegram_pending_disambiguation", rows: [] },
        { match: "FROM cache WHERE key = ?", rows: [], first: null },
        { match: "FROM telegram_subscribers", rows: [], first: null },
      ]);
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("getChatMember")) {
          return new Response(
            JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      await handleTelegramWebhook(
        db,
        makeWebhookRequest(-123, "/subscribe@PharosWatchBot dews USDC", "test-secret", {
          chatType: "supergroup",
          fromId: 7,
        }),
        "test-secret",
        "bot-token",
      );

      // Command should proceed (subscriber row written), not be denied.
      expect(db.getHistory().some((entry) => /INSERT INTO telegram_subscribers/i.test(entry.sql))).toBe(true);
      // A group_admin_denial usage event with outcome 'warned' should be recorded.
      const usageRow = db
        .getHistory()
        .find(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds[1] === "group_admin_denial" &&
            entry.binds[3] === "/subscribe",
        );
      expect(usageRow).toBeDefined();
      expect(usageRow!.binds[4]).toBe("warned");
    } finally {
      TELEGRAM_GROUP_ADMIN_GATING.mode = original;
    }
  });

  it("splits long /list replies into Telegram-safe chunks", async () => {
    const subscriptions = Array.from({ length: 220 }, (_, index) => ({
      stablecoin_id: `synthetic-stablecoin-${String(index).padStart(3, "0")}-with-a-long-portfolio-label`,
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      dews_min_band: "WARNING",
      safety_mode: "downgrade-only",
      depeg_worsening_bps_step: 250,
    }));
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          global_alert_dews: 1,
          global_alert_depeg: 1,
          global_alert_safety: 1,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: 250,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: subscriptions },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchSpy.mock.calls) {
      const body = JSON.parse(init?.body as string) as { text: string };
      expect(body.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("shows launch follows in /list and reads alert_launch from the subscription query", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdpt-western-union",
            alert_dews: 0,
            alert_depeg: 0,
            alert_safety: 0,
            alert_launch: 1,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const history = db.getHistory();
    const subscriptionsQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionsQuery?.sql).toContain("alert_launch");
    expect(sentMessageBody().text).toContain("Launch");
    expect(sentMessageBody().text).toContain("USDPT");
  });

  it("attaches a [Manage] inline button to /list when subscriptions exist", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            alert_launch: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(callbacks).toContain("manage:page:0");
  });

  it("omits the callback [Manage] button when /list has no explicit coin subscriptions", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.some((button) => button.callback_data === "manage:page:0")).toBe(false);
    expect(
      buttons.some(
        (button) =>
          button.text === "Open control panel" &&
          button.web_app?.url === "https://pharos.watch/pharoswatchbot/app/?startapp=watchlist",
      ),
    ).toBe(true);
  });

  it("replies to /presets with the preset catalog", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/presets"), "test-secret", "bot-token");

    const body = sentMessageBody();
    const text = body.text;
    expect(text).toContain("Preset Watchlists");
    expect(text).toContain("usd-top25");
    expect(text).toContain("mcap-ge-1b");
    expectMiniAppButton(body, "Browse presets", "presets");
  });

  it("replies unknown command", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/attacker-controlled-token"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(body.text).toContain("Unknown command");
    expect((body.reply_markup?.inline_keyboard ?? []).flat()).toContainEqual({
      text: "/help",
      callback_data: "help:commands",
    });

    const usageRows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRows.map((entry) => [entry.binds[1], entry.binds[3], entry.binds[4]])).toEqual([
      ["unknown_command", "unknown", "unknown"],
      ["command", "unknown", "unknown_command"],
    ]);
  });

  it("handles /subscribe happy path with unique ticker", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDC"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Updated subscriptions");
    expect(sentMessageBody().text).toContain("USDC");
  });

  it("handles /subscribe launch for a pre-launch ticker and includes Launch in the summary", async () => {
    const launchTarget = resolveTicker("USDPT");
    if (launchTarget.status !== "unique") {
      throw new Error("Expected USDPT to resolve uniquely for launch subscription test");
    }

    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: launchTarget.matches[0].id,
            alert_dews: 0,
            alert_depeg: 0,
            alert_safety: 0,
            alert_launch: 1,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch USDPT"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.binds[1] === launchTarget.matches[0].id,
      ),
    ).toBe(true);
    const subscriptionsQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionsQuery?.sql).toContain("alert_launch");
    expect(sentMessageBody().text).toContain("Launch");
    expect(sentMessageBody().text).toContain("USDPT");
  });

  it("gates /subscribe ... all behind a confirmation prompt", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews safety all"), "test-secret", "bot-token");

    const history = db.getHistory();
    // No global_alert_* upsert happens until the user taps Confirm.
    expect(history.some((entry) => /UPDATE.*global_alert_dews/.test(entry.sql))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.text).toMatch(/subscribe \d+ coins/);
    expect(body.reply_markup).toBeDefined();
  });

  it("subscribe reserve all (after Confirm) writes the global reserve flag", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "subscribe",
            alertTypes: ["reserve"],
            coinIds: [],
            presetIds: [],
            subscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeCallbackRequest("confirm:bulk", { chatId: 123, fromId: 999, fromUsername: "requester" }),
      "test-secret",
      "bot-token",
    );

    const subscriberUpsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
    expect(subscriberUpsert).toBeDefined();
    expect(subscriberUpsert!.sql).toContain("global_alert_reserve = MAX");
    expect(subscriberUpsert!.binds[11]).toBe(1);
  });

  it("gates /subscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews usd-top25"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    // Deferred — no subscription rows are written until the user taps Confirm.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.reply_markup).toBeDefined();
  });

  it("includes preset work in preset-only /import confirmation copy", async () => {
    const token = encodeWatchlistToken({
      coinIds: [],
      alertTypes: ["dews", "reserve"],
      presetIds: ["usd-top25"],
    });
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    const history = db.getHistory();
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(String(confirmInsert?.binds[2] ?? "{}")) as {
      coinIds: string[];
      presetIds: string[];
      alertTypes: string[];
    };
    expect(payload.coinIds).toEqual([]);
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(payload.alertTypes).toEqual(["dews", "reserve"]);

    const body = sentMessageBody();
    expect(body.text).toContain("1 preset");
    expect(body.text).toContain("Presets: USD Top 25");
    expect(body.text).not.toContain("0 coins");
    expect(body.reply_markup).toBeDefined();
  });

  it("counts only registry misses in /import dropped-note copy while deduping tracked ids", async () => {
    const token = encodeWatchlistToken({
      coinIds: ["usdc-circle", "usdc-circle", "retired-stablecoin"],
      alertTypes: ["dews"],
      presetIds: [],
    });
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    const confirmInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(String(confirmInsert?.binds[2] ?? "{}")) as {
      coinIds: string[];
      presetIds: string[];
      alertTypes: string[];
    };
    expect(payload.coinIds).toEqual(["usdc-circle"]);
    expect(payload.presetIds).toEqual([]);
    expect(payload.alertTypes).toEqual(["dews"]);

    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.text).toContain("USDC");
    expect(body.text).toContain("(1 no longer tracked and were skipped.)");
    expect(body.text).not.toContain("(2 no longer tracked");
    expect(body.reply_markup).toBeDefined();
  });

  it("gates /subscribe with a >10-coin preset and depeg-step modifier behind a confirmation prompt", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/subscribe usd-top-50 depeg-step 250"),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    // Deferred — the depeg-step modifier is preserved in the pending payload.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as {
      kind: string;
      depegWorseningBpsStep: number;
    };
    expect(payload.kind).toBe("subscribe");
    expect(payload.depegWorseningBpsStep).toBe(250);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("handles /subscribe with a dashed preset alias (still gated above threshold)", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews usd-top-25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Confirm?");
    // The dashed alias was canonicalized before being stored in the pending payload.
    const confirmInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as { presetIds: string[] };
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("rejects preset watchlists for launch alerts", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch usd-top25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Preset watchlists support dews, depeg, and safety only");
  });

  it("rejects mixing all with preset targets", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/subscribe dews all usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Use either &quot;all&quot; or specific tickers/presets");
  });

  it("handles /subscribe with unknown ticker", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews XYZZY"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Ticker");
    expect(text.toLowerCase()).toContain("not found");
    expect(text).toContain("/presets");
  });

  it("handles /subscribe with ambiguous ticker (disambiguation)", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for disambiguation test");
    }

    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDF"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
    const pendingInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(pendingInsert?.binds).toContain("999");
    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(body.text).toContain("matches");
    const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.some((button) => button.text.startsWith("1.") && button.callback_data === "select:1")).toBe(true);
  });

  it("handles /set for a unique ticker", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set USDC dews WARNING"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("Updated settings");
    expect(body.text).toContain("DEWS&gt;=WARNING");
    expectMiniAppButton(body, "Open in app", "coin_usdc-circle");
  });

  it("handles /set all for global alert flags", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      {
        match: "FROM telegram_subscribers",
        matchBinds: ["123"],
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set all depeg off"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("global_alert_depeg = excluded.global_alert_depeg"))).toBe(true);
    const body = sentMessageBody();
    expect(body.text).toContain("Updated all-stablecoin alerts");
    expectMiniAppButton(body, "Open in app", "watchlist");
  });

  it("handles /set all depeg-step for global worsening alerts", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 0,
          global_alert_depeg: 1,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: 250,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set all depeg-step 250"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("global_alert_depeg"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("global_depeg_worsening_bps_step = ?"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes(250))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated all-stablecoin alerts");
    expect(sentMessageBody().text).toContain("Depeg +250bps");
  });

  it("shows global alert coverage in /list", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 0,
          global_alert_depeg: 1,
          global_alert_safety: 1,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("All stablecoins: Depeg, Safety (downgrades; 3-point drop when scored)");
    expect(text).toContain("Coins (0):");
  });

  it("handles /mute quiet hours", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/mute 22-07"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Quiet hours enabled");
    expect(text).toContain("22:00–07:00 UTC");
  });

  it("/unsnooze clears alert snooze and offers private Mini App controls", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsnooze"), "test-secret", "bot-token");

    expect(
      db.getHistory().some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL") && entry.binds[0] === "123"),
    ).toBe(true);
    const body = sentMessageBody();
    expect(body.text).toContain("Alert snooze cleared");
    expectMiniAppButton(body, "Open in app", "snooze");
  });

  it("/timezone <zone> persists a valid IANA zone", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone Europe/Paris"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);

    const upsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Europe/Paris"));
    expect(upsert).toBeDefined();
    const body = sentMessageBody();
    expect(body.text).toContain("Timezone set to Europe/Paris");
    expectMiniAppButton(body, "Open in app", "quiet-hours");
  });

  it("/timezone rejects unknown zones without writing to D1", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone Mars/Olympus_Mons"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    const wrote = db
      .getHistory()
      .some((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Mars/Olympus_Mons"));
    expect(wrote).toBe(false);
    expect(sentMessageBody().text).toContain("Unknown timezone");
  });

  it("/timezone with no argument shows current zone and an inline keyboard", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 0,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
          timezone: "Europe/Paris",
          alert_snooze_until_ts: null,
          consecutive_block_count: 0,
          consecutive_block_first_at: null,
        },
      },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/timezone"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    expect(sent.text).toContain("Current timezone: Europe/Paris");
    const flat = (sent.reply_markup?.inline_keyboard ?? []).flat();
    expect(flat.some((btn) => btn.callback_data === "tz:UTC")).toBe(true);
    expect(flat.some((btn) => btn.callback_data === "tz:Europe/Paris")).toBe(true);
    expectMiniAppButton(sent, "Open in app", "quiet-hours");
  });

  it("finalizes pending disambiguation and continues remaining tickers", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram disambiguation flow test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);

    const insertedIds = history
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
      .map((entry) => String(entry.binds[1]))
      .sort();
    expect(insertedIds).toEqual([ambiguous.matches[0].id, usdc.matches[0].id].sort());

    const text = sentMessageBody().text;
    expect(text).toContain("Updated subscriptions");
    expect(text).toContain(ambiguous.matches[0].id);
    expect(text).toContain(usdc.matches[0].id);
  });

  it("preserves depeg-step when completing a pending subscribe disambiguation", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for depeg-step disambiguation flow test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({
            alertTypes: ["depeg"],
            presetIds: [],
            depegWorseningBpsStep: 250,
          }),
          alert_types: JSON.stringify(["depeg"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 0,
            alert_depeg: 1,
            alert_safety: 0,
            alert_launch: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: 250,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"));
    expect(insert?.binds).toContain(250);
    expect(sentMessageBody().text).toContain("Depeg +250bps");
  });

  it("blocks another group member from completing a pending selection", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(sentMessageBody().text).toContain("Only the user who started this pending selection can complete it");
  });

  it("allows /sample to run while a pending selection remains active", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for sample passthrough test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/sample"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("This was a sample alert");
    expect(sentMessageBody().text).not.toContain("pending selection");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("clears a same-initiator pending selection before running /forget", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for forget clear-and-run test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/forget"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    const forgetInsert = history.find(
      (entry) =>
        entry.sql.includes("INSERT INTO telegram_pending_disambiguation") && entry.binds.includes("forget-confirm"),
    );
    expect(forgetInsert).toBeDefined();
    expect(sentMessageBody().text).toContain("permanently delete your Pharos subscriber data");
  });

  it("counts group pending-selection replies against the actor flood cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for pending reply flood test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:-123:actor:222"],
        rows: [{ key: "telegram:command-flood:-123:actor:222", value: "20", updated_at: 1_699_999_990 }],
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Too many Telegram actions");
    expect(sentMessageBody().text).not.toContain("Only the user who started");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("ignores unrelated group text from non-initiators while a pending selection exists", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership noise test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "thanks, looks good", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reminds the initiating user when a pending selection reply is invalid", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for invalid selection reminder test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "not a number"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    const text = sentMessageBody().text;
    expect(text).toContain("I could not parse");
    expect(text).toContain("&quot;not&quot;");
    expect(text).toContain("numbers only");
    expect(text).toContain("USDF");
  });

  it("allows the initiating group member to complete a pending selection", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 111 }),
      "test-secret",
      "bot-token",
    );

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated subscriptions");
  });

  it("finalizes pending /unsubscribe disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram unsubscribe disambiguation flow test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "unsubscribe",
          action_payload: JSON.stringify({}),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(sentMessageBody().text).toContain("Removed 2 coin subscriptions");
    expect(sentMessageBody().text).toContain(ambiguous.matches[0].id);
    expect(sentMessageBody().text).toContain(usdc.matches[0].id);
  });

  it("finalizes pending /set disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram set disambiguation flow test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "set",
          action_payload: JSON.stringify({ ticker: "USDF", setting: "dews", enabled: true, minBand: "WARNING" }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(
      history
        .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
        .map((entry) => entry.binds[1]),
    ).toEqual([ambiguous.matches[0].id, usdc.matches[0].id]);

    const text = sentMessageBody().text;
    expect(text).toContain("Updated settings");
    expect(text).toContain("DEWS&gt;=WARNING");
  });

  it("keeps a pending subscribe flow alive when a non-critical stored field is malformed", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram malformed pending-row test");
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: "{bad-json",
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: "{bad-json",
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated subscriptions");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=action_payload"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=resolved_ids"));
  });

  it("clears malformed active pending selections with a recovery message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: "{bad-json",
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("pending selection could not be restored");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=candidates"));
  });

  it("gates /unsubscribe all behind a confirmation prompt", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all"), "test-secret", "bot-token");

    const history = db.getHistory();
    // No DELETE happens until the user taps Confirm.
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as { kind: string; unsubscribeAll: boolean };
    expect(payload.kind).toBe("unsubscribe");
    expect(payload.unsubscribeAll).toBe(true);
    const text = sentMessageBody().text.toLowerCase();
    expect(text).toContain("confirm?");
  });

  it("gates /unsubscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe usd-top25"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("allows legacy frozen coin subscriptions to be removed by exact id", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) {
      throw new Error("Expected at least one frozen stablecoin fixture");
    }

    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, `/unsubscribe ${frozen.id}`), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(history.find((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))?.binds).toEqual([
      "123",
      frozen.id,
    ]);
    expect(sentMessageBody().text).toContain(frozen.id);
  });

  it("uses disambiguation for ambiguous /unsubscribe instead of deleting all matches", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for unsubscribe disambiguation test");
    }

    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe USDF"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(body.text).toContain("matches");
    expect(
      (body.reply_markup?.inline_keyboard ?? []).flat().some((button) => button.callback_data === "select:1"),
    ).toBe(true);
  });

  it("cancels pending disambiguation with /cancel", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for cancel test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/cancel"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Pending selection cancelled");
  });

  it("unsubscribe all (after Confirm) clears launch alert flags", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "unsubscribe",
            presetIds: [],
            coinIds: [],
            unsubscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    const request = makeCallbackRequest("confirm:bulk");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    const updateSql = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("alert_launch = 0");
    expect(updateSql!.sql).toContain("alert_reserve = 0");
    expect(updateSql!.sql).toContain("global_alert_launch = 0");
    expect(updateSql!.sql).toContain("global_alert_reserve = 0");
    expect(updateSql!.sql).toContain("global_depeg_worsening_bps_step = NULL");
  });

  it("handles D1 error gracefully", async () => {
    const db = mockD1([]);
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("D1 error");
    });

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
  });

  it("/mute does not overwrite alert flags on ON CONFLICT", async () => {
    const db = mockD1([{ match: "SELECT action_type, action_payload", rows: [], first: null }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(42, "/mute 22-07"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const subscriberUpsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && /ON CONFLICT\(chat_id\)/.test(h.sql));
    expect(subscriberUpsert).toBeDefined();
    const updateClause = subscriberUpsert!.sql.split("DO UPDATE SET")[1] ?? "";
    expect(updateClause).not.toMatch(/\balert_dews\s*=\s*excluded\.alert_dews\b/);
    expect(updateClause).not.toMatch(/\balert_depeg\s*=\s*excluded\.alert_depeg\b/);
    expect(updateClause).not.toMatch(/\balert_safety\s*=\s*excluded\.alert_safety\b/);
    expect(updateClause).not.toMatch(/\balert_launch\s*=\s*excluded\.alert_launch\b/);
    expect(updateClause).not.toMatch(/\bglobal_alert_safety\s*=\s*excluded\./);
    expect(updateClause).toContain("quiet_hours_enabled = excluded.quiet_hours_enabled");
  });

  it("/status USDC replies with a compact card", async () => {
    const db = mockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 85, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9999, updated_at: 1700000000 }] },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(1, "/status USDC"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    expect(sent.text).toContain("USDC");
    expect(sent.text).toContain("CALM");
    expect(sent.text).toContain("Safety: A");
    expect(sent.text).toContain("Depeg: stable");
    expect(sent.text).toContain("Price: $0.9999");
    // P1-U11: discoverability buttons attached to the status card.
    const buttons: Array<{ text: string; callback_data?: string; web_app?: { url: string } }> = (
      sent.reply_markup?.inline_keyboard ?? []
    ).flat();
    expect(buttons.map((b) => b.text)).toEqual(["Why?", "Coverage", "Subscribe", "Open in app"]);
    expect(buttons.slice(0, 3).map((b) => b.callback_data)).toEqual([
      "why:usdc-circle",
      "coverage:usdc-circle",
      "quicksub:usdc-circle",
    ]);
    expect(buttons[3]?.web_app?.url).toBe("https://pharos.watch/pharoswatchbot/app/?startapp=coin_usdc-circle");
    // Bot API limit: callback_data must stay ≤64 bytes.
    for (const button of buttons) {
      expect((button.callback_data ?? "").length).toBeLessThanOrEqual(64);
    }
  });

  it("/status ambiguous ticker asks for exact coin id instead of numeric reply", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for status ambiguity test");
    }

    const db = mockD1([{ match: "SELECT action_type, action_payload", rows: [], first: null }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(1, "/status USDF"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("Re-run /status with the exact Pharos coin id");
    expect(body).toContain(`/status ${ambiguous.matches[0].id}`);
    expect(body).not.toContain("Reply with the number");
  });

  it("replies with retry message when preset resolution cache is missing", async () => {
    const db = mockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(42, "/subscribe dews usd-top25"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("temporarily unavailable");
  });

  it("executes /subscribe with a small explicit ticker set without confirmation", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            alert_launch: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDC"), "test-secret", "bot-token");

    const history = db.getHistory();
    // Single coin is below threshold — no confirmation gate.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_pending_disambiguation") &&
          (entry.binds as unknown[]).includes("confirm-bulk"),
      ),
    ).toBe(false);
  });

  it("drops callback taps over the ingress flood cap before callback handlers run", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-flood:123"],
        rows: [{ key: "telegram:command-flood:123", value: "20", updated_at: 1_699_999_990 }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeCallbackRequest("status:usdc-circle"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const answerBody = telegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toContain("Too many button taps");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("callback:status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("rate-limits status callbacks through the /status cooldown bucket", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: ["telegram:command-cooldown:123:/status", "1", 1_700_000_000, 1_699_999_980],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-cooldown:123:/status"],
        rows: [{ updated_at: 1_700_000_000 }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeCallbackRequest("status:usdc-circle"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const answerBody = telegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("releases a status callback cooldown when the callback handler throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([{ match: "FROM stress_signals", rows: [], throwError: new Error("status read failed") }]);

    const res = await handleTelegramWebhook(db, makeCallbackRequest("status:usdc-circle"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("DELETE FROM cache WHERE key = ?") &&
            entry.binds.includes("telegram:command-cooldown:123:/status"),
        ),
    ).toBe(true);
    const answerBody = telegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toBe("Action failed. Try again.");
    warn.mockRestore();
  });

  it("rejects channel-originated mutating callbacks before callback handlers run", async () => {
    const db = mockD1();

    const res = await handleTelegramWebhook(
      db,
      makeCallbackRequest("quicksub:usdc-circle", { chatId: -100123, chatType: "channel" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const answerBody = telegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery", { last: false });
    expect(answerBody.text).toBe("Channel-originated actions are not supported.");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("confirm:bulk callback executes a deferred /unsubscribe all", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "unsubscribe",
            presetIds: [],
            coinIds: [],
            unsubscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    const request = makeCallbackRequest("confirm:bulk");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("cancel:bulk callback clears pending without executing", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "unsubscribe",
            presetIds: [],
            coinIds: [],
            unsubscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    const request = makeCallbackRequest("cancel:bulk");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("pending confirm-bulk ignores plain text replies in private chats with a reminder", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "subscribe",
            alertTypes: ["dews"],
            presetIds: [],
            coinIds: [],
            subscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1,2,3"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => /UPDATE.*global_alert_/.test(entry.sql))).toBe(false);
    expect(sentMessageBody().text).toContain("Tap Confirm or Cancel");
  });

  it("pending confirm-bulk nudges only the initiating user in groups", async () => {
    const pendingRow = {
      action_type: "confirm-bulk",
      action_payload: JSON.stringify({
        kind: "subscribe",
        alertTypes: ["dews"],
        presetIds: [],
        coinIds: [],
        subscribeAll: true,
      }),
      alert_types: JSON.stringify([]),
      resolved_ids: JSON.stringify([]),
      ambiguous_ticker: "",
      candidates: JSON.stringify([]),
      remaining_tickers: JSON.stringify([]),
      expires_at: Math.floor(Date.now() / 1000) + 60,
      initiator_user_id: "999",
    };
    const nonInitiatorDb = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: pendingRow,
      },
    ]);

    await handleTelegramWebhook(
      nonInitiatorDb,
      makeWebhookRequest(-123, "looks good", "test-secret", { chatType: "supergroup", fromId: 111 }),
      "test-secret",
      "bot-token",
    );

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const initiatorDb = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: pendingRow,
      },
    ]);

    await handleTelegramWebhook(
      initiatorDb,
      makeWebhookRequest(-123, "looks good", "test-secret", { chatType: "supergroup", fromId: 999 }),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Tap Confirm or Cancel");
  });

  it("pending forget-confirm ignores plain text replies in private chats with a reminder", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "forget-confirm",
          action_payload: "{}",
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "delete this"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
    expect(sentMessageBody().text).toContain("Tap Confirm or Cancel");
  });
});
