import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchSpy,
  handleCallbackQuery,
  mockD1,
  resetCallbackTest,
  sendAuditedTelegramReply,
} from "./telegram-webhook-callbacks.test-support";
import {
  telegramApiCallBody,
} from "../../test-helpers/__shared/telegram";













function lastAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery");
}

function firstAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery", { last: false });
}



beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
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
});
