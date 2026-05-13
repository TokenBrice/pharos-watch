import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildGlobalAlertSummaryMessage } from "../telegram-webhook-messages";
import { parseSetCommand } from "../telegram-webhook-parsing";
import {
  applyGlobalSetting,
  loadSubscriberByChat,
  validateGlobalSetCommand,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import { makeActionRunner } from "./action-runner";

export const handleSet: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username, actorUserId } = ctx;
  const parsed = parseSetCommand(args);
  if ("error" in parsed) {
    await ctx.replyToChat(escapeHtml(parsed.error));
    return;
  }

  if (parsed.ticker.toLowerCase() === "all") {
    const globalError = validateGlobalSetCommand(parsed);
    if (globalError) {
      await ctx.replyToChat(escapeHtml(globalError));
      return;
    }
    await applyGlobalSetting(db, chatId, username, parsed);
    await recordTelegramUsageEvent(db, {
      eventType: "global_alert_change",
      actionDetail: parsed.setting,
      outcome: parsed.enabled ? "opt_in" : "opt_out",
    });
    const subscriber = await loadSubscriberByChat(db, chatId);
    await ctx.replyToChat(buildGlobalAlertSummaryMessage("Updated all-stablecoin alerts.", subscriber));
    return;
  }

  const runAction = makeActionRunner({ db, chatId, username, initiatorUserId: actorUserId }, ctx.botToken);
  await runAction({ tickers: [parsed.ticker], actionType: "set", actionPayload: parsed });
};
