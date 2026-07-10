import {
  formatConsolidatedMessage,
  buildAlertReplyMarkup,
  resolveAlertLinkPreviewOptions,
  splitMessage,
  type ConsolidatedAlerts,
} from "../lib/telegram-alerts";
import {
  sendBatch,
  type BatchMessage,
  type BatchResult,
  type PreSendBatchResult,
} from "../lib/telegram";
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
import {
  claimFreshTelegramAlertTargets,
  createTelegramFreshTargetOwner,
  finalizeFreshTelegramAlertTargetEffects,
  markFreshTelegramAlertTargetsSending,
  type TelegramFreshTargetClaim,
  type TelegramFreshTargetEffectOutcome,
} from "./telegram-alert-target-effects";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  buildPendingAlertScope,
  type PendingAlertScopeItem,
} from "../lib/telegram-pending-provenance";
import {
  claimTelegramTransportPermit,
  recordTelegramTransportOutcomes as recordTelegramBotWideTransportOutcomes,
  telegramTransportPermitSkip,
  type TelegramTransportPermit,
} from "../lib/telegram-transport-control";

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
  /** Persisted chat preference generation. Optional only for legacy fixtures/cache payloads. */
  preference_generation?: number;
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
  preferenceGeneration?: number;
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
  sourceEventId?: string;
  preferenceGeneration?: number;
  alertScope?: PendingAlertScopeItem[];
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

export interface FreshRetryEffectHandoff {
  message: BatchMessage;
  result: BatchResult;
  claim: TelegramFreshTargetClaim;
  at: number;
}

function buildPreSendFenceSkip(): PreSendBatchResult {
  return {
    ok: false,
    blocked: false,
    retryable: false,
    permanentFailure: true,
    statusCode: null,
    errorClass: "unknown",
    delivery: "permanent_failure",
    retryAfterSec: null,
    skippedReason: "pre_send",
  };
}

function isAmbiguousFreshSendResult(result: BatchResult): boolean {
  return (
    result.attempted !== false &&
    result.statusCode == null &&
    (result.errorClass === "timeout" || result.errorClass === "network" || result.errorClass === "unknown")
  );
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
  const preferenceGeneration = Number.isFinite(sub.preference_generation)
    ? Math.max(0, Math.floor(sub.preference_generation ?? 0))
    : 0;
  const existing = alertsByChat.get(sub.chat_id);
  if (existing) {
    existing.lastActiveAt = Math.max(existing.lastActiveAt, sub.last_active_at);
    existing.preferenceGeneration = Math.min(
      existing.preferenceGeneration ?? 0,
      preferenceGeneration,
    );
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
    preferenceGeneration,
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
    entry.alerts = {
      ...emptyAlerts(),
      burst: { coinCount: deltaIds.length, dominantFamily, stablecoinIds: deltaIds },
    };
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
  sourceEventId?: string;
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
  sourceEventId?: string,
): PlannedSubscriberAlert[] {
  return [...alertsByChat.entries()]
    .map(([chatId, entry]) => ({
      chatId,
      entry,
      alertType: dominantAlertType(entry.alerts),
      sourceEventId,
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
  const routed: RoutedSubscriberAlert = {
    chatId: plan.chatId,
    lastActiveAt: plan.entry.lastActiveAt,
    alerts: plan.entry.alerts,
    canonicalHtml,
    chunks: splitMessage(canonicalHtml),
    disableNotification: resolveDisableNotification(plan.entry),
    alertType: plan.alertType,
  };
  if (plan.sourceEventId) {
    routed.sourceEventId = plan.sourceEventId;
    routed.preferenceGeneration = plan.entry.preferenceGeneration ?? 0;
    routed.alertScope = buildPendingAlertScope(plan.entry.alerts);
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
        ...(sub.sourceEventId && sub.preferenceGeneration != null && sub.alertScope
          ? {
              sourceEventId: sub.sourceEventId,
              preferenceGeneration: sub.preferenceGeneration,
              alertScope: sub.alertScope,
            }
          : {}),
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
  freshTargetJobIds: ReadonlyMap<string, string>,
  handoffRetryableFreshEffects?: (handoffs: readonly FreshRetryEffectHandoff[]) => Promise<void>,
  signal?: AbortSignal,
): Promise<FreshSendOutcome> {
  const softDeadlineAtMs = dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS;
  const freshEffectOwner = createTelegramFreshTargetOwner();
  const transportOwner = `fresh-transport:${freshEffectOwner}`;
  let waveTransportPermit: TelegramTransportPermit | null = null;
  const freshTargetClaimsByKey = new Map<string, TelegramFreshTargetClaim>();
  const sendResults = sendList.length > 0
    ? await sendBatch(sendList, botToken, SEND_BATCH_SIZE, signal, {
        softDeadlineAtMs,
        beforeSendBatch: async (entries) => {
          throwIfAborted(signal);
          const permitNowSec = Math.floor(Date.now() / 1000);
          waveTransportPermit = await claimTelegramTransportPermit(db, {
            mode: "fresh",
            owner: transportOwner,
            nowSec: permitNowSec,
            requestedDistinctChats: entries.length,
          });
          if (!waveTransportPermit.allowed) {
            const skipped = new Map<number, PreSendBatchResult>();
            const skip = telegramTransportPermitSkip(waveTransportPermit, permitNowSec);
            for (const entry of entries) skipped.set(entry.index, skip);
            return skipped;
          }
          const identities = entries.map(({ item }) => {
            const targetKey = buildDedupeKey(item);
            const jobId = freshTargetJobIds.get(targetKey);
            if (!jobId) {
              throw new Error("Telegram fresh target has no durable manifest identity");
            }
            return { jobId, targetKey };
          });
          const { claims, skippedTargetKeys } = await claimFreshTelegramAlertTargets(
            db,
            identities,
            freshEffectOwner,
            Math.floor(Date.now() / 1000),
            signal,
          );
          await markFreshTelegramAlertTargetsSending(
            db,
            [...claims.values()],
            Math.floor(Date.now() / 1000),
            signal,
          );
          for (const [targetKey, claim] of claims) freshTargetClaimsByKey.set(targetKey, claim);
          if (skippedTargetKeys.size === 0) return;
          const skipped = new Map<number, PreSendBatchResult>();
          for (const entry of entries) {
            if (skippedTargetKeys.has(buildDedupeKey(entry.item))) {
              skipped.set(entry.index, buildPreSendFenceSkip());
            }
          }
          return skipped;
        },
        afterSendBatch: async (entries, results) => {
          const completedAt = Math.floor(Date.now() / 1000);
          const outcomes: TelegramFreshTargetEffectOutcome[] = [];
          const retryHandoffs: FreshRetryEffectHandoff[] = [];
          for (const [index, entry] of entries.entries()) {
            const result = results[index];
            if (!result || result.attempted === false) continue;
            const targetKey = buildDedupeKey(entry.item);
            const claim = freshTargetClaimsByKey.get(targetKey);
            if (!claim) {
              throw new Error("Telegram fresh target send has no confirmed owner");
            }
            if (result.ok) {
              outcomes.push({ ...claim, status: "sent", at: completedAt });
              continue;
            }
            if (isAmbiguousFreshSendResult(result)) {
              outcomes.push({
                ...claim,
                status: "failed",
                at: completedAt,
                errorClass: result.errorClass,
                executionUnknown: true,
              });
              continue;
            }
            if (result.blocked || !result.retryable) {
              outcomes.push({
                ...claim,
                status: "failed",
                at: completedAt,
                errorClass: result.errorClass,
              });
              continue;
            }
            retryHandoffs.push({ message: entry.item, result, claim, at: completedAt });
          }
          if (retryHandoffs.length > 0) {
            if (!handoffRetryableFreshEffects) {
              throw new Error("Telegram fresh retry handoff is not configured");
            }
            await handoffRetryableFreshEffects(retryHandoffs);
          }
          await finalizeFreshTelegramAlertTargetEffects(db, outcomes, signal);
          const transportPermit = waveTransportPermit;
          waveTransportPermit = null;
          if (transportPermit?.allowed) {
            const attemptedOutcomes = results
              .filter((result) => result.attempted !== false)
              .map((result) => ({ chatId: result.chatId, result }));
            if (attemptedOutcomes.length > 0) {
              await recordTelegramBotWideTransportOutcomes(
                db,
                transportPermit,
                attemptedOutcomes,
                completedAt,
              );
            }
          }
        },
      })
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
  const pushUnclaimedTargetStatus = (update: FreshSendOutcome["targetStatusUpdates"][number]): void => {
    if (!freshTargetClaimsByKey.has(update.targetKey)) targetStatusUpdates.push(update);
  };
  const chatsToResetOnSuccess = new Set<string>();

  for (let index = 0; index < sendResults.length; index += 1) {
    throwIfAborted(signal);
    const result = sendResults[index];
    const sendPlan = sendList[index];
    if (!result || !sendPlan) continue;
    if (result.attempted === false && result.skippedReason === "pre_send") continue;

    const existing = resultsByChat.get(result.chatId) ?? [];
    existing.push(result);
    resultsByChat.set(result.chatId, existing);

    const alertType: TelegramAlertType | undefined = sendPlan.alertType;
    const bucket = alertType ? perAlertType[alertType] : null;

    if (result.ok) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: true });
      pushUnclaimedTargetStatus({ targetKey: buildDedupeKey(sendPlan), status: "sent", at: nowSec });
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
      pushUnclaimedTargetStatus({
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

    if (isAmbiguousFreshSendResult(result)) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: "execution_unknown" });
      pushUnclaimedTargetStatus({
        targetKey: buildDedupeKey(sendPlan),
        status: "failed",
        at: nowSec,
        errorClass: `execution_unknown:${result.errorClass ?? "unknown"}`,
      });
      freshPermanentFailures++;
      if (bucket) bucket.failed++;
      logTelegramEvent({
        level: "error",
        message: "Telegram fresh alert outcome is execution-unknown",
        action: "fresh-target-execution-unknown",
        module: "dispatch-telegram-routing",
        errorClass: result.errorClass ?? "unknown",
      });
    } else if (result.retryable) {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
      retryableFreshMessages.push({ message: sendPlan, result });
      pushUnclaimedTargetStatus({
        targetKey: buildDedupeKey(sendPlan),
        status: "queued",
        at: nowSec,
        errorClass: result.errorClass ?? null,
      });
      if (bucket) bucket.enqueued++;
    } else {
      deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
      pushUnclaimedTargetStatus({
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
