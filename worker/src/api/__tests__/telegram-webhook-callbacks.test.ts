import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// Stub the insights module so /why callback tests do not need to drive the
// full report-cards snapshot pipeline. Coverage callback uses buildCoverageMessage
// which only reads StatusForCoin data, so it does not need stubbing.
vi.mock("../telegram-webhook-insights", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    buildWhyMessage: vi.fn(async (_db: unknown, stablecoinId: string) =>
      `<b>${stablecoinId} Safety Score</b>\nOverall: A`,
    ),
  };
});

const { handleCallbackQuery } = await import("../telegram-webhook-callbacks");

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

  describe("P1-U11 discoverability callbacks", () => {
    it("why:<id> sends the safety Why explainer and acks", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-why",
        data: "why:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("sendMessage"));
      expect(sendCall).toBeDefined();
      const sendBody = JSON.parse((sendCall?.[1] as RequestInit).body as string);
      expect(sendBody.text).toContain("usdc-circle Safety Score");
      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(ackCall).toBeDefined();
      const ackBody = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(ackBody.text).toBe("Why sent.");
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

      const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("sendMessage"));
      expect(sendCall).toBeDefined();
      const body = JSON.parse((sendCall?.[1] as RequestInit).body as string);
      expect(body.text).toContain("USDC coverage");
      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ackCall?.[1] as RequestInit).body as string).text).toBe("Coverage sent.");
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it("quicksub:<id> in private chat enables DEWS+depeg for one coin", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-qs",
        data: "quicksub:usdc-circle",
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      const subscriberUpsert = history.find((h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql),
      );
      expect(subscriberUpsert).toBeDefined();
      // Per-coin alert bumps for dews + depeg are set to 1.
      expect(subscriberUpsert!.binds[2]).toBe(1); // alert_dews
      expect(subscriberUpsert!.binds[3]).toBe(1); // alert_depeg
      expect(subscriberUpsert!.binds[4]).toBe(0); // alert_safety
      expect(subscriberUpsert!.binds[5]).toBe(0); // alert_launch

      const subscriptionInsert = history.find((h) =>
        /INSERT INTO telegram_subscriptions/.test(h.sql),
      );
      expect(subscriptionInsert).toBeDefined();
      expect(subscriptionInsert!.binds[1]).toBe("usdc-circle");
      expect(subscriptionInsert!.binds[2]).toBe(1); // alert_dews
      expect(subscriptionInsert!.binds[3]).toBe(1); // alert_depeg

      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Subscribed/i);
    });

    it("quicksub:<id> in a group refuses non-admin without writing to D1", async () => {
      const db = mockD1([
        {
          match: "FROM cache WHERE key = ?",
          rows: [],
          first: null,
        },
      ]);
      // getCachedChatMember fetches getChatMember from Telegram when cache misses.
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
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
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
      const subscriberUpsert = history.find((h) =>
        /INSERT INTO telegram_subscribers/.test(h.sql),
      );
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
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toBe("Action not recognized.");
    });
  });

  describe("watchlist manage (P1-U8)", () => {
    function makeSubRow(stablecoinId: string) {
      return {
        stablecoin_id: stablecoinId,
        alert_dews: 1,
        alert_depeg: 0,
        alert_safety: 0,
        alert_launch: 0,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: null,
      };
    }

    function editMessageBody(): { text: string; reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } } {
      const editCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("editMessageText"));
      if (!editCall) throw new Error("No editMessageText call recorded");
      return JSON.parse(((editCall[1] as RequestInit).body as string) ?? "{}");
    }

    it("manage:page:0 edits the message with the first page of unsub buttons", async () => {
      const subs = [makeSubRow("usdc-circle"), makeSubRow("dai-makerdao")];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: subs }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-0",
        data: "manage:page:0",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      expect(body.text).toContain("Manage watchlist");
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("unsub:usdc-circle");
      expect(callbacks).toContain("unsub:dai-makerdao");
      // No mutations on a pure page render.
      expect(db.getHistory().some((h) => /\bDELETE\b|\bINSERT\b/i.test(h.sql))).toBe(false);
    });

    it("manage:page:1 paginates beyond the first 5 entries", async () => {
      const ids = [
        "usdc-circle",
        "usdt-tether",
        "dai-makerdao",
        "frax-frax",
        "tusd-trueusd",
        "lusd-liquity",
        "susd-synthetix",
      ];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: ids.map(makeSubRow) }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-1",
        data: "manage:page:1",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      // Page 1 of 2 should expose a Prev button back to page 0.
      expect(callbacks).toContain("manage:page:0");
      // Exactly two rows fit on the second page given 5/page.
      const unsubCount = callbacks.filter((c) => c?.startsWith("unsub:")).length;
      expect(unsubCount).toBe(2);
    });

    it("unsub:<id> deletes the subscription and re-renders the same page", async () => {
      // First call (DELETE batch). Second SELECT after delete returns the remaining row.
      const remaining = [makeSubRow("dai-makerdao")];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const history = db.getHistory();
      const deleteRow = history.find((h) => /DELETE FROM telegram_subscriptions/.test(h.sql));
      expect(deleteRow).toBeDefined();
      expect(deleteRow!.binds).toContain("usdc-circle");

      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Removed USDC/);

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("unsub:dai-makerdao");
      expect(callbacks).not.toContain("unsub:usdc-circle");
    });

    it("unsub:<id> in a group refuses non-admin without deleting", async () => {
      const db = mockD1([
        { match: "FROM cache WHERE key = ?", rows: [], first: null },
        { match: "FROM telegram_subscriptions", rows: [] },
      ]);
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
        id: "cb-unsub-group",
        data: "unsub:usdc-circle",
        from: { id: 7, username: "tapping_user" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 100 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /DELETE FROM telegram_subscriptions/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/);
    });

    it("unsub:<id> shifts to the previous page when the current page becomes empty", async () => {
      // After the delete the chat has 5 remaining subs -> only page 0 remains.
      const remaining = [
        makeSubRow("usdc-circle"),
        makeSubRow("usdt-tether"),
        makeSubRow("dai-makerdao"),
        makeSubRow("frax-frax"),
        makeSubRow("tusd-trueusd"),
      ];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      // The tapped message came from page 1 — its keyboard included `manage:page:0` Prev.
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-shift",
        data: "unsub:lusd-liquity",
        from: { id: 1, username: "alice" },
        message: {
          chat: { id: 42, type: "private" },
          message_id: 100,
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ LUSD", callback_data: "unsub:lusd-liquity" }],
              [{ text: "◀ Prev", callback_data: "manage:page:0" }],
            ],
          },
        } as unknown as Parameters<typeof handleCallbackQuery>[2]["message"],
      });

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      // After deletion only 5 coins remain — a single page — so no nav row.
      expect(callbacks.filter((c) => c?.startsWith("unsub:"))).toHaveLength(5);
      expect(callbacks.some((c) => c?.startsWith("manage:page:"))).toBe(false);
    });
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
  describe("settings dispatch", () => {
    it("settings:home routes to the settings handler and edits the message", async () => {
      const db = mockD1([
        { match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-settings",
        data: "settings:home",
        from: { id: 1 },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      // editMessageText was called, not sendMessage.
      const edits = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("editMessageText"),
      );
      expect(edits.length).toBe(1);
    });

    it("settings:c:<id>:db:A writes the alert_dews flag", async () => {
      const db = mockD1([
        { match: "FROM telegram_subscriptions", rows: [] },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coin",
        data: "settings:c:usdc-circle:db:A",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const history = db.getHistory();
      const insert = history.find(
        (h) =>
          /INSERT INTO telegram_subscriptions/.test(h.sql) &&
          /dews_min_band = excluded\.dews_min_band/.test(h.sql),
      );
      expect(insert).toBeDefined();
      expect(insert!.binds[2]).toBe(1); // alert_dews
      expect(insert!.binds[3]).toBe("ALERT");
    });
  });
});
