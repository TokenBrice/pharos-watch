import { throwIfAborted } from "../lib/abort";
import type { AlertSafetySourceAssessment } from "../lib/alert-safety-source-cache";
import { getCache, setCache } from "../lib/db-cache";

import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { writeSnapshots } from "./telegram-alert-snapshots";
import {
  buildDispatchSnapshotState,
  loadDispatchSourceData,
} from "./dispatch-telegram-state";
import {
  drainPendingQueue,
  buildDedupeKey,
  cleanupExpiredPendingAlerts,
  emptyDrainResult,
  loadChatsInBackoff,
  readPendingCapacitySnapshot,
  readTelegramGlobalBackoff,
  type PendingCapacitySnapshot,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "./telegram-pending-queue";
import {
  buildSubscriberQueue,
  routeAlertEvents,
  type AlertsByChatEntry,
  type SubscriberRow,
} from "./dispatch-telegram-routing";
import {
  loadFanoutSubscriptionInputs,
  pendingCapacityFields,
} from "./dispatch-telegram-alerts-fanout";
import { deliverTelegramSubscriberQueue } from "./dispatch-telegram-delivery";
import {
  finalizeTelegramAlertJobManifests,
  persistTelegramAlertJobManifests,
} from "./telegram-alert-jobs";
import { loadTerminalTelegramAlertTargetKeys } from "./telegram-alert-target-status";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import { logTelegramEvent } from "../lib/telegram-log";
import { TELEGRAM_MAX_MESSAGES_PER_RUN } from "../lib/telegram-constants";
import { recordSystemicFreshFailure } from "./dispatch-telegram-alerts-observability";
import {
  buildTelegramDispatchEvents,
  countSuppressedSafetyChangesAtSeed,
} from "./dispatch-telegram-events";
import {
  getSymbol,
  hasEscalation,
  meetsDepegStepThreshold,
  meetsDewsThreshold,
  shouldIncludeDepegWorsening,
  shouldIncludeSafetyForSubscriber,
} from "./dispatch-telegram-predicates";
import {
  buildPerAlertTypeTargets,
  emptyResult,
  type DispatchResult,
} from "./dispatch-telegram-result";
import {
  loadGlobalSubscriberRows,
  loadPerCoinSnoozeMap,
  loadPresetSubscriberRowsBatch,
  loadSubscriberRowsBatch,
  mergeSubscriberMaps,
} from "./dispatch-telegram-subscribers";

const MAX_MESSAGES_PER_RUN = TELEGRAM_MAX_MESSAGES_PER_RUN;
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

type SubscriberQueueEntry = ReturnType<typeof buildSubscriberQueue>[number];

export interface TelegramDispatchSharedState {
  pendingCapacitySnapshot?: PendingCapacitySnapshot;
  safetySourceAssessment?: AlertSafetySourceAssessment;
}

function targetKeysForSubscriber(sub: SubscriberQueueEntry): string[] {
  return sub.chunks.map((chunk, chunkIndex) => buildDedupeKey({
    chatId: sub.chatId,
    html: chunk,
    canonicalHtml: sub.canonicalHtml,
    disableNotification: sub.disableNotification,
    chunkIndex,
    alertType: sub.alertType,
  }));
}

async function pruneAlreadyTerminalSubscribers(
  db: D1Database,
  subscriberQueue: SubscriberQueueEntry[],
): Promise<Set<string>> {
  const targetKeys = subscriberQueue.flatMap(targetKeysForSubscriber);
  if (targetKeys.length === 0) return new Set();
  const terminalKeys = await loadTerminalTelegramAlertTargetKeys(db, targetKeys);
  if (terminalKeys.size === 0) return terminalKeys;
  const filteredQueue = subscriberQueue.filter((sub) => {
    const keys = targetKeysForSubscriber(sub);
    return keys.length === 0 || !keys.every((key) => terminalKeys.has(key));
  });
  subscriberQueue.splice(0, subscriberQueue.length, ...filteredQueue);
  return terminalKeys;
}

async function readPresetFailureCount(db: D1Database): Promise<number> {
  try {
    const cached = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
    if (!cached) return 0;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

async function writePresetFailureCount(db: D1Database, value: number): Promise<void> {
  try {
    await setCache(db, PRESET_QUERY_FAILURE_CACHE_KEY, String(Math.max(0, Math.floor(value))));
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "failed to persist preset failure count",
      action: "write-preset-failure-count",
      module: "dispatch-telegram-alerts",
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function assignSharedDispatchState(
  sharedState: TelegramDispatchSharedState | undefined,
  updates: Partial<TelegramDispatchSharedState>,
): void {
  if (!sharedState) return;
  Object.assign(sharedState, updates);
}

function hasDetectedTelegramEvents(events: {
  dewsChanges: unknown[];
  depegTriggered: unknown[];
  depegResolved: unknown[];
  depegWorsening: unknown[];
  safetyChanges: unknown[];
  launchPromoted: unknown[];
}): boolean {
  return (
    events.dewsChanges.length > 0 ||
    events.depegTriggered.length > 0 ||
    events.depegResolved.length > 0 ||
    events.depegWorsening.length > 0 ||
    events.safetyChanges.length > 0 ||
    events.launchPromoted.length > 0
  );
}

export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
  sharedState?: TelegramDispatchSharedState,
): Promise<{ itemCount: number; metadata: string }> {
  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
  if (!allowed) {
    return { itemCount: 0, metadata: JSON.stringify({ skipped: "circuit-open" }) };
  }

  const dispatchStartedAtMs = Date.now();

  try {
    throwIfAborted(signal);

    const sourceData = await loadDispatchSourceData(db);
    const { chatsWithActiveSnooze } = sourceData;

    throwIfAborted(signal);

    const nowSec = Math.floor(Date.now() / 1000);
    const snapshotState = buildDispatchSnapshotState(sourceData, nowSec);
    const {
      currentSnapshots,
      mustSeedSnapshots,
      safetySnapshotNeedsSeed,
      safetySourceAssessment,
    } = snapshotState;
    assignSharedDispatchState(sharedState, { safetySourceAssessment });

    const suppressedSafetyChangesAtSeed = countSuppressedSafetyChangesAtSeed(snapshotState, getSymbol);
    const pendingCapacityBefore = await readPendingCapacitySnapshot(db, nowSec);
    assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });

    if (mustSeedSnapshots) {
      await writeSnapshots(db, currentSnapshots);
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
      const result = emptyResult(true, chatsWithActiveSnooze);
      result.pendingCapacityBefore = pendingCapacityBefore;
      result.pendingCapacityAfter = pendingCapacityBefore;
      Object.assign(result, pendingCapacityFields(pendingCapacityBefore));
      result.safetyAlertSourceState = safetySourceAssessment.state;
      result.safetyAlertSourceAgeSeconds = safetySourceAssessment.ageSeconds;
      result.safetyAlertSourceGeneration = safetySourceAssessment.generation;
      result.safetyAlertsSuppressed = safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed;
      result.suppressedSafetyChangesAtSeed = suppressedSafetyChangesAtSeed;
      assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityBefore });
      return { itemCount: 0, metadata: JSON.stringify(result) };
    }

    const {
      dewsChanges,
      depegTriggered,
      depegResolved,
      depegWorsening,
      safetyChanges,
      launchPromoted,
      suppressedMethodologyChanges,
      dewsIds,
      depegIds,
      safetyIds,
      launchIds,
    } = await buildTelegramDispatchEvents(db, sourceData, snapshotState, getSymbol, signal);

    const hasEvents = hasDetectedTelegramEvents({
      dewsChanges,
      depegTriggered,
      depegResolved,
      depegWorsening,
      safetyChanges,
      launchPromoted,
    });
    const canUseEventlessFastPath =
      !hasEvents &&
      safetySourceAssessment.state === "ok" &&
      !safetySnapshotNeedsSeed;

    if (canUseEventlessFastPath) {
      const drainResult = pendingCapacityBefore.due > 0
        ? await drainPendingQueue(db, botToken, TELEGRAM_PENDING_DRAIN_BUDGET, signal)
        : emptyDrainResult();
      const expiredCount = pendingCapacityBefore.expired > 0
        ? await cleanupExpiredPendingAlerts(db, nowSec)
        : 0;
      const pendingCapacityAfter =
        pendingCapacityBefore.due > 0 || pendingCapacityBefore.expired > 0
          ? await readPendingCapacitySnapshot(db, nowSec)
          : pendingCapacityBefore;
      assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });

      await writeSnapshots(db, currentSnapshots);
      await writePresetFailureCount(db, 0);

      const result = emptyResult(false, chatsWithActiveSnooze);
      result.eventsDetected.suppressedMethodologyChanges = suppressedMethodologyChanges;
      Object.assign(result, {
        messagesSent: drainResult.sent,
        blockedUsersCleanedUp: drainResult.blockedCleanedUp,
        blockedUsersCleanupFailed: drainResult.blockedCleanupFailed,
        pendingAttempted: drainResult.attempted,
        pendingDrained: drainResult.sent,
        pendingSent: drainResult.sent,
        pendingRetryQueued: drainResult.retryQueued,
        pendingDropped: drainResult.dropped,
        pendingDroppedTtlExpired: expiredCount,
        pendingDroppedPermanentFailure: drainResult.droppedPermanentFailure,
        pendingDroppedMaxAttemptsFallback: drainResult.droppedMaxAttemptsFallback,
        pendingDeferred: drainResult.deferred,
        pendingRateLimited: drainResult.rateLimited,
        pendingRetryAfterSec: drainResult.retryAfterSec,
        pendingExpired: expiredCount,
        ...pendingCapacityFields(pendingCapacityAfter),
        pendingCapacityBefore,
        pendingCapacityAfter,
        chatsWithActiveSnooze,
        safetyAlertSourceState: safetySourceAssessment.state,
        safetyAlertSourceAgeSeconds: safetySourceAssessment.ageSeconds,
        safetyAlertsSuppressed: false,
        safetyAlertSourceGeneration: safetySourceAssessment.generation,
        suppressedSafetyChangesAtSeed,
      } satisfies Partial<DispatchResult>);
      (result as DispatchResult & { eventlessFastPath: boolean }).eventlessFastPath = true;

      const hasSuccessfulEffect =
        result.messagesSent > 0 ||
        result.blockedUsersCleanedUp > 0 ||
        result.pendingAttempted === 0;
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, hasSuccessfulEffect);

      return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
    }

    const fanoutQueryStartedAtMs = Date.now();
    const {
      directDewsSubs,
      directDepegSubs,
      directSafetySubs,
      launchSubs,
      presetDewsResult,
      presetDepegResult,
      presetSafetyResult,
      globalDewsSubs,
      globalDepegSubs,
      globalSafetySubs,
      globalLaunchSubs,
      perCoinSnoozeMap,
    } = await loadFanoutSubscriptionInputs(
      db,
      { dewsIds, depegIds, safetyIds, launchIds },
      {
        loadSubscriberRowsBatch,
        loadPresetSubscriberRowsBatch,
        loadGlobalSubscriberRows,
        loadPerCoinSnoozeMap,
      },
    );
    const fanoutQueryMs = Math.max(0, Date.now() - fanoutQueryStartedAtMs);
    const fanoutBuildStartedAtMs = Date.now();

    const presetResults = [presetDewsResult, presetDepegResult, presetSafetyResult];
    const presetQueryFailures = presetResults.filter((r) => r.kind === "query-failed").length;
    const presetResolutionFailures = presetResults.filter((r) => r.kind === "resolution-failed").length;

    if (presetQueryFailures > 0 || presetResolutionFailures > 0) {
      const failureCount = (await readPresetFailureCount(db)) + 1;
      await writePresetFailureCount(db, failureCount);
    }

    const presetDewsSubs = presetDewsResult.kind === "ok" ? presetDewsResult.rows : new Map<string, SubscriberRow[]>();
    const presetDepegSubs = presetDepegResult.kind === "ok" ? presetDepegResult.rows : new Map<string, SubscriberRow[]>();
    const presetSafetySubs = presetSafetyResult.kind === "ok" ? presetSafetyResult.rows : new Map<string, SubscriberRow[]>();
    const dewsSubs = mergeSubscriberMaps(directDewsSubs, presetDewsSubs);
    const depegSubs = mergeSubscriberMaps(directDepegSubs, presetDepegSubs);
    const safetySubs = mergeSubscriberMaps(directSafetySubs, presetSafetySubs);

    throwIfAborted(signal);

    const alertsByChat = new Map<string, AlertsByChatEntry>();
    routeAlertEvents(
      dewsChanges,
      dewsSubs,
      globalDewsSubs,
      alertsByChat,
      (alerts) => alerts.dews,
      (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegTriggered,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegTriggered,
      (sub, event) => meetsDepegStepThreshold(event.deviationBps, sub.depeg_worsening_bps_step),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegResolved,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegResolved,
      (sub, event) => meetsDepegStepThreshold(event.peakDeviationBps, sub.depeg_worsening_bps_step),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegWorsening,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegWorsening,
      shouldIncludeDepegWorsening,
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      safetyChanges,
      safetySubs,
      globalSafetySubs,
      alertsByChat,
      (alerts) => alerts.safety,
      shouldIncludeSafetyForSubscriber,
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      launchPromoted,
      launchSubs,
      globalLaunchSubs,
      alertsByChat,
      (alerts) => alerts.launch,
      undefined,
      perCoinSnoozeMap,
    );

    const subscriberQueue = buildSubscriberQueue(
      alertsByChat,
      (entry) =>
        !hasEscalation(entry.alerts) ||
        isQuietHoursActive(
          nowSec,
          entry.quietHoursEnabled,
          entry.quietHoursStartUtc,
          entry.quietHoursEndUtc,
          entry.timezone,
        ),
    );
    const fanoutBuildMs = Math.max(0, Date.now() - fanoutBuildStartedAtMs);
    const perAlertTypeTargets = buildPerAlertTypeTargets(subscriberQueue);
    const freshCandidateChats = subscriberQueue.length;
    const freshCandidateCount = subscriberQueue.reduce((sum, sub) => sum + sub.chunks.length, 0);
    const alertJobManifests = await persistTelegramAlertJobManifests(db, subscriberQueue, nowSec);

    const drainOnlyRiskPriority = freshCandidateCount > 0 ? TELEGRAM_PENDING_PRIORITY.riskAlert : null;
    const drainResult = await drainPendingQueue(
      db,
      botToken,
      TELEGRAM_PENDING_DRAIN_BUDGET,
      signal,
      { maxPriority: drainOnlyRiskPriority },
    );

    const [chatsInBackoff, globalBackoffUntil] = await Promise.all([
      loadChatsInBackoff(db, nowSec),
      readTelegramGlobalBackoff(db, nowSec),
    ]);

    const {
      subscribersNotified,
      freshSent,
      freshPermanentFailures,
      blockedUsersCleanedUp,
      blockedUsersCleanupFailed,
      freshAttempted,
      freshRetryQueued,
      freshOverflow,
      freshDeferredPerChat,
      pendingEnqueued,
      cappedAtLimit,
      perAlertType,
    } = await deliverTelegramSubscriberQueue({
      db,
      botToken,
      subscriberQueue,
      drainResult,
      maxMessagesPerRun: MAX_MESSAGES_PER_RUN,
      nowSec,
      chatsInBackoff,
      globalBackoffUntil,
      dispatchStartedAtMs,
      terminalTargetKeys: await pruneAlreadyTerminalSubscribers(db, subscriberQueue),
      signal,
    });
    await finalizeTelegramAlertJobManifests(db, alertJobManifests, perAlertType, nowSec);

    await writeSnapshots(db, currentSnapshots);
    const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);
    const pendingCapacityAfter = await readPendingCapacitySnapshot(db, nowSec);
    assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: pendingCapacityAfter });
    if (presetQueryFailures === 0 && presetResolutionFailures === 0) {
      await writePresetFailureCount(db, 0);
    }

    const result: DispatchResult = {
      eventsDetected: {
        dews: dewsChanges.length,
        depeg: depegTriggered.length + depegResolved.length + depegWorsening.length,
        depegTriggered: depegTriggered.length,
        depegResolved: depegResolved.length,
        depegWorsening: depegWorsening.length,
        safety: safetyChanges.length,
        launch: launchPromoted.length,
        suppressedMethodologyChanges,
      },
      subscribersNotified,
      messagesSent: freshSent + drainResult.sent,
      blockedUsersCleanedUp,
      blockedUsersCleanupFailed,
      cappedAtLimit,
      snapshotSeeded: false,
      pendingAttempted: drainResult.attempted,
      pendingDrained: drainResult.sent,
      pendingSent: drainResult.sent,
      pendingRetryQueued: drainResult.retryQueued,
      pendingDropped: drainResult.dropped,
      pendingDroppedTtlExpired: expiredCount,
      pendingDroppedPermanentFailure: drainResult.droppedPermanentFailure,
      pendingDroppedMaxAttemptsFallback: drainResult.droppedMaxAttemptsFallback,
      pendingDeferred: drainResult.deferred,
      pendingRateLimited: drainResult.rateLimited,
      pendingRetryAfterSec: drainResult.retryAfterSec,
      pendingEnqueued,
      pendingExpired: expiredCount,
      ...pendingCapacityFields(pendingCapacityAfter),
      pendingCapacityBefore,
      pendingCapacityAfter,
      freshAttempted,
      freshSent,
      freshRetryQueued,
      freshPermanentFailures,
      freshDeferredPerChat,
      freshCandidateChats,
      freshCandidateCount,
      freshOverflow,
      chatsWithActiveSnooze,
      safetyAlertSourceState: safetySourceAssessment.state,
      safetyAlertSourceAgeSeconds: safetySourceAssessment.ageSeconds,
      safetyAlertsSuppressed: safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
      safetyAlertSourceGeneration: safetySourceAssessment.generation,
      presetQueryFailures,
      presetResolutionFailures,
      presetFailure: presetQueryFailures > 0 || presetResolutionFailures > 0,
      perAlertType,
      perAlertTypeTargets,
      fanoutQueryMs,
      fanoutBuildMs,
      fanoutTotalMs: fanoutQueryMs + fanoutBuildMs,
      suppressedSafetyChangesAtSeed,
    };

    const attemptedMessages = result.pendingAttempted + result.freshAttempted;
    const hasSuccessfulEffect =
      result.messagesSent > 0 || result.blockedUsersCleanedUp > 0 || attemptedMessages === 0;
    const systemicFreshFailure = recordSystemicFreshFailure(result);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, hasSuccessfulEffect && !systemicFreshFailure);

    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
  } catch (error) {
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    throw error;
  }
}
