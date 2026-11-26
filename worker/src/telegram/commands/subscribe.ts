import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  parseSubscribeArgs,
  resolveTicker,
  suggestAlertTypeTypo,
  suggestClosestPreset,
  validateSubscribeArgs,
} from "../common/alerts-parser";
import {
  GROUP_PRESET_ID_LIST,
  buildNotFoundMessage,
  cmdForChat,
} from "../webhook/telegram-webhook-messages";
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

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  const subCmd = cmdForChat("subscribe", ctx.chatType);
  if (!args.trim()) {
    // Menu taps send the bare command: offer the one-tap choices instead of a usage error.
    if (ctx.chatType === "private") {
      await ctx.replyToChatWithMarkup(escapeHtml(SUBSCRIBE_PROMPT_PRIVATE), { replyMarkup: buildOnboardingKeyboard() });
    } else {
      const groupPrompt = [
        `Type tickers or a preset, e.g. ${subCmd} usd-top25`,
        `Presets: ${GROUP_PRESET_ID_LIST}`,
      ].join("\n");
      await ctx.replyToChat(escapeHtml(groupPrompt));
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
    const isUnresolvedTargetError =
      parsed.invalidDepegWorseningBpsStep == null
      && (parsed.retiredAlertTypes?.length ?? 0) === 0
      && parsed.invalidTargets.length > 0
      && suggestAlertTypeTypo(parsed) == null;
    if (isUnresolvedTargetError) {
      const invalidTarget = parsed.invalidTargets[0];
      const presetSuggestion = suggestClosestPreset(invalidTarget);
      const tickerMatch = presetSuggestion ? null : resolveTicker(invalidTarget);
      const suggestion = presetSuggestion ?? (tickerMatch?.status === "not_found" ? tickerMatch.suggestion : undefined);
      await ctx.replyToChat(buildNotFoundMessage(invalidTarget, suggestion));
      await recordTelegramUsageEvent(db, {
        eventType: "subscribe",
        actionDetail: "validation",
        outcome: "failure",
        failureClass: "target_not_found",
      });
      return;
    }
    const addressedError = validationError.replace(/\/subscribe\b/g, subCmd);
    await ctx.replyToChat(escapeHtml(addressedError));
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
