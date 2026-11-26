import { parseTargetArgs, resolveTicker, suggestClosestPreset } from "../common/alerts-parser";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import { buildNotFoundMessage, cmdForChat, followsNothing } from "../webhook/telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";
import { buildBulkConfirmReplyMarkup, dedupePresetIds, runFollowCommand } from "./action-runner";

export const handleUnsubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  const unsubCmd = cmdForChat("unsubscribe", ctx.chatType);
  const parsed = parseTargetArgs(args, { resolutionScope: "tracked" });
  if (args.trim().length === 0) {
    await ctx.replyToChat(`Name the coins or preset to stop following, e.g. ${unsubCmd} USDC, or ${unsubCmd} all.`);
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "validation",
      outcome: "failure",
      failureClass: "missing_target",
    });
    return;
  }

  if (parsed.includeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    await ctx.replyToChat(`Use ${unsubCmd} all by itself, or name coins and presets without "all".`);
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
    const presetSuggestion = suggestClosestPreset(invalidTarget);
    const match = presetSuggestion ? null : resolveTicker(invalidTarget, "tracked");
    const suggestion = presetSuggestion ?? (match?.status === "not_found" ? match.suggestion : undefined);
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
    const nowSec = ctx.operationNowSec ?? unixNow();
    const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
      loadSubscriberByChat(db, ctx.chatId),
      loadSubscriptionRowsByChat(db, ctx.chatId),
      loadPresetSubscriptions(db, ctx.chatId),
    ]);
    const hasActiveSnooze = (subscriber?.alert_snooze_until_ts ?? 0) > nowSec;
    if (
      followsNothing({ subscriber, subscriptions, presetSubscriptions })
      && subscriptions.length === 0
      && presetSubscriptions.length === 0
      && !hasActiveSnooze
    ) {
      await ctx.replyToChat("This chat doesn't follow any stablecoins.");
      return;
    }
    await ctx.replyToChatWithMarkup(
      // The destructive scope is per-chat (direct subscriptions, preset
      // follows, global alert settings, snoozes), never the catalog size.
      "This will remove all coin subscriptions, preset follows, global alert settings and snoozes for this chat. Confirm?",
      { replyMarkup: buildBulkConfirmReplyMarkup({ kind: "unsubscribe" }, nowSec) },
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
