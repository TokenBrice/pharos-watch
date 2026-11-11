import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  fetchSpy as webhookFetchSpy,
  handleTelegramWebhook,
  makeCallbackRequest,
  resetTelegramWebhookTest,
} from "./telegram-webhook.test-support.ts";
import { mockTelegramMembership } from "../../../test-helpers/__shared/telegram";
import {
  fetchSpy,
  firstAckBody,
  firstSentMessageBody,
  handleCallbackQuery,
  lastAckBody,
  lastSentMessageBody,
  makeCallbackQuery,
  mockTelegramD1,
  resetCallbackTest,
  sendAuditedTelegramReply,
} from "./telegram-webhook-callbacks.test-support.ts";



















beforeEach(resetCallbackTest);
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("handleCallbackQuery", () => {
  describe("settings dispatch", () => {
    it.each(["xx:1", "db:bad", "sm:bad", "ds:123", "rs:yes", "fz:"])(
      "acks invalid per-coin setting %s once and dedupes its redelivery",
      async (setting) => {
        resetTelegramWebhookTest();
        const { db, sqlite } = fixtures.open();
        sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation) VALUES ('42', 1, 1, 7)");
        for (let delivery = 0; delivery < 2; delivery++) {
          const request = makeCallbackRequest(`settings:c:usdc-circle:${setting}`, { chatId: 42, updateId: 800 });
          expect((await handleTelegramWebhook(db, request, "test-secret", "bot-token")).status).toBe(200);
        }
        const acks = webhookFetchSpy.mock.calls.filter((call) => String(call[0]).includes("answerCallbackQuery"));
        expect(acks).toHaveLength(1);
        expect(JSON.parse((acks[0][1] as RequestInit).body as string).text).toMatch(/unknown setting/i);
        expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '42'").get())
          .toEqual({ preference_generation: 7 });
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT status FROM telegram_processed_updates WHERE update_id = 800").get())
          .toEqual({ status: "processed" });
      },
    );

    it("commits a valid per-coin setting before the first Bot API effect", async () => {
      resetTelegramWebhookTest();
      const { db, sqlite } = fixtures.open();
      const observedBeforeEffects: unknown[] = [];
      webhookFetchSpy.mockImplementation(async () => {
        observedBeforeEffects.push(sqlite.prepare("SELECT alert_dews FROM telegram_subscriptions WHERE chat_id = '42'").get());
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      });
      const response = await handleTelegramWebhook(db,
        makeCallbackRequest("settings:c:usdc-circle:db:A", { chatId: 42, updateId: 801 }), "test-secret", "bot-token");
      expect(response.status).toBe(200);
      expect(webhookFetchSpy).toHaveBeenCalled();
      expect(observedBeforeEffects.length).toBeGreaterThan(0);
      for (const observed of observedBeforeEffects) expect(observed).toEqual({ alert_dews: 1 });
    });

    it("settings:home routes to the settings handler and edits the message", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null }],
      });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:home", { id: "cb-settings", from: { id: 1 } }));

      // editMessageText was called, not sendMessage.
      const edits = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("editMessageText"));
      expect(edits.length).toBe(1);
    });

    it("settings:home:<page> routes to the requested per-coin button page", async () => {
      const db = mockTelegramD1([
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
      ], {
        fallbackTables: [{ match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null }],
      });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:home:1", { id: "cb-settings-page", from: { id: 1 } }));

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
      const { db, sqlite } = fixtures.open();
      const row = sqlite.prepare(`SELECT alert_dews, dews_min_band, alert_safety
        FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = 'usdc-circle'`);
      for (const existing of [false, true]) {
        if (existing) sqlite.exec("UPDATE telegram_subscriptions SET alert_dews = 0, dews_min_band = 'DANGER', alert_safety = 1");
        await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:c:usdc-circle:db:A", { id: "cb-coin" }));
        expect(row.get()).toEqual({ alert_dews: 1, dews_min_band: "ALERT", alert_safety: existing ? 1 : 0 });
      }
    });

    it("settings mutating callbacks in groups refuse non-admins before D1 writes", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:gt:dews:1", { id: "cb-settings-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 999 } }));

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
    });

    it("malformed settings callbacks do not write", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:q:2", { id: "cb-settings-bad" }));

      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/not recognized/i);
    });
  });

  describe("coinsnooze (P1-U10)", () => {
    it("coinsnooze:<id>:4h upserts alert_snooze_until_ts on the matching subscription row", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_771_833_600_000);
      try {
        const { db, sqlite } = fixtures.open();
        sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
          INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
          VALUES ('42', 'usdt-tether', 123)`);
        await handleCallbackQuery(db, "fake-token", makeCallbackQuery("coinsnooze:usdc-circle:4h", { id: "cb-coinsnooze", message: { chat: { id: 42 }, message_id: 999 } }));
        expect(sqlite.prepare(`SELECT stablecoin_id, alert_snooze_until_ts FROM telegram_subscriptions
          WHERE chat_id = '42' ORDER BY stablecoin_id`).all()).toEqual([
          { stablecoin_id: "usdc-circle", alert_snooze_until_ts: 1_771_848_000 },
          { stablecoin_id: "usdt-tether", alert_snooze_until_ts: 123 },
        ]);
        expect(firstAckBody().text).toMatch(/Snoozed USDC for 4h/);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { label: "an unknown stablecoin id", data: "coinsnooze:not-a-coin:1h", id: "cb-coinsnooze-bad" },
      { label: "an unknown duration token", data: "coinsnooze:usdc-circle:12h", id: "cb-coinsnooze-bad-dur" },
    ])("coinsnooze rejects $label without touching D1", async ({ data, id }) => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery(data, { id, from: { id: 1 }, message: { chat: { id: 42 }, message_id: 999 } }));

      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      expect(lastAckBody().text).toBe("Action not recognized.");
    });
  });

  describe("retired and unknown callbacks", () => {
    it.each(["recap:on", "recap:off", "recap:h:9"])("rejects retired %s callbacks without preference access", async (data) => {
      const db = mockTelegramD1();
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery(data));
      expect(lastAckBody().text).toBe("Action not recognized.");
      expect(db.getHistory().every((entry) => !/telegram_(?:subscribers|recap_)/.test(entry.sql))).toBe(true);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/sendMessage"))).toBe(false);
    });
    it("snooze:1h stamps alert_snooze_until_ts ~1h in the future in a single INSERT", async () => {
      const before = Math.floor(Date.now() / 1000);
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { from: { username: "alice" }, message: { chat: { id: 42 }, message_id: 999 } }));

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
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "administrator", { id: 7, is_bot: false, first_name: "admin" });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { id: "cb1-group", from: { id: 7, username: "tapping_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 999 } }));

      const upsert = db.getHistory().find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(upsert).toBeDefined();
      expect(upsert!.binds[1]).toBeNull();
    });

    it.each([undefined, { username: "mallory" }])("unknown callback gracefully acknowledges actor %j and records only one usage event", async (from) => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("garbage:whatever", { id: "cb2", from, message: { chat: { id: 42 }, message_id: 999 } }));

      // No subscriber writes on unknown action.
      const history = db.getHistory();
      expect(history).toHaveLength(1);
      const usageRow = history.find((h) => h.sql.includes("INSERT INTO telegram_usage_daily"));
      expect(usageRow).toBeDefined();
      expect(usageRow!.binds[1]).toBe("unknown_command");
      expect(usageRow!.binds[3]).toBe("unknown");
      expect(usageRow!.binds[4]).toBe("unknown");
      expect(usageRow!.binds[6]).toBe("");

      const body = firstAckBody();
      expect(body.text).toBe("Action not recognized.");
    });

    it("silently acks a callback with no chat id", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("snooze:1h", { id: "cb3", from: undefined, message: {} }));

      const history = db.getHistory();
      expect(history).toHaveLength(0);
      expect(firstAckBody()).toBeDefined();
    });

    it("depegstep in a group refuses non-admins without writing", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("depegstep:usdc-circle:250", { id: "cb-depegstep-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
    });

    it("setup:top25 in a group refuses non-admins without writing", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("setup:top25", { id: "cb-setup-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      expect(db.getHistory().some((h) => /INSERT|UPDATE|DELETE/.test(h.sql) && !h.sql.includes("telegram_usage_daily"))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/i);
    });
  });

  describe("P1.17 mutating callbacks emit usage analytics", () => {
    it.each([
      {
        name: "depegstep:<id>:250 success records a subscribe usage event",
        data: "depegstep:usdc-circle:250",
        callbackId: "cb-depegstep-ok",
        actionDetail: "depegstep",
        column: "depeg_worsening_bps_step",
        binds: ["42", "usdc-circle", 250],
        sqlFragments: ["alert_depeg = 1", "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step"],
        subscriberFlag: "alert_depeg = MAX",
      },
      {
        name: "safetydown:<id> success records a subscribe usage event",
        data: "safetydown:usdc-circle",
        callbackId: "cb-safetydown-ok",
        actionDetail: "safetydown",
        column: "safety_mode",
        binds: ["42", "usdc-circle", 1, "downgrade-only"],
        sqlFragments: ["alert_safety = excluded.alert_safety", "safety_mode = excluded.safety_mode"],
        subscriberFlag: "alert_safety = MAX",
      },
    ])("$name", async ({ data, callbackId, actionDetail, column, binds, sqlFragments, subscriberFlag }) => {
      const db = mockTelegramD1([
        { match: "INSERT INTO telegram_subscribers", rows: [] },
        { match: "INSERT INTO telegram_subscriptions", rows: [] },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery(data, { id: callbackId, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      const subscriptionUpsert = history.find(
        (entry) => entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.sql.includes(column),
      );
      expect(subscriptionUpsert).toBeDefined();
      expect(subscriptionUpsert!.binds).toEqual(binds);
      for (const fragment of sqlFragments) {
        expect(subscriptionUpsert!.sql).toContain(fragment);
      }
      expect(
        history.some(
          (entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.sql.includes(subscriberFlag),
        ),
      ).toBe(true);

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes(actionDetail),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe(actionDetail);
      expect(usageRows[0].binds[4]).toBe("success");
    });
  });

  describe("discoverability", () => {
    it.each(["why", "coverage"])("retired %s:<id> buttons send the status card without writes", async (action) => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery(`${action}:usdc-circle`, { id: `cb-${action}`, from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const body = firstSentMessageBody();
      expect(body.text).toContain("<b>USDC</b>");
      const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
      expect(buttons).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "Follow USDC", callback_data: "quicksub:usdc-circle" }),
      ]));
      expect(buttons.some((button: { text?: string; web_app?: { url?: string } }) =>
        button.text === "Manage USDC" && button.web_app?.url?.includes("startapp=coin_usdc-circle"))).toBe(true);
      expect(firstAckBody().text).toBe("Status sent.");
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it("status cards in group chats keep Follow and drop Mini App buttons", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("status:usdc-circle", { id: "cb-status-group", from: { id: 999, username: "alice" }, message: { chat: { id: -42, type: "group" }, message_id: 1 } }));
      const buttons = (firstSentMessageBody().reply_markup?.inline_keyboard ?? []).flat();
      expect(buttons).toEqual([expect.objectContaining({ text: "Follow USDC", callback_data: "quicksub:usdc-circle" })]);
    });

    it("quicksub:<id> in a group refuses non-admin without writing to D1", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "m" });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:usdc-circle", { id: "cb-qs-group", from: { id: 7, username: "tapping_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      expect(firstAckBody().text).toMatch(/Only group admins/i);
    });

    it("quicksub:<id> in a group with admin tapping writes the subscription", async () => {
      const db = mockTelegramD1([
        { match: "INSERT INTO telegram_subscribers", rows: [] },
        { match: "INSERT INTO telegram_subscriptions", rows: [] },
      ], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "administrator", { id: 7, is_bot: false, first_name: "admin" });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:usdc-circle", { id: "cb-qs-admin", from: { id: 7, username: "admin_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      const history = db.getHistory();
      const subscriberUpsert = history.find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(subscriberUpsert).toBeDefined();
      expect(subscriberUpsert!.binds[1]).toBeNull();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(true);
    });

    it("unknown stablecoin id in why/coverage/quicksub callbacks falls through to a graceful ack", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:not-a-real-coin", { id: "cb-bad", from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      expect(db.getHistory().some((h) => /\bINSERT\b/i.test(h.sql))).toBe(false);
      expect(firstAckBody().text).toBe("Action not recognized.");
    });

    it("status:<id> sends the current status card and acks", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("status:usdc-circle", { id: "cb-status-ok", from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const sendBody = lastSentMessageBody();
      expect(sendBody.text).toContain("USDC");
      expect(sendBody.reply_markup).toBeDefined();
      expect(lastAckBody().text).toBe("Status sent.");
      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
    });

    it.each([
      ["status", "Status sent."],
      ["why", "Status sent."],
      ["coverage", "Status sent."],
      ["quicksub", "Subscribed to DEWS + depeg for USDC."],
    ])("%s:<id> still acks when sendAuditedTelegramReply throws (P1.16)", async (action, acknowledgement) => {
      const db = mockTelegramD1(
        action === "quicksub"
          ? [
              { match: "INSERT INTO telegram_subscribers", rows: [] },
              { match: "INSERT INTO telegram_subscriptions", rows: [] },
            ]
          : [],
      );
      vi.mocked(sendAuditedTelegramReply).mockRejectedValueOnce(new Error("api fail"));
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery(`${action}:usdc-circle`, {
        id: `cb-${action}-fail`,
        from: { id: 999, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 1 }
      })).catch(() => undefined);

      expect(firstAckBody().text).toBe(acknowledgement);
    });
  });
});
