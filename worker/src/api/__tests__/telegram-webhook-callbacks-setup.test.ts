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
await import("../../lib/telegram-alerts");

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





beforeEach(() => {
  resetTelegramFetchSpy();
  // mockRejectedValueOnce expires after a single call so subsequent tests reuse
  // the original sendAuditedTelegramReply impl bound at vi.mock construction.
  vi.mocked(sendAuditedTelegramReply).mockClear();
});

describe("handleCallbackQuery", () => {
  describe("setup wizard", () => {
    it("setup:branch:recommended writes confirm-state and previews usd-top25", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "branch", alertTypes: [], target: null }),
        },
        {
          match: "FROM cache WHERE key = ?",
          matchBinds: ["stablecoins"],
          rows: [],
          first: { value: makeCacheStablecoins(), updated_at: 1_700_000_000 },
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-rec",
        data: "setup:branch:recommended",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42 }, message_id: 1 },
      });

      const history = db.getHistory();
      const persist = history.filter(
        (h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation") && h.binds.includes("setup-step"),
      );
      expect(persist.length).toBeGreaterThan(0);
      const lastPersistPayload = String(persist[persist.length - 1].binds[2] ?? "{}");
      expect(lastPersistPayload).toContain('"step":"confirm-recommended"');
      expect(lastPersistPayload).toContain("usd-top25");
      const body = lastSentMessageBody();
      expect(body.text).toContain("DEWS and Depeg alerts");
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("setup:confirm");
      expect(callbacks).toContain("setup:cancel");
    });

    it("setup:branch:custom shows the alert-type toggle keyboard", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "branch", alertTypes: [], target: null }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-custom",
        data: "setup:branch:custom",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const body = lastSentMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("setup:type-toggle:dews");
      expect(callbacks).toContain("setup:type-toggle:depeg");
      expect(callbacks).toContain("setup:type-toggle:safety");
      expect(callbacks).toContain("setup:type-toggle:launch");
      expect(callbacks).toContain("setup:next");
      expect(callbacks).toContain("setup:cancel");
    });

    it("setup:branch:skip clears state and sends the legacy /start message", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "branch", alertTypes: [], target: null }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-skip",
        data: "setup:branch:skip",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const history = db.getHistory();
      expect(history.some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      const body = lastSentMessageBody();
      expect(body.text).toContain("/subscribe dews,depeg usd-top25");
    });

    it("setup:branch:skip lets group non-admins exit their own wizard without an admin lookup", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "branch", alertTypes: [], target: null }, { initiator_user_id: "7" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-skip-group",
        data: "setup:branch:skip",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
      });

      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
      expect(db.getHistory().some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      expect(lastSentMessageBody().text).toContain("Command reference");
      expect(lastAckBody().text).toBe("OK.");
    });

    it("setup:type-toggle:safety flips selection", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({
            step: "custom-types",
            alertTypes: ["dews", "depeg"],
            target: null,
          }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-toggle",
        data: "setup:type-toggle:safety",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const persist = db.getHistory().filter((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"));
      const payload = String(persist[persist.length - 1].binds[2] ?? "");
      expect(payload).toContain('"safety"');
    });

    it("setup:next refuses when no alert types are selected", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "custom-types", alertTypes: [], target: null }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-next-empty",
        data: "setup:next",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      // No sendMessage on this path — only an ack with a hint.
      expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("sendMessage")).length).toBe(0);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toContain("at least one");
    });

    it("setup:next on custom-types step shows the target picker", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({
            step: "custom-types",
            alertTypes: ["dews"],
            target: null,
          }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-next",
        data: "setup:next",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const body = lastSentMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("setup:target:usd-top25");
      expect(callbacks).toContain("setup:target:all");
      expect(callbacks).toContain("setup:target:type");
    });

    it("setup:target:usd-top10 advances to confirm-custom with preview", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({
            step: "custom-target",
            alertTypes: ["dews", "safety"],
            target: null,
          }),
        },
        {
          match: "FROM cache WHERE key = ?",
          matchBinds: ["stablecoins"],
          rows: [],
          first: { value: makeCacheStablecoins(), updated_at: 1_700_000_000 },
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-target",
        data: "setup:target:usd-top10",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const persist = db.getHistory().filter((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"));
      const payload = String(persist[persist.length - 1].binds[2] ?? "");
      expect(payload).toContain('"step":"confirm-custom"');
      expect(payload).toContain("usd-top10");
      const body = lastSentMessageBody();
      expect(body.text).toContain("DEWS, Safety");
    });

    it("setup:confirm on recommended path writes preset provenance without direct coin rows", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({
            step: "confirm-recommended",
            alertTypes: ["dews", "depeg"],
            target: { kind: "preset", presetId: "usd-top25" },
          }),
        },
        {
          match: "FROM cache WHERE key = ?",
          matchBinds: ["stablecoins"],
          rows: [],
          first: { value: makeCacheStablecoins(), updated_at: 1_700_000_000 },
        },
        { match: "FROM telegram_subscriptions", rows: [] },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-confirm",
        data: "setup:confirm",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42 } },
      });

      const history = db.getHistory();
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_subscribers"))).toBe(true);
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_preset_subscriptions"))).toBe(true);
      expect(history.some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    });

    it("setup:confirm with target=all writes only global alert flags", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({
            step: "confirm-custom",
            alertTypes: ["dews"],
            target: { kind: "all" },
          }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-confirm-all",
        data: "setup:confirm",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42 } },
      });

      const history = db.getHistory();
      const subscriberUpsert = history.find(
        (h) => h.sql.includes("INSERT INTO telegram_subscribers") && /global_alert_dews\s*=\s*MAX/.test(h.sql),
      );
      expect(subscriberUpsert).toBeDefined();
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    });

    it("setup:cancel clears the pending row and sends a cancellation message", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "custom-types", alertTypes: ["dews"], target: null }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-cancel",
        data: "setup:cancel",
        from: { id: 999 },
        message: { chat: { id: 42 } },
      });

      const history = db.getHistory();
      expect(history.some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      expect(lastSentMessageBody().text).toContain("Setup cancelled");
    });

    it("setup:cancel lets group non-admins cancel their own wizard without an admin lookup", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup(
            { step: "custom-types", alertTypes: ["dews"], target: null },
            { initiator_user_id: "7" },
          ),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-cancel-group",
        data: "setup:cancel",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
      });

      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
      expect(db.getHistory().some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      expect(lastSentMessageBody().text).toContain("Setup cancelled");
      expect(lastAckBody().text).toBe("Cancelled.");
    });

    it("setup:cancel does not clear unrelated pending rows when no active wizard exists", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ action_type: "confirm-bulk", initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-cancel-unrelated",
        data: "setup:cancel",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
      });

      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
      expect(db.getHistory().some((h) => h.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("sendMessage"))).toBe(false);
      expect(lastAckBody().text).toBe("Setup expired. Send /start to begin again.");
    });

    it("setup:branch:recommended from a non-initiator user is refused", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup({ step: "branch", alertTypes: [], target: null }, { initiator_user_id: "111" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-other",
        data: "setup:branch:recommended",
        from: { id: 222 },
        message: { chat: { id: 42, type: "private" } },
      });

      // Should not have invoked the preset cache lookup or persisted any new state.
      const history = db.getHistory();
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toContain("Only the user who started");
    });
  });

});
