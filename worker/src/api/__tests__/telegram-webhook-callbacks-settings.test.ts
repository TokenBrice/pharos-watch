import { describe, expect, it, beforeEach } from "vitest";
import { mockTelegramMembership } from "../../test-helpers/__shared/telegram";
import {
  fetchSpy,
  handleCallbackQuery,
  mockD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support";



















beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
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
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

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

});
