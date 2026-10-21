import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  parseSubscribeArgs,
  resolveTicker,
  validateSubscribeArgs,
} from "../common/alerts-parser";
import { buildNotFoundMessage } from "../webhook/telegram-webhook-messages";
import { PENDING_OWNERSHIP_CONFLICT_MESSAGE } from "../store/telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  buildBulkConfirmReplyMarkup,
  buildBulkConfirmMessage,
  dedupePresetIds,
  buildTelegramActionContext,
  makeActionRunner,
  persistBulkConfirmPrompt,
  subscribableCoinCount,
} from "./action-runner";

const RECOMMENDED_SUBSCRIBE_TYPES = ["dews", "depeg"] as const;
const SUBSCRIBE_PROMPT_MESSAGE =
  "Tap below for guided setup, or type /subscribe dews USDC. "
  + "Without alert types, /subscribe &lt;ticker&gt; follows DEWS and depeg alerts.";

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db } = ctx;
  const actionContext = buildTelegramActionContext(ctx);
  const parsed = parseSubscribeArgs(args);
  if (!args.trim()) {
    // Menu taps send the bare command: point at guided setup instead of a usage error.
    await ctx.replyToChatWithMarkup(SUBSCRIBE_PROMPT_MESSAGE, {
      replyMarkup: {
        inline_keyboard: [[{ text: "Set up alerts", url: `${TELEGRAM_BOT_URL}?start=setup` }]],
      },
    });
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "validation",
      outcome: "prompted",
    });
    return;
  }
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
      clearPending: ctx.clearPendingOnMutation,
    });
    if (!persisted) {
      await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return;
    }
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], []),
      { replyMarkup: buildBulkConfirmReplyMarkup(persisted) },
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
