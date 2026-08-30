import { describe, expect, it, beforeEach } from "vitest";
import {
  handleCallbackQuery,
  makeCallbackQuery,
  lastAckBody,
  lastSentMessageBody,
  mockTelegramD1,
  resetCallbackTest,
  sendAuditedTelegramReply,
} from "./telegram-webhook-callbacks.test-support";







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








beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("forget confirmation callbacks", () => {
    it("confirm:forget deletes subscriber-owned Telegram rows and replies", async () => {
      const db = mockTelegramD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("confirm:forget", { id: "cb-forget-confirm", from: { id: 999, username: "requester" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } }));

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
      const db = mockTelegramD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("cancel:forget", { id: "cb-forget-cancel", from: { id: 999, username: "requester" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastSentMessageBody().text).toBe("Cancelled.");
      expect(lastAckBody().text).toBe("Cancelled.");
    });

    it("confirm:forget refuses leaked group callbacks before reading D1", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("confirm:forget", { id: "cb-forget-group", from: { id: 999, username: "requester" }, message: { chat: { id: -123, type: "supergroup" }, message_id: 1 } }));

      expect(db.getHistory()).toHaveLength(0);
      expect(lastAckBody().text).toContain("Open a private chat");
    });

    it("confirm:forget leaves expired pending cleanup to the cron without deleting subscriber data", async () => {
      const db = mockTelegramD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ expires_at: Math.floor(Date.now() / 1000) - 1 }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("confirm:forget", { id: "cb-forget-expired", from: { id: 999, username: "requester" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toContain("expired");
    });

    it("confirm:forget refuses non-initiators without deleting", async () => {
      const db = mockTelegramD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ initiator_user_id: "999" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("confirm:forget", { id: "cb-forget-other", from: { id: 7, username: "other" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toMatch(/only the user who started/i);
    });

    it("confirm:forget rejects unrelated pending actions", async () => {
      const db = mockTelegramD1([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: pendingRowFromForget({ action_type: "confirm-bulk" }),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("confirm:forget", { id: "cb-forget-wrong-pending", from: { id: 999, username: "requester" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } }));

      expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_subscribers"))).toBe(false);
      expect(lastAckBody().text).toBe("No forget confirmation is pending.");
    });
  });

});
