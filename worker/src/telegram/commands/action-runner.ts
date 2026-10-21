/**
 * Coin resolution and apply step shared by /subscribe and /unsubscribe.
 * Unambiguous coins and presets apply at once; each ambiguous ticker gets a
 * stateless `pick:` keyboard. No pending row is written.
 */
import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { resolveTicker, type ResolvedCoin, type TickerResolutionScope } from "../common/alerts-parser";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../common/presets";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../store/subscription-eligibility";
import {
  buildNotFoundMessage,
  buildPresetSubscriptionSummaryMessage,
  buildPresetUnsubscribeSummaryMessage,
  buildPresetUnavailableMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
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
  return {
    inline_keyboard: [[
      { text: "Confirm", callback_data: data },
      { text: "Cancel", callback_data: "bulk:no" },
    ]],
  };
}

export function buildBulkConfirmMessage(
  action: "subscribe" | "unsubscribe",
  count: number,
  alertTypes: readonly string[],
  coinSymbols: readonly string[],
): string {
  const typesLine = action === "subscribe" ? `alert types ${escapeHtml(alertTypes.join(", ") || "all")}` : "all alert types";
  const head = coinSymbols.slice(0, BULK_CONFIRM_PREVIEW_LIMIT);
  const more = coinSymbols.length - head.length;
  const preview = head.length > 0 ? `\n${escapeHtml(`${head.join(", ")}${more > 0 ? `, and ${more} more` : ""}`)}` : "";
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
      await ctx.replyToChat(buildNotFoundMessage(ticker, resolution.suggestion));
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
    const reply = await applyFollowRequest(ctx, directCoins, request);
    await ctx.replyToChat(reply);
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

async function applyFollowRequest(
  ctx: WebhookCommandContext,
  coins: readonly ResolvedCoin[],
  request: FollowRequest,
): Promise<string> {
  const coinIds = coins.map((coin) => coin.id);
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
    return buildPresetUnavailableMessage();
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
      clearPending: ctx.clearPendingOnMutation,
    });
  } else {
    await applyUnsubscribeIntent(ctx.db, {
      chatId: ctx.chatId,
      directStablecoinIds: coinIds,
      presetIds: request.presetIds,
      clearPending: ctx.clearPendingOnMutation,
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
    return request.presetIds.length > 0
      ? buildPresetUnsubscribeSummaryMessage([...coins], { presetIds: request.presetIds, presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID })
      : buildUnsubscribeSuccessMessage([...coins]);
  }
  const subscriptions = await loadSubscriptionsByIds(ctx.db, ctx.chatId, coinIds);
  return request.presetIds.length > 0
    ? buildPresetSubscriptionSummaryMessage(subscriptions, {
        presetIds: request.presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        presetCoinCount: presetCoinCount ?? 0,
      })
    : buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
}
