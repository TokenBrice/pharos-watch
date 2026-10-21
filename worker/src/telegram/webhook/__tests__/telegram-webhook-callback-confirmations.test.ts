import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../../store/subscription-eligibility";
import {
  fetchSpy,
  handleTelegramWebhook,
  makeWebhookRequest,
  makeCallbackRequest,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  fixtureTelegramApiCallBody,
  latestSendMessageBody,
  inlineButtons,
} from "./telegram-webhook.test-support.ts";


const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

function callbackFromLatest(prefix: string): string {
  const data = inlineButtons(latestSendMessageBody()).find((button) => button.callback_data?.startsWith(prefix))?.callback_data;
  if (!data) throw new Error(`Missing emitted callback ${prefix}`);
  return data;
}

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("claims the first follow once from the one-tap setup on replay", async () => {
    const { sqlite, db } = fixtures.open();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(
      JSON.stringify({ peggedAssets: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 1_000_000 } }] }), now,
    );
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start pw1_landing_setup", "test-secret", { updateId: 9601 }), "test-secret", "bot-token");
    const callback = callbackFromLatest("setup:top25");
    for (let i = 0; i < 2; i += 1) {
      await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9602 }), "test-secret", "bot-token");
    }
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ first_follow_at: now });
    expect(sqlite.prepare("SELECT preset_id FROM telegram_preset_subscriptions WHERE chat_id = '123'").all())
      .toEqual([{ preset_id: "usd-top25" }]);
  });
  it.each([
    { command: "/subscribe dews usdc-circle", feature: "direct" },
    { callback: "quicksub:usdc-circle", feature: "direct" },
    { callback: "settings:c:usdc-circle:db:A", feature: "direct" },
    { callback: "settings:gt:depeg:1", feature: "global" },
  ])("records route-independent first enable for $feature", async (route) => {
    const { sqlite, db } = fixtures.open();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const request = route.command
      ? makeWebhookRequest(123, route.command, "test-secret", { updateId: 9701 })
      : makeCallbackRequest(route.callback!, { updateId: 9701 });
    expect((await handleTelegramWebhook(db, request, "test-secret", "bot-token")).status).toBe(200);
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ first_follow_at: now });
  });
  it("records a first global follow on the stateless bulk confirmation, not the prompt or a replay", async () => {
    const { sqlite, db } = fixtures.open();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews all", "test-secret", { updateId: 9801 }), "test-secret", "bot-token");
    expect((sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '123'").get() as
      { first_follow_at: number | null } | undefined)?.first_follow_at ?? null).toBeNull();
    const callback = callbackFromLatest("bulk:sa:");
    await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9802 }), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9802 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT first_follow_at, global_alert_dews FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ first_follow_at: now, global_alert_dews: 1 });
  });

  it("applies an 11-coin /subscribe at once without a confirmation", async () => {
    const { sqlite, db } = fixtures.open();
    const coins = TELEGRAM_SUBSCRIBABLE_STABLECOINS.slice(0, 11).map((coin) => coin.id).join(" ");
    await handleTelegramWebhook(db, makeWebhookRequest(123, `/subscribe dews ${coins}`, "test-secret", { updateId: 9803 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = '123'").get()).toEqual({ count: 11 });
  });

  it("keeps every stateless keyboard producer within the 64-byte callback limit", async () => {
    const { db } = fixtures.open();
    const commands = ["/start", "/subscribe depeg USDF", "/unsubscribe USDF", "/status USDF", "/subscribe dews,depeg,safety all", "/unsubscribe all", "/forget"];
    for (const [index, text] of commands.entries()) {
      await handleTelegramWebhook(db, makeWebhookRequest(123, text, "test-secret", { updateId: 9900 + index }), "test-secret", "bot-token");
    }
    const callbacks = fetchSpy.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { reply_markup?: unknown };
      return inlineButtons(body).flatMap((button) => button.callback_data ? [button.callback_data] : []);
    });
    for (const prefix of ["setup:", "pick:su:", "pick:un:", "pick:st:", "bulk:sa:", "bulk:ua:", "forget:yes:"]) {
      expect(callbacks.some((data) => data.startsWith(prefix))).toBe(true);
    }
    for (const data of callbacks) expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

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

  it("executes private quicksub through the webhook with the expected mutations and Telegram transcript", async () => {
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
    ]);

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

  it("bulk:ua removes every follow and bulk:no changes nothing", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('123', 'usdc-circle', 1)");
    const expiry = (Math.floor(Date.now() / 1000) + 600).toString(36);
    await handleTelegramWebhook(db, makeCallbackRequest("bulk:no", { updateId: 9950 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 1 });
    await handleTelegramWebhook(db, makeCallbackRequest(`bulk:ua:${expiry}`, { updateId: 9951 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 0 });
  });
});
