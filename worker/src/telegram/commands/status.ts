import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { escapeHtml } from "../delivery/telegram";
import { TELEGRAM_PRESET_LABEL_BY_ID, resolveTelegramPresetTargets, type TelegramPresetId } from "../common/presets";
import { isGroupChatType } from "../webhook/telegram-webhook-auth";
import {
  buildCoinStatusKeyboard,
  buildManageAlertsKeyboard,
  buildStatusMessage,
  cmdForChat,
  describeDeliveryState,
  describeFollowsCompact,
  followsNothing,
  formatElapsed,
} from "../webhook/telegram-webhook-messages";
import { loadActiveDepegs, loadCoinDirectFollowState, loadStatusForCoin, type ActiveDepeg } from "../webhook/telegram-webhook-status";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import { loadTelegramChatHealthDiagnostics } from "../store/usage-analytics";
import { buildOnboardingKeyboard } from "../webhook/telegram-webhook-setup";
import type { PresetSubscriptionRow, SubscriberRow, SubscriptionRow } from "../webhook/telegram-webhook-shared";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

const MAX_LISTED_DEPEGS = 3;

/** `/status` alone is the compact chat card; `/status <ticker>` is one coin. */
export const handleStatus: WebhookCommandHandler = async (ctx, args) => {
  if (!args.trim()) {
    await replyWithChatStatus(ctx);
    return;
  }
  const coin = await resolveSingleStatusTarget(ctx, args);
  if (!coin) return;
  const [status, directFollow] = await Promise.all([
    loadStatusForCoin(ctx.db, coin.id),
    loadCoinDirectFollowState(ctx.db, ctx.chatId, coin.id),
  ]);
  const replyMarkup = buildCoinStatusKeyboard(coin.id, coin.symbol, {
    includeMiniAppButton: ctx.chatType === "private",
    isGroup: isGroupChatType(ctx.chatType),
    alreadyFollowed: directFollow.available && directFollow.followed,
  });
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
    else await ctx.replyToChat(`${message} Admins can start with ${cmdForChat("subscribe", ctx.chatType)} usd-top25.`);
    return;
  }

  const lines = [
    "<b>Your alerts</b>",
    ...(subscriber?.alert_snooze_until_ts != null && subscriber.alert_snooze_until_ts > nowSec ? [] : ["Alerts are on."]),
    ...describeDeliveryState(subscriber, nowSec, ctx.chatType),
    ...describeFollowsCompact({
      subscriber,
      subscriptions,
      presetSubscriptions,
      presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
      nowSec,
      chatType: ctx.chatType,
    }),
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
 * Open depegs among the coins this chat gets depeg or DEWS alerts for.
 * Evaluates depeg and DEWS separately with per-family override markers
 * (including against global follows), then takes their union. Any failed read
 * (depeg events or preset membership) drops the line rather than claiming no
 * coin is off peg.
 */
async function describeFollowedDepegs(
  db: D1Database,
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
  presetSubscriptions: PresetSubscriptionRow[],
): Promise<string | null> {
  const globalDepeg = Boolean(subscriber?.global_alert_depeg);
  const globalDews = Boolean(subscriber?.global_alert_dews);
  const depegPresetIds = globalDepeg
    ? []
    : presetSubscriptions.filter((row) => row.alert_depeg).map((row) => row.preset_id as TelegramPresetId);
  const dewsPresetIds = globalDews
    ? []
    : presetSubscriptions.filter((row) => row.alert_dews).map((row) => row.preset_id as TelegramPresetId);
  const uniquePresetIds = Array.from(new Set([...depegPresetIds, ...dewsPresetIds]));
  const depegPresetCoins = new Set<string>();
  const dewsPresetCoins = new Set<string>();
  if (uniquePresetIds.length > 0) {
    const resolved = await resolveTelegramPresetTargets(db, uniquePresetIds);
    if (resolved.kind !== "ok") return null;
    const depegPresetSet = new Set(depegPresetIds);
    const dewsPresetSet = new Set(dewsPresetIds);
    for (const preset of resolved.presets) {
      if (depegPresetSet.has(preset.definition.id)) {
        for (const id of preset.stablecoinIds) depegPresetCoins.add(id);
      }
      if (dewsPresetSet.has(preset.definition.id)) {
        for (const id of preset.stablecoinIds) dewsPresetCoins.add(id);
      }
    }
  }
  const directById = new Map(subscriptions.map((row) => [row.stablecoin_id, row]));
  const isCoveredForFamily = (
    coinId: string,
    family: "depeg" | "dews",
    globalOn: boolean,
    presetCoins: ReadonlySet<string>,
  ): boolean => {
    const row = directById.get(coinId);
    if (row) {
      const enabled = family === "depeg" ? row.alert_depeg === 1 : row.alert_dews === 1;
      const overridden = family === "depeg" ? row.alert_depeg_override === 1 : row.alert_dews_override === 1;
      if (enabled) return true;
      if (overridden) return false;
    }
    return globalOn || presetCoins.has(coinId);
  };

  const depegs = await loadActiveDepegs(db);
  if (depegs == null) return null;
  const mine = depegs.filter(
    (depeg) =>
      isCoveredForFamily(depeg.stablecoinId, "depeg", globalDepeg, depegPresetCoins)
      || isCoveredForFamily(depeg.stablecoinId, "dews", globalDews, dewsPresetCoins),
  );
  if (mine.length === 0) return "No coin you follow is off peg right now.";
  const shown = mine.slice(0, MAX_LISTED_DEPEGS).map(formatDepeg).join(", ");
  const more = mine.length > MAX_LISTED_DEPEGS ? `, and ${mine.length - MAX_LISTED_DEPEGS} more` : "";
  return `<b>${mine.some((depeg) => depeg.peerRelative || depeg.peerOpening || depeg.peakBasisUnavailable) ? "Active incidents" : "Off peg now"}:</b> ${escapeHtml(shown)}${more}`;
}

function formatDepeg(depeg: ActiveDepeg): string {
  const symbol = TRACKED_META_BY_ID.get(depeg.stablecoinId)?.symbol ?? depeg.stablecoinId;
  const opening = depeg.peerOpening && !depeg.peerRelative ? "peer-relative opening, lower confidence; " : "";
  if (depeg.peakBasisUnavailable) return `${symbol} (${opening}peak comparison unavailable)`;
  return `${symbol} (${opening}peak ${(Math.abs(depeg.peakDeviationBps) / 100).toFixed(1)}% ${depeg.direction}${depeg.peerRelative ? " peer median, lower confidence" : depeg.peerOpening ? " peg" : ""})`;
}
