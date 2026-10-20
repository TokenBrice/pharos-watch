import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { TelegramWebhookOperationIntent } from "../../store/telegram-webhook-store";
import { loadPendingDisambiguation } from "../../store/telegram-webhook-store";
import { handlePendingActionBeforeDispatch } from "../../webhook/telegram-webhook-pending-gate";
import { handleBulkActionCallback } from "../confirm";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("retired command import confirmations", () => {
  it.each([
    { stored: false, applied: false },
    { stored: true, applied: false },
    { stored: true, applied: true },
  ])("rejects legacy import keyboards without writes and allows only owner cancellation ($stored/$applied)", async ({ stored, applied }) => {
    const { sqlite, db } = fixtures.open();
    const flowId = "0123456789abcdef";
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const payload = {
      kind: "watchlist-import-v2",
      flowId,
      registryVersion: "catalog-test",
      directEntries: [],
      presetEntries: [],
      expectedPreferenceGeneration: 5,
      generationLease: 4_100_000_000_000_010,
      preview: {
        directAdds: [], directRemoves: ["usdc-circle"], directChanges: [], directChangeBefore: [],
        presetAdds: [], presetRemoves: [], presetChanges: [], presetChangeBefore: [],
      },
    };
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
      VALUES ('123', 1, 1, 5);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override)
      VALUES ('123', 'usdc-circle', 1, 1);
    `);
    sqlite.prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id, action_type, action_payload, expires_at, initiator_user_id,
        alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers
      ) VALUES ('123', 'confirm-bulk', ?, ?, '42', '[]', '[]', '', '[]', '[]')
    `).run(JSON.stringify(payload), expiresAt);
    const readState = () => ({
      subscriber: sqlite.prepare("SELECT * FROM telegram_subscribers").all(),
      direct: sqlite.prepare("SELECT * FROM telegram_subscriptions").all(),
      presets: sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all(),
      pending: sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all(),
      mutations: sqlite.prepare("SELECT * FROM telegram_webhook_operation_mutations").all(),
    });
    const before = readState();
    for (const action of ["confirm", "cancel"] as const) {
      const answerCallback = vi.fn(async () => undefined);
      const planIntent = vi.fn(async () => undefined);
      const markMutationApplied = vi.fn(async () => undefined);
      const beforeIrreversibleEffect = vi.fn(async () => undefined);
      const storedIntent: TelegramWebhookOperationIntent | undefined = stored ? {
        version: 1,
        kind: `callback:${action}`,
        mutation: "required",
        payload: { action, kind: "bulk", flowId, expiresAt, payload },
      } : undefined;
      await handleBulkActionCallback({
        db, botToken: "token", chatId: "123",
        cb: {
          id: "callback-id", data: `${action}:bulk:${flowId}`, from: { id: 42 },
          message: { chat: { id: 123, type: "private" }, message_id: 10 },
        },
        parsed: { action, arg: "bulk", parts: [action, "bulk", flowId] },
        answerCallback, planIntent, markMutationApplied, beforeIrreversibleEffect,
        storedIntent, wasMutationApplied: applied,
      });
      expect(answerCallback).toHaveBeenCalledWith({ text: expect.stringMatching(/expired.*re-run/i) });
      expect(planIntent).not.toHaveBeenCalled();
      expect(markMutationApplied).not.toHaveBeenCalled();
      expect(beforeIrreversibleEffect).not.toHaveBeenCalled();
      expect(readState()).toEqual(before);
    }
    const pendingRow = await loadPendingDisambiguation(db, "123");
    const reply = vi.fn(async () => undefined);
    for (const actorUserId of ["99", "42"]) {
      await expect(handlePendingActionBeforeDispatch({
        db, botToken: "token", chatId: "123", chatType: "private", actorUserId,
        username: null, text: "/cancel", pendingRow, pendingNotExpired: true,
        parsedCommand: { command: "/cancel", args: "", botMention: null }, reply,
      })).resolves.toBe("finished");
      expect(readState()).toEqual(actorUserId === "42" ? { ...before, pending: [] } : before);
    }
  });
});
