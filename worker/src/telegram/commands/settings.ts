import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { escapeHtml } from "../delivery/telegram";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import { resolveTicker } from "../common/alerts-parser";
import { TELEGRAM_PRESET_LABEL_BY_ID } from "../common/presets";
import { isSubscribableCoin } from "../store/subscription-eligibility";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat, loadSubscriptionsByIds } from "../store/subscriptions";
import {
  buildManageAlertsKeyboard,
  buildMiniAppOnlyKeyboard,
  buildNotFoundMessage,
  buildStatusAmbiguousMessage,
  describeDeliveryState,
  describeFollows,
  describeSubscriptionSettings,
  followsNothing,
} from "../webhook/telegram-webhook-messages";
import { handleSettingsCommand } from "../webhook/telegram-webhook-settings";
import type { WebhookCommandHandler } from "./context";

const MAX_PRIVATE_SETTINGS_DISAMBIGUATION = 8;

/**
 * Private chats hand settings off to the Mini App (resolving `/settings <ticker>`
 * directly to `coin_<id>`); groups (no Mini App) keep the inline settings keyboard.
 */
export const handleSettings: WebhookCommandHandler = async (ctx, args) => {
  if (ctx.chatType !== "private") {
    await handleSettingsCommand(ctx.db, ctx.botToken, ctx.chatId, ctx.username, args, {
      includeMiniAppButton: false,
      chatType: ctx.chatType,
    });
    return;
  }
  const nowSec = ctx.operationNowSec ?? unixNow();
  const trimmed = args.trim();
  if (trimmed.length > 0) {
    const resolution = resolveTicker(trimmed, "tracked");
    if (resolution.status === "not_found") {
      await ctx.replyToChat(buildNotFoundMessage(trimmed, resolution.suggestion));
      return;
    }
    if (resolution.status === "ambiguous") {
      const subscribable = resolution.matches.filter((coin) => isSubscribableCoin(coin.id));
      if (subscribable.length === 0) {
        await ctx.replyToChat(escapeHtml(`${resolution.matches[0]!.symbol} is not active for alerts.`));
        return;
      }
      if (subscribable.length > 1) {
        if (subscribable.length <= MAX_PRIVATE_SETTINGS_DISAMBIGUATION) {
          await ctx.replyToChatWithMarkup(
            `"${escapeHtml(trimmed)}" matches ${subscribable.length} coins. Which one?`,
            {
              replyMarkup: {
                inline_keyboard: subscribable.map((coin) => [{
                  text: `Manage ${coin.symbol} · ${coin.name}`,
                  web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(coin.id)) },
                }]),
              },
            },
          );
          return;
        }
        await ctx.replyToChat(buildStatusAmbiguousMessage(trimmed, subscribable, "/settings"));
        return;
      }
      const coin = subscribable[0]!;
      await replyPrivateCoinSettings(ctx, coin.id, coin.symbol, nowSec);
      return;
    }
    const coin = resolution.matches[0]!;
    if (!isSubscribableCoin(coin.id)) {
      await ctx.replyToChat(escapeHtml(`${coin.symbol} is not active for alerts.`));
      return;
    }
    await replyPrivateCoinSettings(ctx, coin.id, coin.symbol, nowSec);
    return;
  }

  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(ctx.db, ctx.chatId),
    loadSubscriptionRowsByChat(ctx.db, ctx.chatId),
    loadPresetSubscriptions(ctx.db, ctx.chatId),
  ]);
  const summary = followsNothing({ subscriber, subscriptions, presetSubscriptions })
    ? ["You don't follow any stablecoins yet."]
    : [
        ...describeFollows({
          subscriber,
          subscriptions,
          presetSubscriptions,
          presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
          nowSec,
          chatType: ctx.chatType,
        }),
        ...describeDeliveryState(subscriber, nowSec, ctx.chatType),
      ];
  await ctx.replyToChatWithMarkup(
    ["<b>Alert settings</b>", ...summary, "Add coins, set quiet hours or pause in Manage Alerts."].join("\n"),
    { replyMarkup: buildManageAlertsKeyboard("settings") },
  );
};

async function replyPrivateCoinSettings(
  ctx: Parameters<WebhookCommandHandler>[0],
  coinId: string,
  symbol: string,
  nowSec: number,
): Promise<void> {
  const rows = await loadSubscriptionsByIds(ctx.db, ctx.chatId, [coinId]);
  const row = rows[0];
  const line = row
    ? `${escapeHtml(symbol)}: ${escapeHtml(describeSubscriptionSettings(row, nowSec))}`
    : `${escapeHtml(symbol)} is not followed directly yet.`;
  await ctx.replyToChatWithMarkup(
    [`<b>${escapeHtml(symbol)} settings</b>`, line, `Open Manage ${escapeHtml(symbol)} to edit alerts.`].join("\n"),
    { replyMarkup: buildMiniAppOnlyKeyboard(`Manage ${symbol}`, formatCoinPayload(coinId)) },
  );
}
