import { makeBulkPendingRow, pendingDisambiguationTable } from "./telegram-rows.test-support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { persistPendingDisambiguationRow } from "../../store/disambiguation";
import { resolveTicker } from "../../common/alerts-parser";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../../store/subscription-eligibility";
import {
  fetchSpy,
  handleTelegramWebhook,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  fixtureTelegramApiCallBody,
  latestSendMessageBody,
  inlineButtons,
  mockTelegramMembership,
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

function expectBoundCallbacks(): void {
  const callbacks = fetchSpy.mock.calls.flatMap(([, init]) => {
    const body = JSON.parse(String(init?.body)) as { reply_markup?: unknown };
    return inlineButtons(body).flatMap((button) => button.callback_data ? [button.callback_data] : []);
  }).filter((data) => /^(confirm|cancel|select|setup):/.test(data));
  expect(callbacks.length).toBeGreaterThan(0);
  for (const data of callbacks) {
    expect(data).toMatch(/:[a-f0-9]{16}$/);
    expect(new TextEncoder().encode(data).length).toBeGreaterThanOrEqual(1);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  }
}
describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("keeps setup attribution in the atomic first-follow transition on replay", async () => {
    const { sqlite, db } = fixtures.open();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(
      JSON.stringify({ peggedAssets: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 1_000_000 } }] }), now,
    );
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start pw1_landing_setup", "test-secret", { updateId: 9601 }), "test-secret", "bot-token");
    const callback = callbackFromLatest("setup:confirm:");
    for (let i = 0; i < 2; i += 1) {
      await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9602 }), "test-secret", "bot-token");
    }
    expect(sqlite.prepare("SELECT campaign, placement, feature, count FROM telegram_adoption_daily WHERE stage = 'first_follow'").all())
      .toEqual([{ campaign: "landing", placement: "setup", feature: "preset", count: 1 }]);
  });
  it.each([
    { command: "/subscribe dews usdc-circle", feature: "direct" },
    { command: "/set usdc-circle depeg on", feature: "direct" },
    { command: "/set all depeg on", feature: "global" },
    { callback: "quicksub:usdc-circle", feature: "direct" },
    { callback: "settings:c:usdc-circle:db:A", feature: "direct" },
    { callback: "settings:gt:depeg", feature: "global" },
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
    expect(sqlite.prepare("SELECT feature, count FROM telegram_adoption_daily WHERE stage = 'first_follow'").all())
      .toEqual([{ feature: route.feature, count: 1 }]);
  });
  it.each(["direct", "global"] as const)("records a first %s follow on bulk confirmation, not preview or replay", async (kind) => {
    const { sqlite, db } = fixtures.open();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const coins = TELEGRAM_SUBSCRIBABLE_STABLECOINS.slice(0, 11).map((coin) => coin.id).join(" ");
    const text = `/subscribe dews ${kind === "global" ? "all" : coins}`;
    await handleTelegramWebhook(db, makeWebhookRequest(123, text, "test-secret", { updateId: 9801 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT count(*) AS count FROM telegram_adoption_daily WHERE stage = 'first_follow'").get()).toEqual({ count: 0 });
    const callback = callbackFromLatest("confirm:");
    await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9802 }), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeCallbackRequest(callback, { updateId: 9802 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '123'").get()).toEqual({ first_follow_at: now });
    expect(sqlite.prepare("SELECT feature, count FROM telegram_adoption_daily WHERE stage = 'first_follow'").all())
      .toEqual([{ feature: kind === "global" ? "global" : "direct", count: 1 }]);
  });
  it("rejects a subscribe keyboard after replacement by unsubscribe and applies the fresh flow once", async () => {
    const { sqlite, db } = fixtures.open();
    let now = 1_800_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews all", "test-secret", { updateId: 9001 }), "test-secret", "bot-token");
    const oldConfirm = callbackFromLatest("confirm:");
    now += 31;
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all",
      "test-secret", { updateId: 9002 }), "test-secret", "bot-token");
    const freshConfirm = callbackFromLatest("confirm:");
    expect(freshConfirm).not.toBe(oldConfirm);
    const pendingBefore = sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all();
    const preferencesBefore = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
    for (const [data, updateId] of [[oldConfirm, 9003], [oldConfirm.replace("confirm:", "cancel:"), 9005]] as const) {
      await handleTelegramWebhook(db, makeCallbackRequest(data, { updateId }), "test-secret", "bot-token");
    }
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual(pendingBefore);
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(preferencesBefore);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    expect(fixtureTelegramApiCallBody<{ text: string }>(fetchSpy, "answerCallbackQuery").text).toMatch(/re-run/i);
    await handleTelegramWebhook(db, makeCallbackRequest(freshConfirm, { updateId: 9004 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT stablecoin_id, alert_depeg FROM telegram_subscriptions").all()).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual([]);
    const after = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
    await handleTelegramWebhook(db, makeCallbackRequest(freshConfirm, { updateId: 9004 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(after);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_webhook_operation_mutations WHERE update_id = 9004").get()).toEqual({ count: 1 });
    expectBoundCallbacks();
  });

  it("binds selection candidates before a same-owner freshly-authorized group selection", async () => {
    const { sqlite, db } = fixtures.open();
    const oldMatch = resolveTicker("USDC");
    const freshMatch = resolveTicker("USDT");
    if (oldMatch.status !== "unique" || freshMatch.status !== "unique") throw new Error("Missing selection fixtures");
    const oldCoin = oldMatch.matches[0];
    const freshCoin = freshMatch.matches[0];
    for (const [flowId, coin] of [["1111111111111111", oldCoin], ["2222222222222222", freshCoin]] as const) {
      await persistPendingDisambiguationRow(db, {
        chatId: "-123", actionType: "subscribe",
        actionPayload: { schemaVersion: 1, flowId, alertTypes: ["dews"], presetIds: [],
          resolvedIds: [], ambiguousTicker: "USD", candidates: [coin], remainingTickers: [] },
        alertTypes: ["dews"], resolvedIds: [], ambiguousTicker: "USD", candidates: [coin],
        remainingTickers: [], initiatorUserId: "999",
      });
    }
    mockTelegramMembership(fetchSpy, "administrator", { id: 999, is_bot: false, first_name: "admin" });
    await handleTelegramWebhook(db, makeCallbackRequest("select:1:1111111111111111",
      { chatId: -123, chatType: "supergroup", updateId: 9101 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    await handleTelegramWebhook(db, makeCallbackRequest("select:1:2222222222222222",
      { chatId: -123, chatType: "supergroup", updateId: 9102 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT stablecoin_id, alert_dews FROM telegram_subscriptions").all()).toEqual([
      { stablecoin_id: freshCoin.id, alert_dews: 1 },
    ]);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("getChatMember"))).toBe(true);
    const after = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
    await handleTelegramWebhook(db, makeCallbackRequest("select:1:2222222222222222",
      { chatId: -123, chatType: "supergroup", updateId: 9102 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(after);
  });

  it("rejects unbound legacy keyboards without reading or changing a current pending flow", async () => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews all"), "test-secret", "bot-token");
    const before = sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all();
    for (const data of ["confirm:bulk", "cancel:bulk", "confirm:forget", "cancel:forget", "select:1", "setup:confirm"]) {
      await handleTelegramWebhook(db, makeCallbackRequest(data), "test-secret", "bot-token");
      expect(fixtureTelegramApiCallBody<{ text: string }>(fetchSpy, "answerCallbackQuery").text).toMatch(/re-run|begin again/i);
      expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual(before);
      expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    }
  });

  it("emits bounded identities from every pending keyboard producer, including long ids and the largest current selection index", async () => {
    const { db } = fixtures.open();
    let now = 1_800_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    const command = async (text: string) => {
      now += 31;
      await handleTelegramWebhook(db, makeWebhookRequest(123, text), "test-secret", "bot-token");
      expectBoundCallbacks();
    };
    const tap = async (prefix: string) => {
      await handleTelegramWebhook(db, makeCallbackRequest(callbackFromLatest(prefix)), "test-secret", "bot-token");
      expectBoundCallbacks();
    };
    const longest = TELEGRAM_SUBSCRIBABLE_STABLECOINS.reduce((left, right) => left.id.length >= right.id.length ? left : right);
    const bulkIds = [longest.id, ...TELEGRAM_SUBSCRIBABLE_STABLECOINS.filter((coin) => coin.id !== longest.id).slice(0, 10).map((coin) => coin.id)].join(" ");
    await command(`/subscribe dews ${bulkIds}`);
    expect(callbackFromLatest("confirm:")).toMatch(/^confirm:bulk:/);
    await command(`/unsubscribe ${bulkIds}`);
    await command("/subscribe dews all");
    await command("/unsubscribe all");
    await command("/forget");
    expect(callbackFromLatest("confirm:")).toMatch(/^confirm:forget:/);
    await command("/cancel");
    const ambiguous = TELEGRAM_SUBSCRIBABLE_STABLECOINS.map((coin) => resolveTicker(coin.symbol))
      .flatMap((match) => match.status === "ambiguous" && match.matches.length <= 5 ? [match] : [])
      .sort((left, right) => right.matches.length - left.matches.length)[0];
    if (!ambiguous || ambiguous.status !== "ambiguous") throw new Error("Missing keyboard-eligible ticker fixture");
    await command(`/subscribe dews ${ambiguous.matches[0].symbol}`);
    const selections = inlineButtons(latestSendMessageBody()).flatMap((button) => button.callback_data ? [button.callback_data] : []);
    expect(selections[selections.length - 1].split(":")).toEqual([
      "select", String(ambiguous.matches.length), expect.stringMatching(/^[a-f0-9]{16}$/),
    ]);
    await command("/start");
    await tap("setup:branch:custom:");
    await tap("setup:type-toggle:safety:");
    await tap("setup:next:");
    await tap("setup:target:type:");
    await command(longest.id);
    expect(callbackFromLatest("setup:confirm:")).toMatch(/:[a-f0-9]{16}$/);
    expectBoundCallbacks();
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
    // P2-13 CRON-14 makes DEWS exact/legacy read failures degrade instead of throwing; fail an uncaught dependency.
    const db = makeTelegramWebhookDb([{ match: "FROM depeg_events", rows: [], throwError: new Error("status read failed") }]);

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

  it("confirm:bulk callback executes a deferred /unsubscribe all", async () => {
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makeBulkPendingRow({
        kind: "unsubscribe",
        presetIds: [],
        coinIds: [],
        unsubscribeAll: true,
      }, { expires_at: Math.floor(Date.now() / 1000) + 60, initiator_user_id: "999" })),
    ]);

    const request = makeCallbackRequest("confirm:bulk:0123456789abcdef");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("cancel:bulk callback clears pending without executing", async () => {
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makeBulkPendingRow({
        kind: "unsubscribe",
        presetIds: [],
        coinIds: [],
        unsubscribeAll: true,
      }, { expires_at: Math.floor(Date.now() / 1000) + 60, initiator_user_id: "999" })),
    ]);

    const request = makeCallbackRequest("cancel:bulk:0123456789abcdef");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("pending confirm-bulk ignores plain text replies in private chats with a reminder", async () => {
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makeBulkPendingRow({
        kind: "subscribe",
        alertTypes: ["dews"],
        presetIds: [],
        coinIds: [],
        subscribeAll: true,
      }, { expires_at: Math.floor(Date.now() / 1000) + 60, initiator_user_id: "999" })),
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1,2,3"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => /UPDATE.*global_alert_/.test(entry.sql))).toBe(false);
    expect(sentMessageBody().text).toContain("Tap Confirm or Cancel");
  });

  it("pending forget-confirm ignores plain text replies in private chats with a reminder", async () => {
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable({
        action_type: "forget-confirm",
        action_payload: "{}",
        alert_types: JSON.stringify([]),
        resolved_ids: JSON.stringify([]),
        ambiguous_ticker: "",
        candidates: JSON.stringify([]),
        remaining_tickers: JSON.stringify([]),
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      }),
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "delete this"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
    expect(sentMessageBody().text).toContain("Tap Confirm or Cancel");
  });
});
