/**
 * Coin resolution and apply step shared by /subscribe and /unsubscribe.
 * Unambiguous coins and presets apply at once; each ambiguous ticker gets a
 * stateless `pick:` keyboard. No pending row is written.
 */
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { TELEGRAM_ALERT_FAMILY_SHORT_LABELS } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import type { TelegramAlertType } from "@shared/types/status";
import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  resolveTicker,
  suggestClosestPreset,
  type ResolvedCoin,
  type TickerResolutionScope,
} from "../common/alerts-parser";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../common/presets";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../store/subscription-eligibility";
import {
  buildManageAlertsKeyboard,
  buildMiniAppOnlyKeyboard,
  buildNotFoundMessage,
  buildPresetSubscriptionSummaryMessage,
  buildPresetUnsubscribeSummaryMessage,
  buildPresetUnavailableMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeNoopKeyboard,
  buildUnsubscribeNoopMessage,
  buildUnsubscribeSuccessMessage,
  formatDepegStepPercent,
} from "../webhook/telegram-webhook-messages";
import { applySubscribeIntent, applyUnsubscribeIntent } from "../store/presets";
import { loadSubscriptionsByIds } from "../store/subscriptions";
import { dedupeCoins } from "../common/coin-dedupe";
import { BULK_CONFIRM_PREVIEW_LIMIT } from "../common/constants";
import { buildPickKeyboard, encodeSubscribeTypes, type DepegStepChoice, type PickAction } from "../callbacks/pick";
import type { WebhookCommandContext } from "./context";

/** Stateless confirm prompts stay valid this long after they are sent. */
export const BULK_CONFIRM_TTL_SEC = 15 * 60;

export function subscribableCoinCount(): number {
  return TELEGRAM_SUBSCRIBABLE_STABLECOINS.length;
}

/**
 * Confirm/Cancel for the chat-wide `all` scope. The callback data carries the
 * whole choice plus an expiry, so the tap needs no stored state.
 */
export function buildBulkConfirmReplyMarkup(
  choice: { kind: "subscribe"; alertTypes: ReadonlySet<string>; depegStep: DepegStepChoice } | { kind: "unsubscribe" },
  nowSec: number,
) {
  const expires = (nowSec + BULK_CONFIRM_TTL_SEC).toString(36);
  const data = choice.kind === "subscribe"
    ? `bulk:sa:${encodeSubscribeTypes(choice.alertTypes, choice.depegStep)}:${expires}`
    : `bulk:ua:${expires}`;
  const confirmLabel = choice.kind === "subscribe" ? "Follow all stablecoins" : "Remove all follows";
  return {
    inline_keyboard: [[
      { text: confirmLabel, callback_data: data },
      { text: "Cancel", callback_data: "bulk:no" },
    ]],
  };
}

export function buildBulkConfirmMessage(
  action: "subscribe" | "unsubscribe",
  count: number,
  alertTypes: readonly string[],
  coinSymbols: readonly string[],
  depegStep?: DepegStepChoice,
): string {
  const stepLine = depegStep === undefined
    ? ""
    : `; depeg step ${depegStep == null ? "off" : formatDepegStepPercent(depegStep)}`;
  const typesLine = action === "subscribe"
    ? `alert types ${escapeHtml(alertTypes.join(", ") || "all")}${stepLine}`
    : "all alert types";
  const head = coinSymbols.slice(0, BULK_CONFIRM_PREVIEW_LIMIT);
  const more = coinSymbols.length - head.length;
  const preview = head.length > 0 ? `\n${escapeHtml(`${head.join(", ")}${more > 0 ? `, and ${more} more` : ""}`)}` : "";
  if (action === "subscribe") {
    const rollupOnly = (TELEGRAM_ALERT_POLICY.rollupOnlyGlobalFamilies as readonly TelegramAlertType[])
      .filter((family) => alertTypes.includes(family))
      .map((family) => TELEGRAM_ALERT_FAMILY_SHORT_LABELS[family]);
    const rollupNote = rollupOnly.length > 0
      ? `\nGlobal ${escapeHtml(rollupOnly.join(" and "))} changes arrive in the daily Changes message rather than live.`
      : "";
    return `This follows every active stablecoin (${count} today, including new coins as Pharos adds them) for ${typesLine}.${rollupNote} Confirm?${preview}`;
  }
  return `This will ${action} ${count} coins for ${typesLine}. Confirm?${preview}`;
}

export function dedupePresetIds(presetIds: readonly string[]): TelegramPresetId[] {
  return Array.from(new Set(presetIds.filter((presetId): presetId is TelegramPresetId =>
    TELEGRAM_PRESET_LABEL_BY_ID.has(presetId as TelegramPresetId))));
}

type FollowRequest =
  | { kind: "subscribe"; alertTypes: Set<string>; depegStep: DepegStepChoice; presetIds: TelegramPresetId[] }
  | { kind: "unsubscribe"; presetIds: TelegramPresetId[] };

/**
 * Resolves `tickers`, applies every unambiguous coin plus the presets in one
 * mutation, then offers pick buttons for each ambiguous ticker. A ticker that
 * matches nothing stops the command before anything is written.
 */
export async function runFollowCommand(
  ctx: WebhookCommandContext,
  tickers: readonly string[],
  request: FollowRequest,
  scope: TickerResolutionScope = "subscribable",
): Promise<void> {
  const coins: ResolvedCoin[] = [];
  const ambiguous: Array<{ ticker: string; candidates: ResolvedCoin[] }> = [];
  for (const ticker of tickers) {
    const resolution = resolveTicker(ticker, scope);
    if (resolution.status === "not_found") {
      const suggestion = suggestClosestPreset(ticker) ?? resolution.suggestion;
      await ctx.replyToChat(buildNotFoundMessage(ticker, suggestion));
      await recordTelegramUsageEvent(ctx.db, {
        eventType: request.kind,
        actionDetail: "validation",
        outcome: "failure",
        failureClass: "target_not_found",
      });
      return;
    }
    if (resolution.status === "ambiguous") ambiguous.push({ ticker, candidates: resolution.matches });
    else coins.push(...resolution.matches);
  }
  const directCoins = dedupeCoins(coins);

  if (directCoins.length > 0 || request.presetIds.length > 0) {
    const result = await applyFollowRequest(ctx, directCoins, request);
    if (result.replyMarkup) {
      await ctx.replyToChatWithMarkup(result.text, { replyMarkup: result.replyMarkup });
    } else {
      await ctx.replyToChat(result.text);
    }
  }

  const pickAction: PickAction = request.kind === "subscribe"
    ? { kind: "subscribe", alertTypes: request.alertTypes, depegStep: request.depegStep }
    : { kind: "unsubscribe" };
  for (const { ticker, candidates } of ambiguous) {
    const keyboard = buildPickKeyboard(pickAction, ticker, candidates);
    const message = `"${escapeHtml(ticker)}" matches ${candidates.length} coins.`;
    if (keyboard) await ctx.replyToChatWithMarkup(`${message} Which one?`, { replyMarkup: keyboard });
    else await ctx.replyToChat(`${message} Send the exact Pharos coin id instead.`);
  }
}

/** The requested coins that currently have a direct row for this chat. */
async function loadDirectlyFollowedCoins(
  db: D1Database,
  chatId: string,
  coins: readonly ResolvedCoin[],
): Promise<ResolvedCoin[]> {
  if (coins.length === 0) return [];
  const rows = await loadSubscriptionsByIds(db, chatId, coins.map((coin) => coin.id));
  const followedIds = new Set(rows.map((row) => row.stablecoin_id));
  return coins.filter((coin) => followedIds.has(coin.id));
}

async function applyFollowRequest(
  ctx: WebhookCommandContext,
  coins: readonly ResolvedCoin[],
  request: FollowRequest,
): Promise<{ text: string; replyMarkup?: unknown }> {
  const coinIds = coins.map((coin) => coin.id);
  // Presets are never copied into direct rows, so only a coin with an existing
  // direct row can be removed by this command. The reply reports that removal
  // evidence rather than the requested tickers.
  const removedCoins = request.kind === "unsubscribe"
    ? await loadDirectlyFollowedCoins(ctx.db, ctx.chatId, coins)
    : [];
  const resolvedPresets = request.presetIds.length > 0
    ? await resolveTelegramPresetTargets(ctx.db, request.presetIds)
    : null;
  if (resolvedPresets?.kind === "error" && request.kind === "subscribe") {
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "subscribe",
      actionDetail: "preset",
      outcome: "failure",
      failureClass: "preset_unavailable",
    });
    return { text: buildPresetUnavailableMessage() };
  }
  const presetCoinCount = resolvedPresets?.kind === "ok"
    ? dedupeCoins(resolvedPresets.presets.flatMap((preset) => preset.coins)).length
    : null;

  if (request.kind === "subscribe") {
    await applySubscribeIntent(ctx.db, {
      chatId: ctx.chatId,
      username: ctx.username,
      alertTypes: request.alertTypes,
      directStablecoinIds: coinIds,
      presetIds: request.presetIds,
      depegWorseningBpsStep: request.depegStep,
    });
  } else {
    await applyUnsubscribeIntent(ctx.db, {
      chatId: ctx.chatId,
      directStablecoinIds: coinIds,
      presetIds: request.presetIds,
    });
  }

  const presetEvent = request.kind === "subscribe" ? "preset_follow" : "preset_unfollow";
  if (request.presetIds.length > 0) {
    await recordTelegramUsageEvent(ctx.db, { eventType: presetEvent, actionDetail: "preset", outcome: "success" });
  }
  await recordTelegramUsageEvent(ctx.db, {
    eventType: request.kind,
    actionDetail: request.presetIds.length > 0 ? "preset" : "coin",
    outcome: "success",
  });

  if (request.kind === "unsubscribe") {
    if (request.presetIds.length > 0) {
      return {
        text: buildPresetUnsubscribeSummaryMessage(removedCoins, {
          presetIds: request.presetIds,
          presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
          chatType: ctx.chatType,
        }),
      };
    }
    if (removedCoins.length > 0) {
      return { text: buildUnsubscribeSuccessMessage(removedCoins) };
    }
    return {
      text: buildUnsubscribeNoopMessage([...coins], ctx.chatType),
      replyMarkup: buildUnsubscribeNoopKeyboard(coins, ctx.chatType),
    };
  }
  const subscriptions = await loadSubscriptionsByIds(ctx.db, ctx.chatId, coinIds);
  const text = request.presetIds.length > 0
    ? buildPresetSubscriptionSummaryMessage(subscriptions, {
        presetIds: request.presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        presetCoinCount: presetCoinCount ?? 0,
        chatType: ctx.chatType,
      })
    : buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
  const replyMarkup = ctx.chatType === "private"
    ? (coins.length === 1 && request.presetIds.length === 0
        ? buildMiniAppOnlyKeyboard(`Manage ${coins[0]!.symbol}`, formatCoinPayload(coins[0]!.id))
        : buildManageAlertsKeyboard("home"))
    : undefined;
  return { text, replyMarkup };
}
