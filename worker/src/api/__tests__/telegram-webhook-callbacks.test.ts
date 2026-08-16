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









function lastAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery");
}

function firstAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery", { last: false });
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

});
