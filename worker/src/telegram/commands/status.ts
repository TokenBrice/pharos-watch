import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { escapeHtml } from "../delivery/telegram";
import { TELEGRAM_PRESET_LABEL_BY_ID, resolveTelegramPresetTargets, type TelegramPresetId } from "../common/presets";
import {
  buildCoinStatusKeyboard,
  buildManageAlertsKeyboard,
  buildStatusMessage,
  describeDeliveryState,
  describeFollows,
  followsNothing,
  formatElapsed,
} from "../webhook/telegram-webhook-messages";
import { loadActiveDepegs, loadStatusForCoin, type ActiveDepeg } from "../webhook/telegram-webhook-status";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import { loadTelegramChatHealthDiagnostics } from "../store/usage-analytics";
import { buildOnboardingKeyboard } from "../webhook/telegram-webhook-setup";
import type { PresetSubscriptionRow, SubscriberRow, SubscriptionRow } from "../webhook/telegram-webhook-shared";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

const MAX_LISTED_DEPEGS = 3;

/** `/status` alone is the chat card; `/status <ticker>` is one coin. */
export const handleStatus: WebhookCommandHandler = async (ctx, args) => {
  if (!args.trim()) {
    await replyWithChatStatus(ctx);
    return;
  }
  const coin = await resolveSingleStatusTarget(ctx, args);
  if (!coin) return;
  const status = await loadStatusForCoin(ctx.db, coin.id);
  const replyMarkup = buildCoinStatusKeyboard(coin.id, coin.symbol, { includeMiniAppButton: ctx.chatType === "private" });
  await ctx.replyToChatWithMarkup(buildStatusMessage(coin.symbol, status), replyMarkup ? { replyMarkup } : {});
};

async function replyWithChatStatus(ctx: WebhookCommandContext): Promise<void> {
  const nowSec = ctx.operationNowSec ?? unixNow();
  const isPrivate = ctx.chatType === "private";
  const [subscriber, subscriptions, presetSubscriptions, diagnosticsRead] = await Promise.all([
    loadSubscriberByChat(ctx.db, ctx.chatId),
    loadSubscriptionRowsByChat(ctx.db, ctx.chatId),
    loadPresetSubscriptions(ctx.db, ctx.chatId),
    // Diagnostics only feed the "Last alert delivered" line; a failed read drops that line.
    loadTelegramChatHealthDiagnostics(ctx.db, ctx.chatId),
  ]);
  if (followsNothing({ subscriber, subscriptions, presetSubscriptions })) {
    const message = "You don't follow any stablecoins yet.";
    if (isPrivate) await ctx.replyToChatWithMarkup(message, { replyMarkup: buildOnboardingKeyboard() });
    else await ctx.replyToChat(`${message} Admins can start with /subscribe@PharosWatchBot usd-top25.`);
    return;
  }

  const lines = [
    "<b>Your alerts</b>",
    ...(subscriber?.alert_snooze_until_ts != null && subscriber.alert_snooze_until_ts > nowSec ? [] : ["Alerts are on."]),
    ...describeDeliveryState(subscriber, nowSec),
    ...describeFollows({ subscriber, subscriptions, presetSubscriptions, presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID, nowSec }),
  ];
  const depegLine = await describeFollowedDepegs(ctx.db, subscriber, subscriptions, presetSubscriptions);
  if (depegLine) lines.push(depegLine);
  const diagnostics = diagnosticsRead.available ? diagnosticsRead.diagnostics : null;
  if (diagnostics?.lastSuccessfulDeliveryAt != null) {
    lines.push(`Last alert delivered ${escapeHtml(formatElapsed(diagnostics.lastSuccessfulDeliveryAt, nowSec))}.`);
  }
  const message = lines.join("\n");
  if (isPrivate) await ctx.replyToChatWithMarkup(message, { replyMarkup: buildManageAlertsKeyboard() });
  else await ctx.replyToChat(message);
}

/**
 * Open depegs among the coins this chat gets depeg or stress alerts for. Any
 * failed read (depeg events or preset membership) drops the line rather than
 * claiming no coin is off peg.
 */
async function describeFollowedDepegs(
  db: D1Database,
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
  presetSubscriptions: PresetSubscriptionRow[],
): Promise<string | null> {
  const followsAll = Boolean(subscriber?.global_alert_depeg || subscriber?.global_alert_dews);
  const followed = new Set<string>();
  if (!followsAll) {
    const presetIds = presetSubscriptions
      .filter((row) => row.alert_depeg || row.alert_dews)
      .map((row) => row.preset_id as TelegramPresetId);
    if (presetIds.length > 0) {
      const resolved = await resolveTelegramPresetTargets(db, presetIds);
      if (resolved.kind !== "ok") return null;
      for (const preset of resolved.presets) for (const id of preset.stablecoinIds) followed.add(id);
    }
    for (const row of subscriptions) {
      if (row.alert_depeg || row.alert_dews) followed.add(row.stablecoin_id);
      else if (row.alert_depeg_override || row.alert_dews_override) followed.delete(row.stablecoin_id);
    }
  }
  const depegs = await loadActiveDepegs(db);
  if (depegs == null) return null;
  const mine = depegs.filter((depeg) => followsAll || followed.has(depeg.stablecoinId));
  if (mine.length === 0) return "No coin you follow is off peg right now.";
  const shown = mine.slice(0, MAX_LISTED_DEPEGS).map(formatDepeg).join(", ");
  const more = mine.length > MAX_LISTED_DEPEGS ? `, and ${mine.length - MAX_LISTED_DEPEGS} more` : "";
  return `<b>Off peg now:</b> ${escapeHtml(shown)}${more}`;
}

function formatDepeg(depeg: ActiveDepeg): string {
  const symbol = TRACKED_META_BY_ID.get(depeg.stablecoinId)?.symbol ?? depeg.stablecoinId;
  return `${symbol} (peak ${(Math.abs(depeg.peakDeviationBps) / 100).toFixed(1)}% ${depeg.direction})`;
}
