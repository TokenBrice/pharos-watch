import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  parseSubscribeArgs,
  resolveTicker,
  validateSubscribeArgs,
} from "../../lib/telegram-alerts";
import { buildNotFoundMessage } from "../telegram-webhook-messages";
import { PENDING_OWNERSHIP_CONFLICT_MESSAGE } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  dedupePresetIds,
  makeActionRunner,
  persistBulkConfirmPrompt,
  subscribableCoinCount,
  type TelegramActionContext,
} from "./action-runner";

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username, actorUserId } = ctx;
  const actionContext: TelegramActionContext = {
    db,
    chatId,
    username,
    initiatorUserId: actorUserId,
    beforeIrreversibleEffect: ctx.beforeIrreversibleEffect,
    planIntent: ctx.planIntent,
    prepareMutationAppliedStatement: ctx.prepareMutationAppliedStatement,
    prepareMutationOperationStatements: ctx.prepareMutationOperationStatements,
    preparePendingMutationAppliedStatement: ctx.preparePendingMutationAppliedStatement,
    confirmAtomicMutationApplied: ctx.confirmAtomicMutationApplied,
    markMutationApplied: ctx.markMutationApplied,
    storedIntent: ctx.storedIntent,
    wasMutationApplied: ctx.wasMutationApplied,
    operationNowSec: ctx.operationNowSec,
  };
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
    const payload = {
      kind: "subscribe" as const,
      alertTypes: [...parsed.alertTypes].sort(),
      presetIds: [],
      depegWorseningBpsStep: parsed.depegWorseningBpsStep,
      coinIds: [],
      subscribeAll: true,
    };
    const persisted = await persistBulkConfirmPrompt(actionContext, payload, {
      requireMatchingStoredIntent: true,
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
    actionContext,
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
    clearPendingOnTerminal: ctx.clearPendingOnMutation,
  });
};
