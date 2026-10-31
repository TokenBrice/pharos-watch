import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  parseSubscribeArgs,
  resolveTicker,
  validateSubscribeArgs,
} from "../common/alerts-parser";
import { buildNotFoundMessage } from "../webhook/telegram-webhook-messages";
import { buildOnboardingKeyboard } from "../webhook/telegram-webhook-setup";
import type { WebhookCommandHandler } from "./context";
import {
  buildBulkConfirmMessage,
  buildBulkConfirmReplyMarkup,
  dedupePresetIds,
  runFollowCommand,
  subscribableCoinCount,
} from "./action-runner";
import { unixNow } from "../store/subscribers";

const RECOMMENDED_SUBSCRIBE_TYPES = ["dews", "depeg"] as const;
const SUBSCRIBE_PROMPT_PRIVATE = "What do you want to follow? Or type tickers, e.g. /subscribe USDC USDT";
const SUBSCRIBE_PROMPT_GROUP = "Type tickers or a preset, e.g. /subscribe@PharosWatchBot usd-top25";

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  if (!args.trim()) {
    // Menu taps send the bare command: offer the one-tap choices instead of a usage error.
    if (ctx.chatType === "private") {
      await ctx.replyToChatWithMarkup(escapeHtml(SUBSCRIBE_PROMPT_PRIVATE), { replyMarkup: buildOnboardingKeyboard() });
    } else {
      await ctx.replyToChat(escapeHtml(SUBSCRIBE_PROMPT_GROUP));
    }
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "validation",
      outcome: "prompted",
    });
    return;
  }
  const parsed = parseSubscribeArgs(args);
  const targetsOnly = parsed.alertTypes.size === 0 && parsed.invalidTargets.length === 0
    && (parsed.tickers.length > 0 || parsed.presetIds.length > 0 || parsed.subscribeAll);
  if (targetsOnly) for (const type of RECOMMENDED_SUBSCRIBE_TYPES) parsed.alertTypes.add(type);
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

  // Keep `undefined` when no depeg-step was typed so stored tuning survives.
  const depegStep = parsed.depegWorseningBpsStep;
  if (parsed.subscribeAll) {
    // Every tracked coin is a scope jump; ask once, statelessly.
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], [], depegStep),
      {
        replyMarkup: buildBulkConfirmReplyMarkup(
          { kind: "subscribe", alertTypes: parsed.alertTypes, depegStep },
          ctx.operationNowSec ?? unixNow(),
        ),
      },
    );
    return;
  }

  await runFollowCommand(ctx, parsed.tickers, {
    kind: "subscribe",
    alertTypes: parsed.alertTypes,
    depegStep,
    presetIds: dedupePresetIds(parsed.presetIds),
  });
};
