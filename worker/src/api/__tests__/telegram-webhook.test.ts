import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { handleTelegramWebhook } = await import("../telegram-webhook");
const { resolveTicker } = await import("../../lib/telegram-alerts");
const { FROZEN_STABLECOINS } = await import("@shared/lib/stablecoins");

function makeWebhookRequest(
  chatId: number,
  text: string,
  secret = "test-secret",
  options: { chatType?: string; fromId?: number; fromUsername?: string } = {},
): Request {
  return new Request(`https://x/api/telegram-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({
      message: {
        chat: { id: chatId, username: "testuser", type: options.chatType ?? "private" },
        from: { id: options.fromId ?? 999, username: options.fromUsername ?? "requester" },
        text,
      },
    }),
  });
}

function sentMessageBody(callIndex = 0): { text: string; reply_markup?: unknown } {
  const [, init] = fetchSpy.mock.calls[callIndex] ?? [];
  if (!init?.body || typeof init.body !== "string") {
    throw new Error("Expected sendToChat to call fetch with a string JSON body");
  }
  return JSON.parse(init.body) as { text: string; reply_markup?: unknown };
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
  });

  it("returns 200 for invalid secret", async () => {
    const db = mockD1([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start", "wrong-secret"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(sentMessageBody().text).toContain("Commands");
    expect(sentMessageBody().text).toContain("/presets");
  });

  it("/settings sends the chat-level settings keyboard", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/settings"),
      "test-secret",
      "bot-token",
    );

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
      db.getHistory().some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_pending_disambiguation") &&
          entry.binds.includes("setup-step"),
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
    const sendCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("sendMessage"));
    const body = JSON.parse((sendCall?.[1] as RequestInit).body as string) as { text: string };
    expect(body.text).toContain("Quick start");
    expect(body.text).not.toContain("Pick a path below");
    expect(
      db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation")),
    ).toBe(false);
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
    const confirmInsert = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
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
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(false);
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

  it("handles direct /top usage without touching D1", async () => {
    const db = mockD1([]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/top"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toBe("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    expect(db.getHistory()).toHaveLength(1);
    expect(db.getHistory()[0]?.sql).toContain("FROM telegram_pending_disambiguation");
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
    expect(payload).toContain("\"step\":\"confirm-custom\"");
    expect(payload).toContain("\"kind\":\"ticker\"");
    expect(payload).toContain("USDC");
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

    expect(sentMessageBody().text).toContain("No active subscriptions");
    expect(sentMessageBody().text).toContain("/presets");
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

    const body = sentMessageBody() as { text: string; reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } };
    const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(callbacks).toContain("manage:page:0");
  });

  it("omits the [Manage] button when /list has no explicit coin subscriptions", async () => {
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

    const body = sentMessageBody() as { text: string; reply_markup?: unknown };
    expect(body.reply_markup).toBeUndefined();
  });

  it("replies to /presets with the preset catalog", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/presets"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Preset Watchlists");
    expect(text).toContain("usd-top25");
    expect(text).toContain("mcap-ge-1b");
  });

  it("replies unknown command", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/foo"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Unknown command");
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
          entry.sql.includes("INSERT INTO telegram_subscriptions") &&
          entry.binds[1] === launchTarget.matches[0].id,
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
    const confirmInsert = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.text).toMatch(/subscribe \d+ coins/);
    expect(body.reply_markup).toBeDefined();
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
    const confirmInsert = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
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
    const confirmInsert = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
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
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews all usd-top25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain('Use either &quot;all&quot; or specific tickers/presets');
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
    expect(sentMessageBody().text).toContain("matches");
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

    expect(sentMessageBody().text).toContain("Updated settings");
    expect(sentMessageBody().text).toContain("DEWS&gt;=WARNING");
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
    expect(sentMessageBody().text).toContain("Updated all-stablecoin alerts");
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

  it("/timezone <zone> persists a valid IANA zone", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone Europe/Paris"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);

    const upsert = db.getHistory().find((h) =>
      /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Europe/Paris"),
    );
    expect(upsert).toBeDefined();
    expect(sentMessageBody().text).toContain("Timezone set to Europe/Paris");
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
    const wrote = db.getHistory().some((h) =>
      /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Mars/Olympus_Mons"),
    );
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
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(sent.text).toContain("Current timezone: Europe/Paris");
    const flat = (sent.reply_markup?.inline_keyboard ?? []).flat();
    expect(flat.some((btn) => btn.callback_data === "tz:UTC")).toBe(true);
    expect(flat.some((btn) => btn.callback_data === "tz:Europe/Paris")).toBe(true);
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
      history.filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions")).map((entry) => entry.binds[1]),
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
    const confirmInsert = history.find((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
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
    expect(
      history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation")),
    ).toBe(true);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("allows legacy frozen coin subscriptions to be removed by exact id", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) {
      throw new Error("Expected at least one frozen stablecoin fixture");
    }

    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, `/unsubscribe ${frozen.id}`),
      "test-secret",
      "bot-token",
    );

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
    expect(sentMessageBody().text).toContain("matches");
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

    const request = new Request("https://x/api/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        callback_query: {
          id: "cb1",
          data: "confirm:bulk",
          from: { id: 999, username: "requester" },
          message: { chat: { id: 123, type: "private" }, message_id: 1 },
        },
      }),
    });
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    const updateSql = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("alert_launch = 0");
    expect(updateSql!.sql).toContain("global_alert_launch = 0");
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
    const db = mockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(42, "/mute 22-07"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    const subscriberUpsert = db.getHistory().find((h) =>
      /INSERT INTO telegram_subscribers/.test(h.sql) && /ON CONFLICT\(chat_id\)/.test(h.sql),
    );
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
      { match: "FROM stress_signals", rows: [
        { band: "CALM", score: 15, computed_at: 1700000000 },
      ] },
      { match: "FROM safety_grade_history", rows: [
        { grade: "A", score: 85, recorded_at: 1700000000 },
      ] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [
        { price: 0.9999, updated_at: 1700000000 },
      ] },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/status USDC"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(sent.text).toContain("USDC");
    expect(sent.text).toContain("CALM");
    expect(sent.text).toContain("Safety: A");
    expect(sent.text).toContain("Depeg: stable");
    expect(sent.text).toContain("Price: $0.9999");
    // P1-U11: discoverability buttons attached to the status card.
    const buttons = (sent.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.map((b) => b.text)).toEqual(["Why?", "Coverage", "Subscribe"]);
    expect(buttons.map((b) => b.callback_data)).toEqual([
      "why:usdc-circle",
      "coverage:usdc-circle",
      "quicksub:usdc-circle",
    ]);
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
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/status USDF"),
      "test-secret",
      "bot-token",
    );

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

    const request = new Request("https://x/api/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        callback_query: {
          id: "cb1",
          data: "confirm:bulk",
          from: { id: 999, username: "requester" },
          message: { chat: { id: 123, type: "private" }, message_id: 1 },
        },
      }),
    });
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

    const request = new Request("https://x/api/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        callback_query: {
          id: "cb1",
          data: "cancel:bulk",
          from: { id: 999, username: "requester" },
          message: { chat: { id: 123, type: "private" }, message_id: 1 },
        },
      }),
    });
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
});
