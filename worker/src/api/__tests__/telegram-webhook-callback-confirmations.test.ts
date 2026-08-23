import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSpy,
  handleTelegramWebhook,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  fixtureTelegramApiCallBody,
} from "./telegram-webhook.test-support";


describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("drops callback taps over the ingress flood cap before callback handlers run", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = makeTelegramWebhookDb([
      {
        match: "RETURNING value",
        rows: [{ value: "21" }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeCallbackRequest("status:usdc-circle"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const answerBody = fixtureTelegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toContain("Too many button taps");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("callback:status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("rate-limits status callbacks through the /status cooldown bucket", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = makeTelegramWebhookDb([
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
    const answerBody = fixtureTelegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("releases a status callback cooldown when the callback handler throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeTelegramWebhookDb([{ match: "FROM stress_signals", rows: [], throwError: new Error("status read failed") }]);

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
    const answerBody = fixtureTelegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery");
    expect(answerBody.text).toBe("Action failed. Try again.");
    warn.mockRestore();
  });

  it("executes private quicksub through the webhook with the expected mutations and Telegram transcript", async () => {
    const db = makeTelegramWebhookDb();

    const res = await handleTelegramWebhook(
      db,
      makeCallbackRequest("quicksub:usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    const subscriberUpsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
    expect(subscriberUpsert?.binds.slice(0, 6)).toEqual(["123", "requester", 1, 1, 0, 0]);
    const subscriptionInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"));
    expect(subscriptionInsert?.binds.slice(0, 6)).toEqual(["123", "usdc-circle", 1, 1, 0, 0]);
    expect(
      fetchSpy.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname.split("/").pop(),
        JSON.parse(String(init?.body)),
      ]),
    ).toEqual([
      [
        "sendMessage",
        {
          chat_id: "123",
          text: "Subscribed to DEWS + depeg for USDC.",
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Open in app",
                  web_app: { url: "https://pharos.watch/pharoswatchbot/app/?startapp=coin_usdc-circle" },
                },
              ],
            ],
          },
        },
      ],
      [
        "answerCallbackQuery",
        {
          callback_query_id: "cb1",
          text: "Subscribed to DEWS + depeg for USDC.",
          show_alert: false,
        },
      ],
    ]);
  });

  it("rejects channel-originated mutating callbacks before callback handlers run", async () => {
    const db = makeTelegramWebhookDb();

    const res = await handleTelegramWebhook(
      db,
      makeCallbackRequest("quicksub:usdc-circle", { chatId: -100123, chatType: "channel" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const answerBody = fixtureTelegramApiCallBody<{ text?: string }>(fetchSpy, "answerCallbackQuery", { last: false });
    expect(answerBody.text).toBe("Channel-originated actions are not supported.");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("confirm:bulk callback executes a deferred /unsubscribe all", async () => {
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
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
    const nonInitiatorDb = makeTelegramWebhookDb([
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
    const initiatorDb = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
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
