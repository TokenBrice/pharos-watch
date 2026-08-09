import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
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
  it("finalizes pending disambiguation from a select callback", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for callback disambiguation flow test");
    }

    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"], presetIds: [] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
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

    await handleCallbackQuery(db, "fake-token", {
      id: "cb-select",
      data: "select:1",
      from: { id: 999, username: "requester" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(
      history
        .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
        .map((entry) => entry.binds[1]),
    ).toEqual([ambiguous.matches[0].id, usdc.matches[0].id]);
    expect(lastAckBody().text).toBe("Selected.");
    const sent = lastSentMessageBody();
    expect(sent.text).toContain("Updated subscriptions");
    expect(sent.text).toContain(ambiguous.matches[0].id);
    expect(sent.text).toContain(usdc.matches[0].id);
  });

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

  it("snooze D1 write failure records a failure usage event", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO telegram_subscribers",
        rows: [],
        throwError: new Error("d1 boom"),
      },
    ]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-snooze-fail",
      data: "snooze:1h",
      from: { id: 1, username: "alice" },
      message: { chat: { id: 42, type: "private" }, message_id: 999 },
    });

    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds.includes("snooze_change") &&
          entry.binds.includes("chat") &&
          entry.binds.includes("failure"),
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[6]).toBe("d1_write_failed");
    expect(lastAckBody().text).toMatch(/could not save snooze/i);
  });

  it("does not overwrite group subscriber username with the callback actor username", async () => {
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
      id: "cb1-group",
      data: "snooze:1h",
      from: { id: 7, username: "tapping_user" },
      message: { chat: { id: -42, type: "supergroup" }, message_id: 999 },
    });

    const upsert = db.getHistory().find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
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
    const usageRow = history.find((h) => h.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[1]).toBe("unknown_command");
    expect(usageRow!.binds[3]).toBe("unknown");
    expect(usageRow!.binds[4]).toBe("unknown");

    const body = firstAckBody();
    expect(body.text).toBe("Action not recognized.");
  });

  it("unknown action records only a usage row before allowlist rejection", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-unknown",
      data: "garbage:xyz",
      from: { username: "mallory" },
      message: { chat: { id: 42 }, message_id: 999 },
    });

    const history = db.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].sql).toContain("INSERT INTO telegram_usage_daily");
    expect(history[0].binds[1]).toBe("unknown_command");
    expect(history[0].binds[3]).toBe("unknown");
    expect(history[0].binds[4]).toBe("unknown");
    expect(history[0].binds[6]).toBe("");
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
    expect(firstAckBody()).toBeDefined();
  });

  describe("coinsnooze (P1-U10)", () => {
    it("coinsnooze:<id>:4h upserts alert_snooze_until_ts on the matching subscription row", async () => {
      const before = Math.floor(Date.now() / 1000);
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coinsnooze",
        data: "coinsnooze:usdc-circle:4h",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42 }, message_id: 999 },
      });

      const upsert = db
        .getHistory()
        .find(
          (h) =>
            /INSERT INTO telegram_subscriptions/.test(h.sql) &&
            /alert_snooze_until_ts = excluded\.alert_snooze_until_ts/.test(h.sql),
        );
      expect(upsert).toBeDefined();
      expect(upsert!.binds[0]).toBe("42");
      expect(upsert!.binds[1]).toBe("usdc-circle");
      const until = Number(upsert!.binds[2]);
      expect(until).toBeGreaterThanOrEqual(before + 4 * 3600 - 2);
      expect(until).toBeLessThanOrEqual(before + 4 * 3600 + 60);

      const body = firstAckBody();
      expect(body.text).toMatch(/Snoozed USDC for 4h/);
    });

    it("coinsnooze D1 write failure records a failure usage event", async () => {
      const db = mockD1([
        {
          match: "INSERT INTO telegram_subscriptions",
          rows: [],
          throwError: new Error("d1 boom"),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coinsnooze-fail",
        data: "coinsnooze:usdc-circle:4h",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const usageRow = db
        .getHistory()
        .find(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("snooze_change") &&
            entry.binds.includes("coin") &&
            entry.binds.includes("failure"),
        );
      expect(usageRow).toBeDefined();
      expect(usageRow!.binds[6]).toBe("d1_write_failed");
      expect(lastAckBody().text).toMatch(/could not save snooze/i);
    });

    it("coinsnooze rejects an unknown stablecoin id without touching D1", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coinsnooze-bad",
        data: "coinsnooze:not-a-coin:1h",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(body.text).toBe("Action not recognized.");
    });

    it("coinsnooze rejects an unknown duration token without touching D1", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coinsnooze-bad-dur",
        data: "coinsnooze:usdc-circle:12h",
        from: { id: 1 },
        message: { chat: { id: 42 }, message_id: 999 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(body.text).toBe("Action not recognized.");
    });
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

  it("confirm:bulk keeps preset-only follow provenance out of direct coin rows", async () => {
    const db = mockD1([{
      match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
      rows: [],
      first: {
        action_type: "confirm-bulk",
        action_payload: JSON.stringify({
          kind: "subscribe",
          alertTypes: ["dews"],
          presetIds: ["usd-top25"],
          coinIds: [],
          subscribeAll: false,
        }),
        alert_types: JSON.stringify([]),
        resolved_ids: JSON.stringify([]),
        ambiguous_ticker: "",
        candidates: JSON.stringify([]),
        remaining_tickers: JSON.stringify([]),
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      },
    }]);

    await handleCallbackQuery(db, "fake-token", {
      id: "cb-preset-follow",
      data: "confirm:bulk",
      from: { id: 999, username: "requester" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_preset_subscriptions"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("confirm:bulk preset unfollow preserves direct coin rows", async () => {
    const db = mockD1([{
      match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
      rows: [],
      first: {
        action_type: "confirm-bulk",
        action_payload: JSON.stringify({
          kind: "unsubscribe",
          presetIds: ["usd-top25"],
          coinIds: [],
          unsubscribeAll: false,
        }),
        alert_types: JSON.stringify([]),
        resolved_ids: JSON.stringify([]),
        ambiguous_ticker: "",
        candidates: JSON.stringify([]),
        remaining_tickers: JSON.stringify([]),
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      },
    }]);

    await handleCallbackQuery(db, "fake-token", {
      id: "cb-preset-unfollow",
      data: "confirm:bulk",
      from: { id: 999, username: "requester" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_preset_subscriptions"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
  });

  describe("forget confirmation callbacks", () => {
    it("confirm:forget deletes subscriber-owned Telegram rows and replies", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-confirm",
        data: "confirm:forget",
        from: { id: 999, username: "requester" },
        message: { chat: { id: 123, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_preset_subscriptions"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_alerts"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_alert_job_targets"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_alert_dead_letters"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"))).toBe(false);
      expect(sendAuditedTelegramReply).toHaveBeenCalledWith(
        db,
        "123",
        "Your subscriber data has been deleted. Use /start to begin again.",
        "fake-token",
        { actionDetail: "callback_forget", recordReplyOutcome: false },
      );
      expect(lastSentMessageBody().text).toContain("subscriber data has been deleted");
      expect(lastAckBody().text).toBe("Deleted.");
    });

    it("cancel:forget clears only the pending confirmation and replies", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-cancel",
        data: "cancel:forget",
        from: { id: 999, username: "requester" },
        message: { chat: { id: 123, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastSentMessageBody().text).toBe("Cancelled.");
      expect(lastAckBody().text).toBe("Cancelled.");
    });

    it("confirm:forget refuses leaked group callbacks before reading D1", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-group",
        data: "confirm:forget",
        from: { id: 999, username: "requester" },
        message: { chat: { id: -123, type: "supergroup" }, message_id: 1 },
      });

      expect(db.getHistory()).toHaveLength(0);
      expect(lastAckBody().text).toContain("Open a private chat");
    });

    it("confirm:forget leaves expired pending cleanup to the cron without deleting subscriber data", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ expires_at: Math.floor(Date.now() / 1000) - 1 }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-expired",
        data: "confirm:forget",
        from: { id: 999, username: "requester" },
        message: { chat: { id: 123, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toContain("expired");
    });

    it("confirm:forget refuses non-initiators without deleting", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-other",
        data: "confirm:forget",
        from: { id: 7, username: "other" },
        message: { chat: { id: 123, type: "private" }, message_id: 1 },
      });

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toMatch(/only the user who started/i);
    });

    it("confirm:forget rejects unrelated pending actions", async () => {
      const db = mockD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ action_type: "confirm-bulk" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-forget-wrong-pending",
        data: "confirm:forget",
        from: { id: 999, username: "requester" },
        message: { chat: { id: 123, type: "private" }, message_id: 1 },
      });

      expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toBe("No forget confirmation is pending.");
    });
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

    function editMessageBody(): {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    } {
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
      const subscriptionSelect = db.getHistory().find((h) => h.sql.includes("FROM telegram_subscriptions"));
      expect(subscriptionSelect?.sql).toContain("alert_reserve");
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

    it("manage:page in a group allows non-admin read-only pagination", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [makeSubRow("usdc-circle")] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-group",
        data: "manage:page:0",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 100 },
      });

      expect(editMessageBody().text).toContain("Manage watchlist");
      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    });

    it("rejects malformed manage page numbers without loading subscriptions", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-bad",
        data: "manage:page:1.5",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      expect(db.getHistory().some((h) => h.sql.includes("FROM telegram_subscriptions"))).toBe(false);
      expect(firstAckBody().text).toBe("Action not recognized.");
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

      expect(firstAckBody().text).toMatch(/Removed USDC/);

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("unsub:dai-makerdao");
      expect(callbacks).not.toContain("unsub:usdc-circle");
    });

    it("unsub:<id> clears the inline keyboard when the last subscription is removed", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-empty",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      expect(body.text).toContain("No coin subscriptions");
      expect(body.reply_markup?.inline_keyboard).toEqual([]);
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

    it("infers the current manage page from nav callback_data when labels change", async () => {
      const remaining = [
        "usdc-circle",
        "usdt-tether",
        "dai-makerdao",
        "frax-frax",
        "tusd-trueusd",
        "lusd-liquity",
        "susd-synthetix",
        "pyusd-paypal",
        "eurc-circle",
        "xaut-tether",
        "aeur-anchored-coins",
      ].map(makeSubRow);
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-relabel",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: {
          chat: { id: 42, type: "private" },
          message_id: 100,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Remove USDC", callback_data: "unsub:usdc-circle" }],
              [
                { text: "Back", callback_data: "manage:page:0" },
                { text: "Forward", callback_data: "manage:page:2" },
              ],
            ],
          },
        } as unknown as Parameters<typeof handleCallbackQuery>[2]["message"],
      });

      expect(editMessageBody().text).toContain("Page 2/3");
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
      const db = mockD1([{ match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-settings",
        data: "settings:home",
        from: { id: 1 },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      // editMessageText was called, not sendMessage.
      const edits = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("editMessageText"));
      expect(edits.length).toBe(1);
    });

    it("settings:home:<page> routes to the requested per-coin button page", async () => {
      const db = mockD1([
        { match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null },
        {
          match: "FROM telegram_subscriptions",
          rows: ["usdt-tether", "usdc-circle", "dai-makerdao", "pyusd-paypal", "usds-sky", "usde-ethena"].map(
            (stablecoinId) => ({
              stablecoin_id: stablecoinId,
              alert_dews: 1,
              alert_depeg: 0,
              alert_safety: 0,
              alert_launch: 0,
              dews_min_band: "ALERT",
              safety_mode: null,
              depeg_worsening_bps_step: null,
            }),
          ),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-settings-page",
        data: "settings:home:1",
        from: { id: 1 },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const edits = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("editMessageText"));
      expect(edits.length).toBe(1);
      const body = JSON.parse((edits[0][1] as RequestInit).body as string) as {
        reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
      };
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
      expect(callbacks.filter((callback) => callback?.startsWith("settings:o:"))).toHaveLength(1);
      expect(callbacks).toContain("settings:home:0");
    });

    it("settings:c:<id>:db:A writes the alert_dews flag", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-coin",
        data: "settings:c:usdc-circle:db:A",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const history = db.getHistory();
      const insert = history.find(
        (h) =>
          /INSERT INTO telegram_subscriptions/.test(h.sql) && /dews_min_band = excluded\.dews_min_band/.test(h.sql),
      );
      expect(insert).toBeDefined();
      expect(insert!.binds[2]).toBe(1); // alert_dews
      expect(insert!.binds[3]).toBe("ALERT");
    });

    it("settings mutating callbacks in groups refuse non-admins before D1 writes", async () => {
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

      await handleCallbackQuery(db, "fake-token", {
        id: "cb-settings-group",
        data: "settings:gt:dews",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 999 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
    });

    it("malformed settings callbacks do not write", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-settings-bad",
        data: "settings:q:2",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/not recognized/i);
    });
  });

  it("depegstep in a group refuses non-admins without writing", async () => {
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

    await handleCallbackQuery(db, "fake-token", {
      id: "cb-depegstep-group",
      data: "depegstep:usdc-circle:250",
      from: { id: 7, username: "member" },
      message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
    const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
  });

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

  it("setup confirm in a group refuses non-admins before loading setup state", async () => {
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

    await handleCallbackQuery(db, "fake-token", {
      id: "cb-setup-confirm-group",
      data: "setup:confirm",
      from: { id: 7, username: "member" },
      message: { chat: { id: -42, type: "supergroup" }, message_id: 1 },
    });

    const history = db.getHistory();
    expect(history.some((h) => /telegram_pending_disambiguation/.test(h.sql))).toBe(false);
    const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
  });

  it("malformed bulk confirmation callbacks do not load pending state", async () => {
    const db = mockD1([]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-bad-confirm",
      data: "confirm:bulk:extra",
      from: { id: 1, username: "alice" },
      message: { chat: { id: 42, type: "private" }, message_id: 1 },
    });

    expect(db.getHistory().some((h) => /telegram_pending_disambiguation/.test(h.sql))).toBe(false);
    const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/not recognized/i);
  });

  describe("tz timezone callback", () => {
    it("tz:<zone> persists a valid IANA zone with timezone in the upsert", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-tz",
        data: "tz:Europe/Paris",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const upsert = db
        .getHistory()
        .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && /timezone = excluded\.timezone/.test(h.sql));
      expect(upsert).toBeDefined();
      expect(upsert!.binds).toContain("Europe/Paris");

      const editBody = lastEditedMessageBody();
      expect(editBody.text).toContain("Current timezone: Europe/Paris");
      expect(editBody.text).toContain("Quiet hours from /mute");

      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(body.text).toContain("Europe/Paris");
    });

    it("tz:<unknown> rejects with a toast and does not write", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-tz-bad",
        data: "tz:Mars/Olympus_Mons",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 999 },
      });

      const wrote = db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(wrote).toBe(false);

      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(body.text).toMatch(/unknown timezone/i);
    });
  });
});
