import {
  formatConsolidatedMessage,
  splitMessage,
  type ConsolidatedAlerts,
} from "../lib/telegram-alerts";
import { sendBatch, type BatchMessage, type BatchResult } from "../lib/telegram";
import {
  SEND_BATCH_SIZE,
  disableBlockedSubscriber,
} from "./telegram-pending-queue";

type AlertAppender<T> = (alerts: ConsolidatedAlerts) => T[];

export interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
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
  chunks: string[];
  disableNotification: boolean;
}

export interface FreshSendOutcome {
  subscribersNotified: number;
  freshSent: number;
  freshPermanentFailures: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  blockedChats: Set<string>;
  retryableFreshMessages: BatchMessage[];
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
    .map(([chatId, entry]) => ({
      chatId,
      lastActiveAt: entry.lastActiveAt,
      alerts: entry.alerts,
      chunks: splitMessage(formatConsolidatedMessage(entry.alerts)),
      disableNotification: resolveDisableNotification(entry),
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function splitFreshQueue(
  subscriberQueue: RoutedSubscriberAlert[],
  freshBudget: number,
): {
  toSend: RoutedSubscriberAlert[];
  toEnqueue: RoutedSubscriberAlert[];
} {
  const toSend: RoutedSubscriberAlert[] = [];
  const toEnqueue: RoutedSubscriberAlert[] = [];
  let allocatedFreshChunks = 0;

  for (const sub of subscriberQueue) {
    if (allocatedFreshChunks + sub.chunks.length <= freshBudget) {
      toSend.push(sub);
      allocatedFreshChunks += sub.chunks.length;
    } else {
      toEnqueue.push(sub);
    }
  }

  return { toSend, toEnqueue };
}

export function expandSubscriberChunks(
  subscribers: RoutedSubscriberAlert[],
  blockedChats: ReadonlySet<string> = new Set(),
): BatchMessage[] {
  const messages: BatchMessage[] = [];
  for (const sub of subscribers) {
    if (blockedChats.has(sub.chatId)) continue;
    for (const chunk of sub.chunks) {
      messages.push({
        chatId: sub.chatId,
        html: chunk,
        disableNotification: sub.disableNotification,
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
): Promise<FreshSendOutcome> {
  const sendResults = await sendBatch(sendList, botToken, SEND_BATCH_SIZE);
  const blockedChats = new Set<string>();
  const retryableFreshMessages: BatchMessage[] = [];
  const resultsByChat = new Map<string, BatchResult[]>();
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

    if (result.ok) {
      freshSent++;
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
      continue;
    }

    if (result.retryable) {
      retryableFreshMessages.push(sendPlan);
    } else {
      freshPermanentFailures++;
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
  };
}
