import { parseTargetArgs, resolveTicker } from "../common/alerts-parser";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { unixNow } from "../store/subscribers";
import { buildNotFoundMessage } from "../webhook/telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";
import { buildBulkConfirmReplyMarkup, dedupePresetIds, runFollowCommand } from "./action-runner";

export const handleUnsubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  const parsed = parseTargetArgs(args, { resolutionScope: "tracked" });
  if (args.trim().length === 0) {
    await ctx.replyToChat("Name the coins or preset to stop following, e.g. /unsubscribe USDC, or /unsubscribe all.");
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "missing_target",
    });
    return;
  }

  if (parsed.includeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    await ctx.replyToChat('Use /unsubscribe all by itself, or name coins and presets without "all".');
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
    await ctx.replyToChatWithMarkup(
      // The destructive scope is per-chat (direct subscriptions, preset
      // follows, global alert settings, snoozes), never the catalog size.
      "This will remove all coin subscriptions, preset follows, global alert settings and snoozes for this chat. Confirm?",
      { replyMarkup: buildBulkConfirmReplyMarkup({ kind: "unsubscribe" }, ctx.operationNowSec ?? unixNow()) },
    );
    return;
  }

  // /unsubscribe never creates a subscriber row, so it must not refresh the stored handle.
  await runFollowCommand(
    { ...ctx, username: null },
    parsed.tickers,
    { kind: "unsubscribe", presetIds: dedupePresetIds(parsed.presetIds) },
    "tracked",
  );
};
