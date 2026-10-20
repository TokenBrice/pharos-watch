import { afterEach, describe, expect, it, beforeEach } from "vitest";
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
  handleCallbackQuery,
  lastAckBody,
  lastEditedMessageBody,
  makeCallbackQuery,
  mockTelegramD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support.ts";



















beforeEach(resetCallbackTest);
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("handleCallbackQuery", () => {
  describe("settings dispatch", () => {
    it.each(["xx:1", "db:bad", "sm:bad", "ds:123", "lc:2", "rs:yes", "fz:"])(
      "terminalizes invalid per-coin setting %s once without a mutation requirement",
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
        expect(sqlite.prepare(`SELECT status, effect_state, intent_mutates, mutation_applied_at
          FROM telegram_processed_updates WHERE update_id = 800`).get())
          .toEqual({ status: "processed", effect_state: "complete", intent_mutates: 0, mutation_applied_at: null });
      },
    );

    it("commits a valid per-coin setting and its mutation marker before the first Bot API effect", async () => {
      resetTelegramWebhookTest();
      const { db, sqlite } = fixtures.open();
      const observedBeforeEffects: unknown[] = [];
      webhookFetchSpy.mockImplementation(async () => {
        observedBeforeEffects.push({
          setting: sqlite.prepare("SELECT alert_dews FROM telegram_subscriptions WHERE chat_id = '42'").get(),
          proof: sqlite.prepare("SELECT mutation_applied_at FROM telegram_processed_updates WHERE update_id = 801").get(),
        });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      });
      const response = await handleTelegramWebhook(db,
        makeCallbackRequest("settings:c:usdc-circle:db:A", { chatId: 42, updateId: 801 }), "test-secret", "bot-token");
      expect(response.status).toBe(200);
      expect(webhookFetchSpy).toHaveBeenCalled();
      expect(observedBeforeEffects.length).toBeGreaterThan(0);
      for (const observed of observedBeforeEffects) {
        expect(observed).toEqual({ setting: { alert_dews: 1 }, proof: { mutation_applied_at: expect.any(Number) } });
      }
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
      const db = mockTelegramD1([
        { match: "FROM telegram_subscriptions", rows: [] },
        { match: "INSERT INTO telegram_subscribers", rows: [] },
        { match: "INSERT INTO telegram_subscriptions", rows: [] },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:c:usdc-circle:db:A", { id: "cb-coin" }));

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
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("settings:gt:dews", { id: "cb-settings-group", from: { id: 7, username: "member" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 999 } }));

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
      const before = Math.floor(Date.now() / 1000);
      const db = mockTelegramD1([
        { match: "INSERT INTO telegram_subscribers", rows: [] },
        { match: "INSERT INTO telegram_subscriptions", rows: [] },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("coinsnooze:usdc-circle:4h", { id: "cb-coinsnooze", message: { chat: { id: 42 }, message_id: 999 } }));

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

  describe("tz timezone callback", () => {
    it("tz:<zone> persists a valid IANA zone with timezone in the upsert", async () => {
      const db = mockTelegramD1([{ match: "INSERT INTO telegram_subscribers", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("tz:Europe/Paris", { id: "cb-tz" }));

      const upsert = db
        .getHistory()
        .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && /timezone = excluded\.timezone/.test(h.sql));
      expect(upsert).toBeDefined();
      expect(upsert!.binds).toContain("Europe/Paris");

      const editBody = lastEditedMessageBody();
      expect(editBody.text).toContain("Current timezone: Europe/Paris");
      expect(editBody.text).toContain("Quiet hours from /mute");
      expect(lastAckBody().text).toContain("Europe/Paris");
    });

    it("tz:<unknown> rejects with a toast and does not write", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("tz:Mars/Olympus_Mons", { id: "cb-tz-bad" }));

      expect(db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      expect(lastAckBody().text).toMatch(/unknown timezone/i);
    });
  });
});
