import { describe, expect, it, beforeEach } from "vitest";
import { mockTelegramMembership } from "../../test-helpers/__shared/telegram";
import {
  fetchSpy,
  firstAckBody,
  handleCallbackQuery,
  lastAckBody,
  lastEditedMessageBody,
  makeCallbackQuery,
  mockTelegramD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support";



















beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("settings dispatch", () => {
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

    it("coinsnooze D1 write failure records a failure usage event", async () => {
      const db = mockTelegramD1([
        {
          match: "INSERT INTO telegram_subscriptions",
          rows: [],
          throwError: new Error("d1 boom"),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("coinsnooze:usdc-circle:4h", { id: "cb-coinsnooze-fail" }));

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
