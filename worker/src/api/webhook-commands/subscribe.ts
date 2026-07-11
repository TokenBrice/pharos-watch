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
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";

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
    const payload = {
      kind: "subscribe" as const,
      alertTypes: [...parsed.alertTypes].sort(),
      presetIds: [],
      depegWorseningBpsStep: parsed.depegWorseningBpsStep,
      coinIds: [],
      subscribeAll: true,
    };
    const storedExpiresAt = ctx.storedIntent?.kind === "command:subscribe"
      ? Number(ctx.storedIntent.payload.expiresAt)
      : NaN;
    const expiresAt = Number.isFinite(storedExpiresAt)
      ? storedExpiresAt
      : (ctx.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
    await ctx.planIntent?.(createTelegramWebhookIntent("command:subscribe", {
      stage: "bulk-confirm-prompt",
      payload,
      expiresAt,
    }, "required"));
    const operationStatements = ctx.preparePendingMutationAppliedStatement
      ? [ctx.preparePendingMutationAppliedStatement({
          chatId,
          actionType: "confirm-bulk",
          actionPayload: JSON.stringify(payload),
          expiresAt,
        })]
      : undefined;
    const persisted = ctx.wasMutationApplied
      ? true
      : await persistPendingConfirmBulk(db, {
          chatId,
          payload,
          initiatorUserId: actorUserId,
          expiresAt,
          operationStatements,
        });
    if (!persisted) {
      await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return;
    }
    if (!ctx.wasMutationApplied && operationStatements) ctx.confirmAtomicMutationApplied?.();
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], []),
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const runAction = makeActionRunner(
    {
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
    },
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
