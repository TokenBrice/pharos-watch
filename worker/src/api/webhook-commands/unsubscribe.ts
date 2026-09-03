import { parseTargetArgs, resolveTicker } from "../../lib/telegram/alerts";
import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import {
  buildNotFoundMessage,
} from "../telegram-webhook-messages";
import { PENDING_OWNERSHIP_CONFLICT_MESSAGE } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  buildTelegramActionContext,
  dedupePresetIds,
  makeActionRunner,
  persistBulkConfirmPrompt,
  subscribableCoinCount,
} from "./action-runner";

export const handleUnsubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  // /unsubscribe deliberately drops the username: it never creates a
  // subscriber row, so it must not refresh the stored handle.
  const actionContext = buildTelegramActionContext(ctx, { username: null });
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
    const persisted = await persistBulkConfirmPrompt(actionContext, payload, {
      requireMatchingStoredIntent: true,
    });
    if (!persisted) {
      await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return;
    }
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("unsubscribe", subscribableCoinCount(), [], []),
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const runAction = makeActionRunner(
    actionContext,
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
