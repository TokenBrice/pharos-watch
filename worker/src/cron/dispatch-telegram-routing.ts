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
  flushChatSuccessResets,
  handleBlockedChat,
} from "./telegram-pending";
import { throwIfAborted } from "../lib/abort";
import { recordTelegramDeliveryOutcomes } from "../lib/telegram-usage-analytics";
import {
  BURST_EVENT_THRESHOLD,
  BURST_MARKER_TTL_SEC,
  TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
} from "../lib/telegram-constants";
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
const ALERT_TYPE_PRIORITY: readonly TelegramAlertType[] = ["depeg", "dews", "safety", "launch", "reserve"];

function emptyPerAlertTypeStats(): PerAlertTypeDeliveryStats {
  return { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null };
}

export function emptyPerAlertTypeDelivery(): PerAlertTypeDelivery {
  return {
    dews: emptyPerAlertTypeStats(),
    depeg: emptyPerAlertTypeStats(),
    safety: emptyPerAlertTypeStats(),
    launch: emptyPerAlertTypeStats(),
    reserve: emptyPerAlertTypeStats(),
  };
}

function dominantAlertType(alerts: ConsolidatedAlerts): TelegramAlertType {
  if (alerts.depegTriggered.length + alerts.depegResolved.length + alerts.depegWorsening.length > 0) {
    return "depeg";
  }
  if (alerts.dews.length > 0) return "dews";
  if (alerts.safety.length > 0) return "safety";
  if (alerts.launch.length > 0) return "launch";
  if (alerts.reserve.length > 0) return "reserve";
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
  /** A settings/direct write explicitly owns this alert family's local policy. */
  hasLocalOverride?: boolean;
}

export interface AlertsByChatEntry {
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
  timezone: string | null;
  /** C128: per-run match-event counts by source, used to detect global-dominant bursts. */
  specificCount: number;
  globalCount: number;
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

export function emptyAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
    reserve: [],
  };
}

function addAlertToChat<T>(
  alertsByChat: Map<string, AlertsByChatEntry>,
  sub: SubscriberRow,
  append: AlertAppender<T>,
  event: T,
  viaGlobal: boolean,
): void {
  const existing = alertsByChat.get(sub.chat_id);
  if (existing) {
    existing.lastActiveAt = Math.max(existing.lastActiveAt, sub.last_active_at);
    append(existing.alerts).push(event);
    if (viaGlobal) existing.globalCount += 1;
    else existing.specificCount += 1;
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
    specificCount: viaGlobal ? 0 : 1,
    globalCount: viaGlobal ? 1 : 0,
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
      addAlertToChat(alertsByChat, sub, append, event, false);
    }

    for (const sub of globalSubscribers) {
      if (specificChatIds.has(sub.chat_id)) continue;
      if (disabledForEvent?.has(sub.chat_id)) continue;
      if (snoozedForEvent?.has(sub.chat_id)) continue;
      if (!shouldInclude(sub, event)) continue;
      addAlertToChat(alertsByChat, sub, append, event, true);
    }
  }
}

export interface BurstMarker {
  /** Unix seconds when the chat first entered burst mode; the TTL anchors here. */
  enteredAt: number;
  /** Coin ids already summarized for this chat while the marker is live. */
  coinIds: string[];
}
export type BurstMarkerMap = Record<string, BurstMarker>;

function collectEntryStablecoinIds(alerts: ConsolidatedAlerts): string[] {
  const ids = new Set<string>();
  for (const e of alerts.dews) ids.add(e.stablecoinId);
  for (const e of alerts.depegTriggered) ids.add(e.stablecoinId);
  for (const e of alerts.depegResolved) ids.add(e.stablecoinId);
  for (const e of alerts.depegWorsening) ids.add(e.stablecoinId);
  for (const e of alerts.safety) ids.add(e.stablecoinId);
  for (const e of alerts.launch) ids.add(e.stablecoinId);
  for (const e of alerts.reserve) ids.add(e.stablecoinId);
  return [...ids];
}

/**
 * C128: collapse global-dominant burst chats into a single summary chunk BEFORE
 * the expensive formatting pass (hence the C102 dependency). Mutates
 * `alertsByChat` in place — a qualifying chat's alerts are replaced with a burst
 * summary covering only NEW (delta) coins vs its live marker; a chat whose coin
 * set is already fully summarized within the live window is removed (suppressed).
 * Returns the next marker map (expired markers pruned) plus counters. With the
 * default threshold this is a no-op, so normal delivery is unchanged until the
 * threshold is deliberately lowered.
 */
export function collapseBurstChats(
  alertsByChat: Map<string, AlertsByChatEntry>,
  markers: BurstMarkerMap,
  nowSec: number,
  threshold: number = BURST_EVENT_THRESHOLD,
  ttlSec: number = BURST_MARKER_TTL_SEC,
): { markers: BurstMarkerMap; collapsedChats: number; deltaSuppressed: number } {
  const liveMarkers: BurstMarkerMap = {};
  for (const [chatId, marker] of Object.entries(markers)) {
    if (
      marker &&
      typeof marker.enteredAt === "number" &&
      Array.isArray(marker.coinIds) &&
      nowSec - marker.enteredAt < ttlSec
    ) {
      liveMarkers[chatId] = { enteredAt: marker.enteredAt, coinIds: marker.coinIds };
    }
  }

  const nextMarkers: BurstMarkerMap = { ...liveMarkers };
  let collapsedChats = 0;
  let deltaSuppressed = 0;

  for (const [chatId, entry] of alertsByChat) {
    const ids = collectEntryStablecoinIds(entry.alerts);
    const globalDominant = entry.globalCount > entry.specificCount;
    if (!globalDominant || ids.length < threshold) continue;

    const marker = liveMarkers[chatId];
    const alreadySeen = new Set(marker?.coinIds ?? []);
    const deltaIds = ids.filter((id) => !alreadySeen.has(id));
    if (deltaIds.length === 0) {
      // Whole set already summarized within the live window: send nothing, and do
      // NOT refresh enteredAt (the TTL is anchored to the first burst entry).
      alertsByChat.delete(chatId);
      deltaSuppressed += 1;
      continue;
    }

    const dominantFamily = dominantAlertType(entry.alerts);
    entry.alerts = { ...emptyAlerts(), burst: { coinCount: deltaIds.length, dominantFamily } };
    collapsedChats += 1;
    nextMarkers[chatId] = {
      enteredAt: marker?.enteredAt ?? nowSec,
      coinIds: marker ? [...new Set([...marker.coinIds, ...deltaIds])] : ids,
    };
  }

  return { markers: nextMarkers, collapsedChats, deltaSuppressed };
}

/**
 * A candidate chat ordered for the fresh-send plan but NOT yet formatted (C102).
 * Carries a cheap chunk estimate derived from alert counts so the budget cut can
 * happen before the expensive `formatConsolidatedMessage` pass.
 */
export interface PlannedSubscriberAlert {
  chatId: string;
  entry: AlertsByChatEntry;
  alertType: TelegramAlertType;
  /** Cheap chunk-count estimate (no formatting); see `estimateChatChunks`. */
  estimatedChunks: number;
}

/** Total alert lines queued for one chat (cheap; no formatting). */
function countChatAlerts(alerts: ConsolidatedAlerts): number {
  if (alerts.burst) return 1;
  return (
    alerts.dews.length +
    alerts.depegTriggered.length +
    alerts.depegResolved.length +
    alerts.depegWorsening.length +
    alerts.safety.length +
    alerts.launch.length +
    alerts.reserve.length
  );
}

/**
 * Cheap, format-free estimate of how many message chunks a chat will produce,
 * mirroring the load-harness `ALERTS_PER_MESSAGE_CHUNK` model. Always >= 1.
 */
function estimateChatChunks(alerts: ConsolidatedAlerts): number {
  return Math.max(
    1,
    Math.ceil(countChatAlerts(alerts) / TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE),
  );
}

/**
 * Order candidate chats newest-first and attach a cheap chunk estimate WITHOUT
 * formatting (C102 phase 1). The caller caps this ordered list against the
 * per-run fresh budget before formatting only the selected slice.
 */
export function planSubscriberQueue(
  alertsByChat: Map<string, AlertsByChatEntry>,
): PlannedSubscriberAlert[] {
  return [...alertsByChat.entries()]
    .map(([chatId, entry]) => ({
      chatId,
      entry,
      alertType: dominantAlertType(entry.alerts),
      estimatedChunks: estimateChatChunks(entry.alerts),
    }))
    .sort((a, b) => b.entry.lastActiveAt - a.entry.lastActiveAt);
}

/**
 * Split a newest-first plan into the chats whose cheap chunk estimates fit the
 * upper-bound format budget (`toFormat`) and the remainder (`overflow`). The
 * overflow tail can never be sent fresh this run, so it is enqueued lazily
 * instead of being formatted on the hot dispatch path.
 */
export function selectChatsToFormat(
  planned: readonly PlannedSubscriberAlert[],
  formatBudget: number,
): { toFormat: PlannedSubscriberAlert[]; overflow: PlannedSubscriberAlert[] } {
  const toFormat: PlannedSubscriberAlert[] = [];
  const overflow: PlannedSubscriberAlert[] = [];
  let allocated = 0;
  for (const plan of planned) {
    if (toFormat.length === 0 || allocated + plan.estimatedChunks <= formatBudget) {
      toFormat.push(plan);
      allocated += plan.estimatedChunks;
    } else {
      overflow.push(plan);
    }
  }
  return { toFormat, overflow };
}

/** Total estimated send-chunks across a planned subscriber list. */
export function estimatedPlannedChunks(plans: readonly PlannedSubscriberAlert[]): number {
  return plans.reduce((sum, plan) => sum + Math.max(1, plan.estimatedChunks), 0);
}

/** Format a single planned chat into a deliverable, split message (C102 phase 2). */
export function formatPlannedSubscriber(
  plan: PlannedSubscriberAlert,
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean,
): RoutedSubscriberAlert {
  const canonicalHtml = formatConsolidatedMessage(plan.entry.alerts);
  return {
    chatId: plan.chatId,
    lastActiveAt: plan.entry.lastActiveAt,
    alerts: plan.entry.alerts,
    canonicalHtml,
    chunks: splitMessage(canonicalHtml),
    disableNotification: resolveDisableNotification(plan.entry),
    alertType: plan.alertType,
  };
}

/** Format an already-ordered slice of planned chats (C102 phase 2). */
export function formatPlannedSubscribers(
  planned: readonly PlannedSubscriberAlert[],
  resolveDisableNotification: (entry: AlertsByChatEntry) => boolean,
): RoutedSubscriberAlert[] {
  return planned.map((plan) => formatPlannedSubscriber(plan, resolveDisableNotification));
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
  const softDeadlineAtMs = dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS;
  const sendResults = sendList.length > 0
    ? await sendBatch(sendList, botToken, SEND_BATCH_SIZE, signal, { softDeadlineAtMs })
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
  const chatsToResetOnSuccess = new Set<string>();

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
      chatsToResetOnSuccess.add(result.chatId);
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

  await flushChatSuccessResets(db, chatsToResetOnSuccess);
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
