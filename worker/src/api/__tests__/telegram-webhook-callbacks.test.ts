import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleCallbackQuery } from "../telegram-webhook-callbacks";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function lastSentMessageBody(): { text: string; reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } } {
  const sendCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("sendMessage"));
  const last = sendCalls[sendCalls.length - 1];
  if (!last) throw new Error("No sendMessage call recorded");
  return JSON.parse(((last[1] as RequestInit).body as string) ?? "{}");
}

function pendingRowFromSetup(payload: {
  step: string;
  alertTypes?: string[];
  target?: unknown;
}, options: { initiator_user_id?: string | null } = {}): Record<string, unknown> {
  return {
    action_type: "setup-step",
    action_payload: JSON.stringify(payload),
    expires_at: Math.floor(Date.now() / 1000) + 60,
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

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe("handleCallbackQuery", () => {
  it("snooze:1h stamps alert_snooze_until_ts ~1h in the future in a single INSERT", async () => {
    const before = Math.floor(Date.now() / 1000);
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb1",
      data: "snooze:1h",
      from: { username: "alice" },
      message: { chat: { id: 42 }, message_id: 999 },
    });

    // One INSERT ... ON CONFLICT with the snooze timestamp bound in position 3.
    const history = db.getHistory();
    const upsert = history.find(
      (h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql) &&
        /alert_snooze_until_ts = excluded\.alert_snooze_until_ts/.test(h.sql),
    );
    expect(upsert).toBeDefined();
    const until = Number(upsert!.binds[2]);
    expect(until).toBeGreaterThanOrEqual(before + 3599);
    expect(until).toBeLessThanOrEqual(before + 3700);

    // answerCallbackQuery should have been invoked.
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });

  it("does not overwrite group subscriber username with the callback actor username", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb1-group",
      data: "snooze:1h",
      from: { username: "tapping_user" },
      message: { chat: { id: -42, type: "supergroup" }, message_id: 999 },
    });

    const upsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.binds[1]).toBeNull();
  });

  it("unknown callback data returns a graceful ack", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb2",
      data: "garbage:whatever",
      message: { chat: { id: 42 }, message_id: 999 },
    });

    // No subscriber writes on unknown action.
    const history = db.getHistory();
    expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);

    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
    expect(body.text).toBe("Action not recognized.");
  });

  it("unknown action records zero INSERT or UPDATE calls on D1", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-unknown",
      data: "garbage:xyz",
      from: { username: "mallory" },
      message: { chat: { id: 42 }, message_id: 999 },
    });

    const history = db.getHistory();
    expect(history.some((h) => /\bINSERT\b/i.test(h.sql))).toBe(false);
    expect(history.some((h) => /\bUPDATE\b/i.test(h.sql))).toBe(false);
  });

  it("silently acks a callback with no chat id", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb3",
      data: "snooze:1h",
      message: {},
    });

    const history = db.getHistory();
    expect(history).toHaveLength(0);
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });

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
        (h) =>
          h.sql.includes("INSERT INTO telegram_pending_disambiguation") &&
          h.binds.includes("setup-step"),
      );
      expect(persist.length).toBeGreaterThan(0);
      const lastPersistPayload = String(persist[persist.length - 1].binds[2] ?? "{}");
      expect(lastPersistPayload).toContain("\"step\":\"confirm-recommended\"");
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

      const persist = db
        .getHistory()
        .filter((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"));
      const payload = String(persist[persist.length - 1].binds[2] ?? "");
      expect(payload).toContain("\"safety\"");
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

      const persist = db
        .getHistory()
        .filter((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"));
      const payload = String(persist[persist.length - 1].binds[2] ?? "");
      expect(payload).toContain("\"step\":\"confirm-custom\"");
      expect(payload).toContain("usd-top10");
      const body = lastSentMessageBody();
      expect(body.text).toContain("DEWS, Safety");
    });

    it("setup:confirm on recommended path writes preset + per-coin subscriptions", async () => {
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
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
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
        (h) =>
          h.sql.includes("INSERT INTO telegram_subscribers") &&
          /global_alert_dews\s*=\s*MAX/.test(h.sql),
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

    it("setup:branch:recommended from a non-initiator user is refused", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromSetup(
            { step: "branch", alertTypes: [], target: null },
            { initiator_user_id: "111" },
          ),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-other",
        data: "setup:branch:recommended",
        from: { id: 222 },
        message: { chat: { id: -42, type: "supergroup" } },
      });

      // Should not have invoked the preset cache lookup or persisted any new state.
      const history = db.getHistory();
      expect(history.some((h) => h.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toContain("Only the user who started");
    });
  });

  it("confirm:bulk rejects non-initiator with an alert toast and does not execute", async () => {
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
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-bulk",
      data: "confirm:bulk",
      from: { id: 7, username: "interloper" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(history.some((entry) => /UPDATE.*global_alert_/.test(entry.sql))).toBe(false);
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
    expect(body.text).toMatch(/only the user who started/i);
  });

  it("confirm:bulk replies with an expiry toast when pending TTL has elapsed", async () => {
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
          expires_at: Math.floor(Date.now() / 1000) - 1,
          initiator_user_id: "999",
        },
      },
    ]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-expired",
      data: "confirm:bulk",
      from: { id: 999, username: "requester" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
    expect(body.text).toMatch(/expired/i);
  });
});
