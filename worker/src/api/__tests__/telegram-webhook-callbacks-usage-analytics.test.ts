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
  describe("P1.17 mutating callbacks emit usage analytics", () => {
    it("depegstep:<id>:250 success records a subscribe usage event", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-depegstep-ok",
        data: "depegstep:usdc-circle:250",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      const subscriptionUpsert = history.find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.sql.includes("depeg_worsening_bps_step"),
      );
      expect(subscriptionUpsert).toBeDefined();
      expect(subscriptionUpsert!.binds).toEqual(["42", "usdc-circle", 250]);
      expect(subscriptionUpsert!.sql).toContain("alert_depeg = 1");
      expect(subscriptionUpsert!.sql).toContain("depeg_worsening_bps_step = excluded.depeg_worsening_bps_step");
      expect(
        history.some(
          (entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.sql.includes("alert_depeg = MAX"),
        ),
      ).toBe(true);

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("depegstep"),
        );
      expect(usageRows).toHaveLength(1);
      // eventType=subscribe, actionDetail=depegstep, outcome=success
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("depegstep");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("safetydown:<id> success records a subscribe usage event", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-safetydown-ok",
        data: "safetydown:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      const subscriptionUpsert = history.find(
        (entry) => entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.sql.includes("safety_mode"),
      );
      expect(subscriptionUpsert).toBeDefined();
      expect(subscriptionUpsert!.binds).toEqual(["42", "usdc-circle", 1, "downgrade-only"]);
      expect(subscriptionUpsert!.sql).toContain("alert_safety = excluded.alert_safety");
      expect(subscriptionUpsert!.sql).toContain("safety_mode = excluded.safety_mode");
      expect(
        history.some(
          (entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.sql.includes("alert_safety = MAX"),
        ),
      ).toBe(true);

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("safetydown"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("safetydown");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("unsub:<id> success records an unsubscribe usage event", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-ok",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("unsubscribe") &&
            entry.binds.includes("callback_unsub"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("unsubscribe");
      expect(usageRows[0].binds[3]).toBe("callback_unsub");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("depegstep:<id>:250 D1 failure records a failure usage event", async () => {
      const db = mockD1([
        {
          match: "INSERT INTO telegram_subscriptions",
          rows: [],
          throwError: new Error("d1 boom"),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-depegstep-fail",
        data: "depegstep:usdc-circle:250",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("depegstep") &&
            entry.binds.includes("failure"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("depegstep");
      expect(usageRows[0].binds[4]).toBe("failure");
      expect(usageRows[0].binds[6]).toBe("d1_write_failed");
    });
  });

});

