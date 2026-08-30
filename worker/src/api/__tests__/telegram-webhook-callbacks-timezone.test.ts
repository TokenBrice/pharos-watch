import { describe, expect, it, beforeEach } from "vitest";
import {
  fetchSpy,
  handleCallbackQuery,
  makeCallbackQuery,
  lastEditedMessageBody,
  mockTelegramD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support";

















beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("tz timezone callback", () => {
    it("tz:<zone> persists a valid IANA zone with timezone in the upsert", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("tz:Europe/Paris", { id: "cb-tz" }));

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
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("tz:Mars/Olympus_Mons", { id: "cb-tz-bad" }));

      const wrote = db.getHistory().some((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(wrote).toBe(false);

      const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
      expect(body.text).toMatch(/unknown timezone/i);
    });
  });
});
