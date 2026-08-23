import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { formatCoveragePayload } from "@shared/lib/telegram-mini-app-payloads";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { buildCoverageMessage } from "../telegram-webhook-insights";
import {
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { runReadOnlyCoinCallback, type CallbackContext } from "./_shared";

type ReadOnlyStatusContext = Pick<
  CallbackContext,
  "db" | "botToken" | "cb" | "chatId" | "parsed" | "answerCallback" | "beforeIrreversibleEffect" | "planIntent"
>;

/**
 * Shared read-only reply lane for the `status` and `coverage` callbacks. Both
 * routes render the same status document through the same audited reply path and
 * differ only in message builder, ack text, intent kind, and mini-app payload, so
 * the lane is parameterized by `variant` rather than duplicated per route.
 */
export async function runReadOnlyStatusCallback(
  { db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect, planIntent }: ReadOnlyStatusContext,
  variant: "status" | "coverage",
): Promise<void> {
  const coverage = variant === "coverage";
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: coverage ? "Coverage sent." : "Status sent.",
    answerCallback,
    planIntent,
    intentKind: coverage ? "callback:coverage" : "callback:status",
    send: async (id, isPrivateChat) => {
      const status = await loadStatusForCoin(db, id);
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      await beforeIrreversibleEffect(coverage ? "callback-coverage-reply" : "callback-status-reply");
      const message = coverage ? buildCoverageMessage(symbol, status) : buildStatusMessage(symbol, status);
      const replyMarkup = coverage
        ? buildStatusDiscoveryKeyboard(id, {
            includeMiniAppButton: isPrivateChat,
            miniAppPayload: formatCoveragePayload(id),
          })
        : buildStatusDiscoveryKeyboard(id, { includeMiniAppButton: isPrivateChat });
      await sendAuditedTelegramReply(db, chatId, message, botToken, {
        replyMarkup,
        actionDetail: coverage ? "callback_coverage" : "callback_status",
      });
    },
  });
}
