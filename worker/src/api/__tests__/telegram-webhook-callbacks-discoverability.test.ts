import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockTelegramMembership } from "../../test-helpers/__shared/telegram";
import {
  firstAckBody,
  firstSentMessageBody,
  fetchSpy,
  handleCallbackQuery,
  makeCallbackQuery,
  lastAckBody,
  lastSentMessageBody,
  mockTelegramD1,
  resetCallbackTest,
  sendAuditedTelegramReply,
} from "./telegram-webhook-callbacks.test-support";














beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("P1-U11 discoverability callbacks", () => {
    it("why:<id> sends the safety Why explainer and acks", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("why:usdc-circle", { id: "cb-why", from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

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
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("coverage:usdc-circle", { id: "cb-cov", from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

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
      const whyDb = mockTelegramD1([]);
      await handleCallbackQuery(whyDb, "fake-token", makeCallbackQuery("why:usdc-circle", { id: "cb-why-group", from: { id: 999, username: "alice" }, message: { chat: { id: -42, type: "group" }, message_id: 1 } }));
      const whyButtons = (firstSentMessageBody().reply_markup?.inline_keyboard ?? []).flat();
      expect(whyButtons).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "Why?", callback_data: "why:usdc-circle" }),
        expect.objectContaining({ text: "Coverage", callback_data: "coverage:usdc-circle" }),
        expect.objectContaining({ text: "Subscribe", callback_data: "quicksub:usdc-circle" }),
      ]));
      expect(whyButtons.some((button) => button.web_app)).toBe(false);

      const coverageDb = mockTelegramD1([]);
      await handleCallbackQuery(coverageDb, "fake-token", makeCallbackQuery("coverage:usdc-circle", { id: "cb-cov-group", from: { id: 999, username: "alice" }, message: { chat: { id: -42, type: "group" }, message_id: 1 } }));
      const coverageButtons = (lastSentMessageBody().reply_markup?.inline_keyboard ?? []).flat();
      expect(coverageButtons).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "Why?", callback_data: "why:usdc-circle" }),
        expect.objectContaining({ text: "Coverage", callback_data: "coverage:usdc-circle" }),
        expect.objectContaining({ text: "Subscribe", callback_data: "quicksub:usdc-circle" }),
      ]));
      expect(coverageButtons.some((button) => button.web_app)).toBe(false);
    });

    it("quicksub:<id> in a group refuses non-admin without writing to D1", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      // Webhook auth fetches getChatMember from Telegram when cache misses.
      mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "m" });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:usdc-circle", { id: "cb-qs-group", from: { id: 7, username: "tapping_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((h) => /INSERT INTO telegram_subscribers/.test(h.sql))).toBe(false);
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(false);
      expect(firstAckBody().text).toMatch(/Only group admins/i);
    });

    it("quicksub:<id> in a group with admin tapping writes the subscription", async () => {
      const db = mockTelegramD1([], {
        fallbackTables: [{ match: "FROM cache WHERE key = ?", rows: [], first: null }],
      });
      mockTelegramMembership(fetchSpy, "administrator", { id: 7, is_bot: false, first_name: "admin" });
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:usdc-circle", { id: "cb-qs-admin", from: { id: 7, username: "admin_user" }, message: { chat: { id: -42, type: "supergroup" }, message_id: 1 } }));

      const history = db.getHistory();
      const subscriberUpsert = history.find((h) => /INSERT INTO telegram_subscribers/.test(h.sql));
      expect(subscriberUpsert).toBeDefined();
      // Group chats must not persist the tapping admin's personal username.
      expect(subscriberUpsert!.binds[1]).toBeNull();
      expect(history.some((h) => /INSERT INTO telegram_subscriptions/.test(h.sql))).toBe(true);
    });

    it("unknown stablecoin id in why/coverage/quicksub callbacks falls through to a graceful ack", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("quicksub:not-a-real-coin", { id: "cb-bad", from: { id: 999, username: "alice" }, message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((h) => /\bINSERT\b/i.test(h.sql))).toBe(false);
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
      ["why", "Why sent."],
      ["coverage", "Coverage sent."],
      ["quicksub", "Subscribed to DEWS + depeg for USDC."],
    ])("%s:<id> still acks when sendAuditedTelegramReply throws (P1.16)", async (action, acknowledgement) => {
      const db = mockTelegramD1([]);
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
