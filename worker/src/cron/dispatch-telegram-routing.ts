import {
  formatConsolidatedMessage,
  buildAlertReplyMarkup,
  splitMessage,
  type ConsolidatedAlerts,
} from "../lib/telegram-alerts";
import { sendBatch, type BatchMessage, type BatchResult } from "../lib/telegram";
import {
  SEND_BATCH_SIZE,
  disableBlockedSubscriber,
} from "./telegram-pending-queue";
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
  isGlobal: boolean;
}

export interface AlertsByChatEntry {
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
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
  freshSent: number;
  freshPermanentFailures: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  blockedChats: Set<string>;
  retryableFreshMessages: Array<{ message: BatchMessage; result: BatchResult }>;
  perAlertType: PerAlertTypeDelivery;
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
  });
}

export function routeAlertEvents<T extends { stablecoinId: string }>(
  events: readonly T[],
  specificSubsByStablecoin: Map<string, SubscriberRow[]>,
  globalSubscribers: readonly SubscriberRow[],
  alertsByChat: Map<string, AlertsByChatEntry>,
  append: AlertAppender<T>,
  shouldInclude: (sub: SubscriberRow, event: T) => boolean = () => true,
): void {
  for (const event of events) {
    const specificSubscribers = specificSubsByStablecoin.get(event.stablecoinId) ?? [];
    const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));

    for (const sub of specificSubscribers) {
      if (!shouldInclude(sub, event)) continue;
      addAlertToChat(alertsByChat, sub, append, event);
    }

    for (const sub of globalSubscribers) {
      if (specificChatIds.has(sub.chat_id)) continue;
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
  deferredChats: ReadonlySet<string> = new Set(),
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

export function expandSubscriberChunks(
  subscribers: RoutedSubscriberAlert[],
  blockedChats: ReadonlySet<string> = new Set(),
): BatchMessage[] {
  const messages: BatchMessage[] = [];
  for (const sub of subscribers) {
    if (blockedChats.has(sub.chatId)) continue;
    for (const [chunkIndex, chunk] of sub.chunks.entries()) {
      messages.push({
        chatId: sub.chatId,
        html: chunk,
        canonicalHtml: sub.canonicalHtml,
        disableNotification: sub.disableNotification,
        replyMarkup: buildAlertReplyMarkup(sub.alerts, chunkIndex),
        chunkIndex,
        alertType: sub.alertType,
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
  let subscribersNotified = 0;
  let freshSent = 0;
  let freshPermanentFailures = 0;
  let blockedUsersCleanedUp = blockedUsersCleanedUpSeed;
  let blockedUsersCleanupFailed = blockedUsersCleanupFailedSeed;

  for (let index = 0; index < sendResults.length; index += 1) {
    const result = sendResults[index];
    const sendPlan = sendList[index];
    if (!result || !sendPlan) continue;

    const existing = resultsByChat.get(result.chatId) ?? [];
    existing.push(result);
    resultsByChat.set(result.chatId, existing);

    const alertType: TelegramAlertType | undefined = sendPlan.alertType;
    const bucket = alertType ? perAlertType[alertType] : null;

    if (result.ok) {
      freshSent++;
      if (bucket) {
        bucket.sent++;
        if (bucket.firstSendLatencyMs == null) {
          bucket.firstSendLatencyMs = Math.max(0, Date.now() - dispatchStartedAtMs);
        }
      }
      continue;
    }

    if (result.blocked) {
      if (!blockedChats.has(result.chatId)) {
        blockedChats.add(result.chatId);
        if (await disableBlockedSubscriber(db, result.chatId)) {
          blockedUsersCleanedUp++;
        } else {
          blockedUsersCleanupFailed++;
        }
      }
      if (bucket) bucket.blocked++;
      continue;
    }

    if (result.retryable) {
      retryableFreshMessages.push({ message: sendPlan, result });
      if (bucket) bucket.enqueued++;
    } else {
      freshPermanentFailures++;
      if (bucket) bucket.failed++;
    }
  }

  for (const sub of subscriberQueue) {
    if (blockedChats.has(sub.chatId)) continue;
    const subResults = resultsByChat.get(sub.chatId) ?? [];
    if (subResults.length === sub.chunks.length && subResults.every((result) => result.ok)) {
      subscribersNotified++;
    }
  }

  return {
    subscribersNotified,
    freshSent,
    freshPermanentFailures,
    blockedUsersCleanedUp,
    blockedUsersCleanupFailed,
    blockedChats,
    retryableFreshMessages,
    perAlertType,
  };
}
