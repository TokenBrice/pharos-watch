import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  parseSubscribeArgs,
  resolveTicker,
  validateSubscribeArgs,
} from "../../lib/telegram-alerts";
import { buildNotFoundMessage } from "../telegram-webhook-messages";
import {
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  persistPendingConfirmBulk,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  dedupePresetIds,
  makeActionRunner,
  subscribableCoinCount,
} from "./action-runner";

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username, actorUserId } = ctx;
  const parsed = parseSubscribeArgs(args);
  const validationError = validateSubscribeArgs(parsed);
  if (validationError) {
    if (parsed.invalidTargets.length > 0 && parsed.alertTypes.size > 0) {
      const invalidTarget = parsed.invalidTargets[0];
      const match = resolveTicker(invalidTarget);
      const suggestion = match.status === "not_found" ? match.suggestion : undefined;
      await ctx.replyToChat(buildNotFoundMessage(invalidTarget, suggestion));
      await recordTelegramUsageEvent(db, {
        eventType: "subscribe",
        actionDetail: "validation",
        outcome: "failure",
        failureClass: "target_not_found",
      });
      return;
    }
    await ctx.replyToChat(escapeHtml(validationError));
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "invalid_args",
    });
    return;
  }

  if (parsed.subscribeAll) {
    const persisted = await persistPendingConfirmBulk(db, {
      chatId,
      payload: {
        kind: "subscribe",
        alertTypes: [...parsed.alertTypes],
        presetIds: [],
        depegWorseningBpsStep: parsed.depegWorseningBpsStep,
        coinIds: [],
        subscribeAll: true,
      },
      initiatorUserId: actorUserId,
    });
    if (!persisted) {
      await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return;
    }
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], []),
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const runAction = makeActionRunner(
    { db, chatId, username, initiatorUserId: actorUserId },
    ctx.botToken,
    { kind: "subscribe", alertTypes: [...parsed.alertTypes], presetIds, depegWorseningBpsStep: parsed.depegWorseningBpsStep },
  );
  await runAction({
    tickers: parsed.tickers,
    actionType: "subscribe",
    actionPayload: {
      alertTypes: [...parsed.alertTypes],
      presetIds,
      depegWorseningBpsStep: parsed.depegWorseningBpsStep,
    },
    alertTypes: parsed.alertTypes,
  });
};
