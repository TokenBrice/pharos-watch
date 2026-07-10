import { parseTargetArgs, resolveTicker } from "../../lib/telegram-alerts";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  buildNotFoundMessage,
} from "../telegram-webhook-messages";
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

export const handleUnsubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, actorUserId } = ctx;
  const parsed = parseTargetArgs(args, { resolutionScope: "tracked" });
  if (args.trim().length === 0) {
    await ctx.replyToChat("Specify ticker(s) or preset(s) to unsubscribe, or use /unsubscribe all");
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "missing_target",
    });
    return;
  }

  if (parsed.includeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    await ctx.replyToChat('Use /unsubscribe all by itself, or specify ticker/preset targets without "all".');
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "mixed_all",
    });
    return;
  }

  if (parsed.invalidTargets.length > 0) {
    const invalidTarget = parsed.invalidTargets[0];
    const match = resolveTicker(invalidTarget, "tracked");
    const suggestion = match.status === "not_found" ? match.suggestion : undefined;
    await ctx.replyToChat(buildNotFoundMessage(invalidTarget, suggestion));
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "target_not_found",
    });
    return;
  }

  if (parsed.includeAll) {
    const payload = {
      kind: "unsubscribe" as const,
      presetIds: [],
      coinIds: [],
      unsubscribeAll: true,
    };
    const storedExpiresAt = ctx.storedIntent?.kind === "command:unsubscribe"
      ? Number(ctx.storedIntent.payload.expiresAt)
      : NaN;
    const expiresAt = Number.isFinite(storedExpiresAt)
      ? storedExpiresAt
      : (ctx.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
    await ctx.planIntent?.(createTelegramWebhookIntent("command:unsubscribe", {
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
      buildBulkConfirmMessage("unsubscribe", subscribableCoinCount(), [], []),
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const runAction = makeActionRunner(
    {
      db,
      chatId,
      username: null,
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
    { kind: "unsubscribe", presetIds },
  );
  await runAction({
    tickers: parsed.tickers,
    actionType: "unsubscribe",
    actionPayload: { presetIds },
    resolutionScope: "tracked",
    clearPendingOnTerminal: ctx.clearPendingOnMutation,
  });
};
