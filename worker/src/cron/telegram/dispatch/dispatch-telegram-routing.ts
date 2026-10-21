import {
  formatConsolidatedMessage,
  buildAlertReplyMarkup,
  resolveAlertLinkPreviewOptions,
  splitMessage,
  type AlertVia,
  type ConsolidatedAlerts,
  type FewerBaseSettings,
} from "../../../telegram/common/alerts-formatting";
import type { BatchMessage } from "../../../telegram/delivery/telegram";
import {
  TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE,
} from "../../../telegram/common/constants";
import { TELEGRAM_ALERT_TTL_SEC } from "@shared/lib/telegram-delivery-policy";
import type { TelegramAlertType } from "@shared/types/status";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { buildPendingAlertScope, type PendingAlertScopeItem } from "../../../telegram/outbox/pending-provenance";

type AlertAppender<T> = (alerts: ConsolidatedAlerts) => T[];

/**
 * Priority used to pick the "dominant" type for a consolidated message.
 * Depeg fires on live price action and is the most operationally urgent,
 * followed by DEWS (stress), safety (grade movement), then reserve.
 * Used purely for delivery-metric attribution.
 */
const ALERT_TYPE_PRIORITY: readonly TelegramAlertType[] = ["depeg", "dews", "safety", "reserve"];

function dominantAlertType(alerts: ConsolidatedAlerts): TelegramAlertType {
  if (alerts.depegTriggered.length + alerts.depegResolved.length + alerts.depegWorsening.length > 0) {
    return "depeg";
  }
  if (alerts.dews.length > 0) return "dews";
  if (alerts.safety.length > 0) return "safety";
  if (alerts.reserve.length > 0) return "reserve";
  if ((alerts.freeze?.length ?? 0) > 0) return "freeze";
  // Fallback: an empty consolidated alert should not reach this path. Pick the
  // lowest-priority type so we never crash on metric attribution.
  return ALERT_TYPE_PRIORITY[ALERT_TYPE_PRIORITY.length - 1];
}

function alertTypesForConsolidated(alerts: ConsolidatedAlerts): TelegramAlertType[] {
  const types: TelegramAlertType[] = [];
  if (alerts.depegTriggered.length + alerts.depegResolved.length + alerts.depegWorsening.length > 0)
    types.push("depeg");
  if (alerts.dews.length > 0) types.push("dews");
  if (alerts.safety.length > 0) types.push("safety");
  if (alerts.reserve.length > 0) types.push("reserve");
  if ((alerts.freeze?.length ?? 0) > 0) types.push("freeze");
  return types;
}

export function strictestAlertTtlSec(alertTypes: readonly TelegramAlertType[]): number {
  if (alertTypes.length === 0) {
    throw new Error("Telegram alert type list cannot be empty");
  }
  return Math.min(...alertTypes.map((type) => TELEGRAM_ALERT_TTL_SEC[type]));
}

export interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  global_depeg_worsening_bps_step?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
  /** Persisted chat preference generation. Optional only for older fixtures/cache payloads. */
  preference_generation?: number;
  isGlobal: boolean;
  /** A settings/direct write explicitly owns this alert family's local policy. */
  hasLocalOverride?: boolean;
  /** Preset follows that routed this row (preset rows only), for the "Via" footer. */
  presetIds?: readonly string[];
}

export interface AlertsByChatEntry {
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
  timezone: string | null;
  preferenceGeneration?: number;
  /** Union of the follow sources that routed this chat's events. */
  via?: AlertVia;
  /** Routed depeg step / DEWS floor per `<family>:<coin>` for the Fewer button. */
  fewerBase?: Record<string, number | string | null>;
}

export interface RoutedSubscriberAlert {
  chatId: string;
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  /** Pre-split message body; chunks below are derived from this. */
  canonicalHtml: string;
  chunks: string[];
  disableNotification: boolean;
  alertType: TelegramAlertType;
  alertTypes?: readonly TelegramAlertType[];
  sourceEventId?: string;
  preferenceGeneration?: number;
  alertScope?: PendingAlertScopeItem[];
  safetyScoreIdentity?: SafetyScorePublicationIdentity;
  fewerBase?: FewerBaseSettings;
}

export function emptyAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    reserve: [],
    freeze: [],
  };
}

function addAlertToChat<T extends { stablecoinId: string }>(
  alertsByChat: Map<string, AlertsByChatEntry>,
  sub: SubscriberRow,
  append: AlertAppender<T>,
  event: T,
  family?: TelegramAlertType,
): void {
  const fewerBase = family === "depeg"
    ? sub.depeg_worsening_bps_step
    : family === "dews" ? sub.dews_min_band : undefined;
  const preferenceGeneration = Number.isFinite(sub.preference_generation)
    ? Math.max(0, Math.floor(sub.preference_generation ?? 0))
    : 0;
  const existing = alertsByChat.get(sub.chat_id);
  if (existing) {
    existing.lastActiveAt = Math.max(existing.lastActiveAt, sub.last_active_at);
    existing.preferenceGeneration = Math.min(existing.preferenceGeneration ?? 0, preferenceGeneration);
    existing.via = mergeAlertVia(existing.via, sub);
    if (fewerBase !== undefined) {
      existing.fewerBase ??= {};
      existing.fewerBase[`${family}:${event.stablecoinId}`] ??= fewerBase;
    }
    append(existing.alerts).push(event);
    return;
  }

  const alerts = emptyAlerts();
  append(alerts).push(event);
  alertsByChat.set(sub.chat_id, {
    lastActiveAt: sub.last_active_at,
    alerts,
    quietHoursEnabled: Boolean(sub.quiet_hours_enabled),
    quietHoursStartUtc: sub.quiet_hours_start_utc ?? null,
    quietHoursEndUtc: sub.quiet_hours_end_utc ?? null,
    timezone: sub.timezone ?? null,
    preferenceGeneration,
    via: mergeAlertVia(undefined, sub),
    ...(fewerBase !== undefined ? { fewerBase: { [`${family}:${event.stablecoinId}`]: fewerBase } } : {}),
  });
}

function mergeAlertVia(via: AlertVia | undefined, sub: SubscriberRow): AlertVia {
  const presetIds = new Set(via?.presetIds ?? []);
  for (const presetId of sub.presetIds ?? []) presetIds.add(presetId);
  return {
    presetIds: [...presetIds].sort(),
    watchlist: (via?.watchlist ?? false) || (!sub.isGlobal && (sub.presetIds?.length ?? 0) === 0),
    allStablecoins: (via?.allStablecoins ?? false) || sub.isGlobal,
  };
}

export function routeAlertEvents<T extends { stablecoinId: string }>(
  events: readonly T[],
  specificSubsByStablecoin: Map<string, SubscriberRow[]>,
  globalSubscribers: readonly SubscriberRow[],
  alertsByChat: Map<string, AlertsByChatEntry>,
  append: AlertAppender<T>,
  shouldInclude: (sub: SubscriberRow, event: T) => boolean = () => true,
  /**
   * Per-coin snooze map keyed by stablecoinId. Each chat in the inner set has
   * an active `telegram_subscriptions.alert_snooze_until_ts > now` for that
   * stablecoin and must be skipped for both the specific and the global pass
   * (P1-U10). Specific rows with active snooze are already filtered out by
   * the dispatcher's subscriber-row query; this map ensures a parallel global
   * subscription does not bypass the snooze.
   */
  perCoinSnoozedByStablecoin?: ReadonlyMap<string, ReadonlySet<string>>,
  perCoinDisabledByStablecoin?: ReadonlyMap<string, ReadonlySet<string>>,
  family?: TelegramAlertType,
): void {
  for (const event of events) {
    const specificSubscribers = specificSubsByStablecoin.get(event.stablecoinId) ?? [];
    const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
    const snoozedForEvent = perCoinSnoozedByStablecoin?.get(event.stablecoinId);
    const disabledForEvent = perCoinDisabledByStablecoin?.get(event.stablecoinId);

    for (const sub of specificSubscribers) {
      if (disabledForEvent?.has(sub.chat_id)) continue;
      if (snoozedForEvent?.has(sub.chat_id)) continue;
      if (!shouldInclude(sub, event)) continue;
      addAlertToChat(alertsByChat, sub, append, event, family);
    }

    for (const sub of globalSubscribers) {
      if (specificChatIds.has(sub.chat_id)) continue;
      if (disabledForEvent?.has(sub.chat_id)) continue;
      if (snoozedForEvent?.has(sub.chat_id)) continue;
      if (!shouldInclude(sub, event)) continue;
      addAlertToChat(alertsByChat, sub, append, event, family);
    }
  }
}

/**
 * One page candidate with a cheap chunk estimate, before HTML formatting.
 */
export interface PlannedSubscriberAlert {
  chatId: string;
  entry: AlertsByChatEntry;
  alertType: TelegramAlertType;
  alertTypes?: readonly TelegramAlertType[];
  sourceEventId?: string;
  safetyScoreIdentity?: SafetyScorePublicationIdentity;
  /** Cheap chunk-count estimate (no formatting); see `estimateChatChunks`. */
  estimatedChunks: number;
}

/** Total alert lines queued for one chat (cheap; no formatting). */
function countChatAlerts(alerts: ConsolidatedAlerts): number {
  return (
    alerts.dews.length +
    alerts.depegTriggered.length +
    alerts.depegResolved.length +
    alerts.depegWorsening.length +
    alerts.safety.length +
    alerts.reserve.length +
    (alerts.freeze?.length ?? 0)
  );
}

/**
 * Cheap, format-free estimate of how many message chunks a chat will produce,
 * mirroring the load-harness `ALERTS_PER_MESSAGE_CHUNK` model. Always >= 1.
 */
function estimateChatChunks(alerts: ConsolidatedAlerts): number {
  return Math.max(1, Math.ceil(countChatAlerts(alerts) / TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE));
}

/** Order page candidates newest-first and estimate chunks before formatting. */
export function planSubscriberQueue(
  alertsByChat: Map<string, AlertsByChatEntry>,
  sourceEventId?: string,
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null,
): PlannedSubscriberAlert[] {
  return [...alertsByChat.entries()]
    .map(([chatId, entry]) => ({
      chatId,
      entry,
      alertType: dominantAlertType(entry.alerts),
      alertTypes: alertTypesForConsolidated(entry.alerts),
      sourceEventId,
      ...(
        safetyScoreIdentity && entry.alerts.safety.length > 0
          ? { safetyScoreIdentity }
          : {}
      ),
      estimatedChunks: estimateChatChunks(entry.alerts),
    }))
    .sort((a, b) => b.entry.lastActiveAt - a.entry.lastActiveAt);
}

/** Format a single planned chat into a deliverable, split message (C102 phase 2). */
function formatPlannedSubscriber(
  plan: PlannedSubscriberAlert,
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean,
): RoutedSubscriberAlert {
  const canonicalHtml = formatConsolidatedMessage(plan.entry.alerts, { via: plan.entry.via ?? null });
  const routed: RoutedSubscriberAlert = {
    chatId: plan.chatId,
    lastActiveAt: plan.entry.lastActiveAt,
    alerts: plan.entry.alerts,
    canonicalHtml,
    chunks: splitMessage(canonicalHtml),
    disableNotification: resolveDisableNotification(plan.entry),
    alertType: plan.alertType,
    alertTypes: plan.alertTypes,
    ...(plan.entry.fewerBase ? { fewerBase: plan.entry.fewerBase } : {}),
  };
  if (plan.sourceEventId) {
    routed.sourceEventId = plan.sourceEventId;
    routed.preferenceGeneration = plan.entry.preferenceGeneration ?? 0;
    routed.alertScope = buildPendingAlertScope(plan.entry.alerts);
    if (plan.safetyScoreIdentity) {
      routed.safetyScoreIdentity = plan.safetyScoreIdentity;
    }
  }
  return routed;
}

/** Format an already-ordered slice of planned chats (C102 phase 2). */
export function formatPlannedSubscribers(
  planned: readonly PlannedSubscriberAlert[],
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean,
): RoutedSubscriberAlert[] {
  return planned.map((plan) => formatPlannedSubscriber(plan, resolveDisableNotification));
}

/**
 * Telegram chat-id convention: user IDs are positive integers and group/
 * supergroup/channel IDs are negative. Mini App `web_app` inline buttons are
 * rejected by Telegram outside private chats, so we use this heuristic to
 * decide whether `buildAlertReplyMarkup` may append the Mini App row.
 */
function isPrivateChatId(chatId: string): boolean {
  const parsed = Number(chatId);
  return Number.isFinite(parsed) && parsed > 0;
}

export function expandSubscriberChunks(
  subscribers: RoutedSubscriberAlert[],
  blockedChats: ReadonlySet<string> = new Set(),
): BatchMessage[] {
  const messages: BatchMessage[] = [];
  for (const sub of subscribers) {
    if (blockedChats.has(sub.chatId)) continue;
    const privateChat = isPrivateChatId(sub.chatId);
    for (const [chunkIndex, chunk] of sub.chunks.entries()) {
      // Single-coin alerts get a small link-preview card on the first chunk
      // (Bot API 7.0+). Multi-coin and overflow chunks fall back to the
      // batch-wide `disable_web_page_preview: true` default.
      const linkPreviewOptions = resolveAlertLinkPreviewOptions(sub.alerts, chunkIndex) ?? undefined;
      messages.push({
        chatId: sub.chatId,
        html: chunk,
        canonicalHtml: sub.canonicalHtml,
        disableNotification: sub.disableNotification,
        replyMarkup: buildAlertReplyMarkup(sub.alerts, chunkIndex, { privateChat, fewerBase: sub.fewerBase }),
        chunkIndex,
        ...((sub.alertTypes ?? [sub.alertType]).length === 1
          ? { alertType: (sub.alertTypes ?? [sub.alertType])[0] }
          : {}),
        ...(sub.sourceEventId && sub.preferenceGeneration != null && sub.alertScope
          ? {
              sourceEventId: sub.sourceEventId,
              preferenceGeneration: sub.preferenceGeneration,
              alertScope: sub.alertScope,
              ...(sub.safetyScoreIdentity
                ? { safetyScoreIdentity: sub.safetyScoreIdentity }
                : {}),
            }
          : {}),
        ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
      });
    }
  }
  return messages;
}
