import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 as baseMockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  createTelegramFetchSpy,
  lastSendMessageBody,
  telegramApiCallBody,
} from "../../test-helpers/__shared/telegram";

// Stub the insights module so /why callback tests do not need to drive the
// full report-cards snapshot pipeline. Coverage callback uses buildCoverageMessage
// which only reads StatusForCoin data, so it does not need stubbing.
vi.mock("../telegram-webhook-insights", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    buildWhyMessage: vi.fn(
      async (_db: unknown, stablecoinId: string) => `<b>${stablecoinId} Safety Score</b>\nOverall: A`,
    ),
  };
});

// Indirect spy on sendAuditedTelegramReply so individual P1.16 tests can force
// the reply to throw and assert the answer-callback still fires. The default
// implementation defers to the real send path so all other tests keep working.
vi.mock("../telegram-webhook-replies", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    sendAuditedTelegramReply: vi.fn(original.sendAuditedTelegramReply as (...args: unknown[]) => Promise<void>),
  };
});

const { handleCallbackQuery } = await import("../telegram-webhook-callbacks");
const { sendAuditedTelegramReply } = await import("../telegram-webhook-replies");
const { resolveTicker } = await import("../../lib/telegram-alerts");

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM cache", rows: [], first: null },
    { match: "FROM price_cache", rows: [], first: null },
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "FROM stress_signals", rows: [], first: null },
    { match: "FROM stress_signal_publication_rows", rows: [], first: null },
    { match: "FROM safety_grade_history", rows: [], first: null },
    { match: "FROM depeg_events", rows: [], first: null },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "UPDATE telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_recap_targets", rows: [] },
    { match: "UPDATE telegram_recap_preferences", rows: [] },
    { match: "UPDATE telegram_recap_targets", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    { match: "DELETE FROM telegram_freeze_alert_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_source_resolution_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plan_items", rows: [] },
    { match: "DELETE FROM telegram_alert_job_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_job_target_items", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plans", rows: [] },
    { match: "DELETE FROM telegram_alert_planning_subscribers", rows: [] },
    { match: "DELETE FROM telegram_transport_failure_observations", rows: [] },
    { match: "DELETE FROM telegram_alert_dead_letters", rows: [] },
    { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
  ], options);
}

function lastSentMessageBody(): {
  text: string;
  reply_markup?: {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
  };
} {
  return lastSendMessageBody(fetchSpy);
}

function firstSentMessageBody(): {
  text: string;
  reply_markup?: {
    inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
  };
} {
  return telegramApiCallBody(fetchSpy, "sendMessage", { last: false });
}

function pendingRowFromSetup(
  payload: {
    step: string;
    alertTypes?: string[];
    target?: unknown;
  },
  options: { initiator_user_id?: string | null } = {},
): Record<string, unknown> {
  return {
    action_type: "setup-step",
    action_payload: JSON.stringify(payload),
    expires_at: Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: options.initiator_user_id ?? null,
  };
}

function pendingRowFromForget(
  options: {
    initiator_user_id?: string | null;
    expires_at?: number;
    action_type?: string;
  } = {},
): Record<string, unknown> {
  return {
    action_type: options.action_type ?? "forget-confirm",
    action_payload: "{}",
    alert_types: JSON.stringify([]),
    resolved_ids: JSON.stringify([]),
    ambiguous_ticker: "",
    candidates: JSON.stringify([]),
    remaining_tickers: JSON.stringify([]),
    expires_at: options.expires_at ?? Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: options.initiator_user_id ?? null,
  };
}

function makeCacheStablecoins(): string {
  return JSON.stringify({
    peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", circulating: { usd: 100_000_000_000 } },
      { id: "usdc-circle", symbol: "USDC", circulating: { usd: 90_000_000_000 } },
      { id: "dai-makerdao", symbol: "DAI", circulating: { usd: 5_000_000_000 } },
    ],
  });
}

function lastAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery");
}

function firstAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery", { last: false });
}

function lastEditedMessageBody(): { text: string; reply_markup?: unknown } {
  return telegramApiCallBody(fetchSpy, "editMessageText");
}

beforeEach(() => {
  resetTelegramFetchSpy();
  // mockRejectedValueOnce expires after a single call so subsequent tests reuse
  // the original sendAuditedTelegramReply impl bound at vi.mock construction.
  vi.mocked(sendAuditedTelegramReply).mockClear();
});

describe("handleCallbackQuery", () => {
  describe("P1-U11 discoverability callbacks", () => {
    it("why:<id> sends the safety Why explainer and acks", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-why",
        data: "why:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const sendBody = firstSentMessageBody();
      expect(sendBody.text).toContain("usdc-circle Safety Score");
      const whyButtons = (sendBody.reply_markup?.inline_keyboard ?? []).flat();
      expect(
        whyButtons.some(
          (button: { text?: string; web_app?: { url?: string } }) =>
            button.text === "Open in app" && button.web_app?.url?.includes("startapp=why_usdc-circle"),
        ),
      ).toBe(true);
      expect(firstAckBody().text).toBe("Why sent.");
      // No subscriber mutations on read-only Why.
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it("coverage:<id> sends a coverage card with no subscription writes", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-cov",
        data: "coverage:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const body = firstSentMessageBody();
      expect(body.text).toContain("USDC coverage");
      const coverageButtons = (body.reply_markup?.inline_keyboard ?? []).flat();
      expect(
        coverageButtons.some(
          (button: { text?: string; web_app?: { url?: string } }) =>
            button.text === "Open in app" && button.web_app?.url?.includes("startapp=coverage_usdc-circle"),
        ),
      ).toBe(true);
      expect(firstAckBody().text).toBe("Coverage sent.");
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it("why and coverage callbacks keep discovery buttons in group chats without mini-app buttons", async () => {
      const whyDb = mockD1([]);
      await handleCallbackQuery(whyDb, "fake-token", {
        id: "cb-why-group",
        data: "why:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: -42, type: "group" }, message_id: 1 },
      });
      const whyButtons = (firstSentMessageBody().reply_markup?.inline_keyboard ?? []).flat();
      expect(whyButtons).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "Why?", callback_data: "why:usdc-circle" }),
        expect.objectContaining({ text: "Coverage", callback_data: "coverage:usdc-circle" }),
        expect.objectContaining({ text: "Subscribe", callback_data: "quicksub:usdc-circle" }),
      ]));
      expect(whyButtons.some((button) => button.web_app)).toBe(false);

      const coverageDb = mockD1([]);
      await handleCallbackQuery(coverageDb, "fake-token", {
        id: "cb-cov-group",
        data: "coverage:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: -42, type: "group" }, message_id: 1 },
      });
      const coverageButtons = (lastSentMessageBody().reply_markup?.inline_keyboard ?? []).flat();
      expect(coverageButtons).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "Why?", callback_data: "why:usdc-circle" }),
        expect.objectContaining({ text: "Coverage", callback_data: "coverage:usdc-circle" }),
        expect.objectContaining({ text: "Subscribe", callback_data: "quicksub:usdc-circle" }),
      ]));
      expect(coverageButtons.some((button) => button.web_app)).toBe(false);
    });

    it("quicksub:<id> in a group refuses non-admin without writing to D1", async () => {
      const db = mockD1([
        {
          match: "FROM cache WHERE key = ?",
          rows: [],
          first: null,
        },
      ]);
      // Webhook auth fetches getChatMember from Telegram when cache misses.
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("getChatMember")) {
          return new Response(
            JSON.stringify({ ok: true, result: { user: { id: 7, is_bot: false, first_name: "m" }, status: "member" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-qs-group",
        data: "quicksub:usdc-circle",
        from: { id: 7, username: "tapping_user" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      expect(firstAckBody().text).toMatch(/Only group admins/i);
    });

    it("quicksub:<id> in a group with admin tapping writes the subscription", async () => {
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
              result: { user: { id: 7, is_bot: false, first_name: "admin" }, status: "administrator" },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-qs-admin",
        data: "quicksub:usdc-circle",
        from: { id: 7, username: "admin_user" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
      });

      const history = db.getHistory();
      const subscriberUpsert = history.find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(subscriberUpsert).toBeDefined();
      // Group chats must not persist the tapping admin's personal username.
      expect(subscriberUpsert!.binds[1]).toBeNull();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(true);
    });

    it("unknown stablecoin id in why/coverage/quicksub callbacks falls through to a graceful ack", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-bad",
        data: "quicksub:not-a-real-coin",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /\bINSERT\b/i.test(h.sql))).toBe(false);
      expect(firstAckBody().text).toBe("Action not recognized.");
    });

    it("status:<id> sends the current status card and acks", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-status-ok",
        data: "status:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const sendBody = lastSentMessageBody();
      expect(sendBody.text).toContain("USDC");
      expect(sendBody.reply_markup).toBeDefined();
      expect(lastAckBody().text).toBe("Status sent.");
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it.each([
      ["status", "Status sent."],
      ["why", "Why sent."],
      ["coverage", "Coverage sent."],
      ["quicksub", "Subscribed to DEWS + depeg for USDC."],
    ])("%s:<id> still acks when sendAuditedTelegramReply throws (P1.16)", async (action, acknowledgement) => {
      const db = mockD1([]);
      vi.mocked(sendAuditedTelegramReply).mockRejectedValueOnce(new Error("api fail"));
      await handleCallbackQuery(db, "fake-token", {
        id: `cb-${action}-fail`,
        data: `${action}:usdc-circle`,
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      }).catch(() => undefined);

      expect(firstAckBody().text).toBe(acknowledgement);
    });
  });

});

