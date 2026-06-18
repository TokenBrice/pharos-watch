import {
  formatConsolidatedMessage,
  buildAlertReplyMarkup,
  resolveAlertLinkPreviewOptions,
  splitMessage,
  type ConsolidatedAlerts,
} from "../lib/telegram-alerts";
import { sendBatch, type BatchMessage, type BatchResult } from "../lib/telegram";
import {
  SEND_BATCH_SIZE,
  buildDedupeKey,
  clearPendingAlertsForDisabledChat,
  handleBlockedChat,
  resetChatOnSuccess,
} from "./telegram-pending";
import { throwIfAborted } from "../lib/abort";
import { recordTelegramDeliveryOutcomes } from "../lib/telegram-usage-analytics";
import type {
  PerAlertTypeDelivery,
  PerAlertTypeDeliveryStats,
  TelegramAlertType,
} from "@shared/types/status";

type AlertAppender<T> = (alerts: ConsolidatedAlerts) => T[];

/**
 * Priority used to pick the "dominant" type for a consolidated message.
 * Depeg fires on live price action and is the most operationally urgent,
 * followed by DEWS (stress), safety (grade movement), then launch (info).
 * Used purely for delivery-metric attribution.
 */
const ALERT_TYPE_PRIORITY: readonly TelegramAlertType[] = ["depeg", "dews", "safety", "launch"];

function emptyPerAlertTypeStats(): PerAlertTypeDeliveryStats {
  return { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null };
}

export function emptyPerAlertTypeDelivery(): PerAlertTypeDelivery {
  return {
    dews: emptyPerAlertTypeStats(),
    depeg: emptyPerAlertTypeStats(),
    safety: emptyPerAlertTypeStats(),
    launch: emptyPerAlertTypeStats(),
  };
}

function dominantAlertType(alerts: ConsolidatedAlerts): TelegramAlertType {
  if (alerts.depegTriggered.length + alerts.depegResolved.length + alerts.depegWorsening.length > 0) {
    return "depeg";
  }
  if (alerts.dews.length > 0) return "dews";
  if (alerts.safety.length > 0) return "safety";
  if (alerts.launch.length > 0) return "launch";
  // Fallback: an empty consolidated alert should not reach this path. Pick the
  // lowest-priority type so we never crash on metric attribution.
  return ALERT_TYPE_PRIORITY[ALERT_TYPE_PRIORITY.length - 1];
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
  isGlobal: boolean;
}

export interface AlertsByChatEntry {
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
  timezone: string | null;
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
}

export interface FreshSendOutcome {
  subscribersNotified: number;
  freshAttempted: number;
  freshSent: number;
  freshPermanentFailures: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  blockedChats: Set<string>;
  retryableFreshMessages: Array<{ message: BatchMessage; result: BatchResult }>;
  perAlertType: PerAlertTypeDelivery;
  targetStatusUpdates: Array<{
    targetKey: string;
    status: "queued" | "sent" | "failed" | "expired";
    at: number;
    errorClass?: string | null;
  }>;
}

function emptyAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
  };
}

function addAlertToChat<T>(
  alertsByChat: Map<string, AlertsByChatEntry>,
  sub: SubscriberRow,
  append: AlertAppender<T>,
  event: T,
): void {
  const existing = alertsByChat.get(sub.chat_id);
  if (existing) {
    existing.lastActiveAt = Math.max(existing.lastActiveAt, sub.last_active_at);
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
  });
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
      addAlertToChat(alertsByChat, sub, append, event);
    }

    for (const sub of globalSubscribers) {
      if (specificChatIds.has(sub.chat_id)) continue;
      if (disabledForEvent?.has(sub.chat_id)) continue;
      if (snoozedForEvent?.has(sub.chat_id)) continue;
      if (!shouldInclude(sub, event)) continue;
      addAlertToChat(alertsByChat, sub, append, event);
    }
  }
}

export function buildSubscriberQueue(
  alertsByChat: Map<string, AlertsByChatEntry>,
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean,
): RoutedSubscriberAlert[] {
  return [...alertsByChat.entries()]
    .map(([chatId, entry]) => {
      const canonicalHtml = formatConsolidatedMessage(entry.alerts);
      return {
        chatId,
        lastActiveAt: entry.lastActiveAt,
        alerts: entry.alerts,
        canonicalHtml,
        chunks: splitMessage(canonicalHtml),
        disableNotification: resolveDisableNotification(entry),
        alertType: dominantAlertType(entry.alerts),
      };
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function splitFreshQueue(
  subscriberQueue: RoutedSubscriberAlert[],
  freshBudget: number,
  deferredChats: Pick<ReadonlyMap<string, number>, "has"> = new Map(),
): {
  toSend: RoutedSubscriberAlert[];
  toEnqueue: RoutedSubscriberAlert[];
  deferredPerChat: RoutedSubscriberAlert[];
} {
  const toSend: RoutedSubscriberAlert[] = [];
  const toEnqueue: RoutedSubscriberAlert[] = [];
  const deferredPerChat: RoutedSubscriberAlert[] = [];
  let allocatedFreshChunks = 0;

  for (const sub of subscriberQueue) {
    if (deferredChats.has(sub.chatId)) {
      deferredPerChat.push(sub);
      toEnqueue.push(sub);
      continue;
    }
    if (allocatedFreshChunks + sub.chunks.length <= freshBudget) {
      toSend.push(sub);
      allocatedFreshChunks += sub.chunks.length;
    } else {
      toEnqueue.push(sub);
    }
  }

  return { toSend, toEnqueue, deferredPerChat };
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
        replyMarkup: buildAlertReplyMarkup(sub.alerts, chunkIndex, { privateChat }),
        chunkIndex,
        alertType: sub.alertType,
        ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
      });
    }
  }
  return messages;
}

export async function deliverFreshAlerts(
  db: D1Database,
  sendList: BatchMessage[],
  subscriberQueue: RoutedSubscriberAlert[],
  botToken: string,
  blockedUsersCleanedUpSeed: number,
  blockedUsersCleanupFailedSeed: number,
  dispatchStartedAtMs: number,
  signal?: AbortSignal,
): Promise<FreshSendOutcome> {
  const sendResults = sendList.length > 0
    ? await sendBatch(sendList, botToken, SEND_BATCH_SIZE, signal)
    : [];
  const blockedChats = new Set<string>();
  const retryableFreshMessages: Array<{ message: BatchMessage; result: BatchResult }> = [];
  const resultsByChat = new Map<string, BatchResult[]>();
  const perAlertType = emptyPerAlertTypeDelivery();
  const nowSec = Math.floor(Date.now() / 1000);
  let subscribersNotified = 0;
  let freshSent = 0;
  let freshPermanentFailures = 0;
  let blockedUsersCleanedUp = blockedUsersCleanedUpSeed;
  let blockedUsersCleanupFailed = blockedUsersCleanupFailedSeed;
  const deliveryDiagnostics: Array<{ chatId: string; ok: boolean; errorClass?: string | null }> = [];
  const targetStatusUpdates: FreshSendOutcome["targetStatusUpdates"] = [];
  const chatsResetThisRun = new Set<string>();

  for (let index = 0; index < sendResults.length; index += 1) {
    throwIfAborted(signal);
    const result = sendResults[index];
    const sendPlan = sendList[index];
    if (!result || !sendPlan) continue;

    const existing = resultsByChat.get(result.chatId) ?? [];
    existing.push(result);
    resultsByChat.set(result.chatId, existing);

    const alertType: TelegramAlertType | undefined = sendPlan.alertType;
    const bucket = alertType ? perAlertType[alertType] : null;

    if (result.ok) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: true });
      targetStatusUpdates.push({ targetKey: buildDedupeKey(sendPlan), status: "sent", at: nowSec });
      freshSent++;
      await resetChatOnSuccess(db, result.chatId, chatsResetThisRun);
      if (bucket) {
        bucket.sent++;
        if (bucket.firstSendLatencyMs == null) {
          bucket.firstSendLatencyMs = Math.max(0, Date.now() - dispatchStartedAtMs);
        }
      }
      continue;
    }

    if (result.blocked) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
      targetStatusUpdates.push({
        targetKey: buildDedupeKey(sendPlan),
        status: "failed",
        at: nowSec,
        errorClass: result.errorClass ?? "blocked",
      });
      const blockedCascade = await handleBlockedChat(db, result.chatId, nowSec, blockedChats);
      if (blockedCascade.disabled) {
        blockedUsersCleanedUp++;
        const cleanup = await clearPendingAlertsForDisabledChat(db, result.chatId, nowSec);
        if (cleanup.failed) {
          blockedUsersCleanupFailed++;
        }
      } else if (blockedCascade.failed) {
        blockedUsersCleanupFailed++;
      }
      if (bucket) bucket.blocked++;
      continue;
    }

    if (result.retryable) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
      retryableFreshMessages.push({ message: sendPlan, result });
      targetStatusUpdates.push({
        targetKey: buildDedupeKey(sendPlan),
        status: "queued",
        at: nowSec,
        errorClass: result.errorClass ?? null,
      });
      if (bucket) bucket.enqueued++;
    } else {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
      targetStatusUpdates.push({
        targetKey: buildDedupeKey(sendPlan),
        status: "failed",
        at: nowSec,
        errorClass: result.errorClass ?? null,
      });
      freshPermanentFailures++;
      if (bucket) bucket.failed++;
    }
  }

  await recordTelegramDeliveryOutcomes(db, deliveryDiagnostics);

  for (const sub of subscriberQueue) {
    if (blockedChats.has(sub.chatId)) continue;
    const subResults = resultsByChat.get(sub.chatId) ?? [];
    if (subResults.length === sub.chunks.length && subResults.every((result) => result.ok)) {
      subscribersNotified++;
    }
  }

  return {
    subscribersNotified,
    freshAttempted: sendResults.filter((result) => result.attempted !== false).length,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    blockedChats,
    retryableFreshMessages,
    perAlertType,
    targetStatusUpdates,
  };
}
