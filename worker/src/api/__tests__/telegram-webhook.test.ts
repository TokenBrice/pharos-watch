import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { handleTelegramWebhook } = await import("../telegram-webhook");
const { resolveTicker } = await import("../../lib/telegram-alerts");

function makeWebhookRequest(chatId: number, text: string, secret = "test-secret"): Request {
  return new Request(`https://x/api/telegram-webhook?secret=${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        chat: { id: chatId, username: "testuser" },
        text,
      },
    }),
  });
}

function sentMessageBody(callIndex = 0): { text: string } {
  const [, init] = fetchSpy.mock.calls[callIndex] ?? [];
  if (!init?.body || typeof init.body !== "string") {
    throw new Error("Expected sendToChat to call fetch with a string JSON body");
  }
  return JSON.parse(init.body) as { text: string };
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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Welcome");
  });

  it("replies to /help", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Commands");
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

  it("handles /subscribe for all stablecoins by alert type", async () => {
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
          global_alert_safety: 1,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews safety all"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("global_alert_dews"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(sentMessageBody().text).toContain("All stablecoins: DEWS, Safety");
  });

  it("handles /subscribe with unknown ticker", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews XYZZY"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Ticker");
    expect(text.toLowerCase()).toContain("not found");
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
    expect(text).toContain("All stablecoins: Depeg, Safety");
    expect(text).toContain("Coins (0):");
  });

  it("handles /mute quiet hours", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/mute 22-07"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Quiet hours enabled");
    expect(text).toContain("22-07");
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

  it("handles /unsubscribe all", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all"), "test-secret", "bot-token");

    const text = sentMessageBody().text.toLowerCase();
    expect(text).toContain("removed all subscriptions");
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
    expect(sentMessageBody().text).toContain("Pending selection cleared");
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
});
