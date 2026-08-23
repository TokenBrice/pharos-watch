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

















function lastEditedMessageBody(): { text: string; reply_markup?: unknown } {
  return telegramApiCallBody(fetchSpy, "editMessageText");
}

beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
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
