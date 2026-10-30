import { throwIfAborted } from "../../../lib/abort";
import type { CronProgressReporter } from "../../../lib/cron-logger";
import { reportCronProgress } from "../../../lib/cron-progress";
import { shouldAttemptFetch, recordOutcome } from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { executeAtomicBatch } from "../../../lib/db";
import { prepareCacheUpsert } from "../../../lib/db-cache";
import { TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } from "../../../telegram/common/constants";
import { readTelegramPendingCapacitySnapshot } from "../../../telegram/outbox/pending-capacity";
import { buildTelegramJobStatements } from "../../../telegram/delivery/jobs";
import { drainTelegramDeliveries } from "../../../telegram/delivery/job-drain";
import {
  assignSharedDispatchState,
  buildDispatchSnapshotState,
  loadDispatchSourceData,
  readPresetFailureCount,
  writePresetFailureCount,
} from "./dispatch-telegram-state";
import {
  activeTelegramEventFamilies,
  buildTelegramDispatchEvents,
  countSuppressedSafetyChangesAtSeed,
  summarizeTelegramDispatchEvents,
} from "../sources/dispatch-telegram-events";
import { buildTelegramSnapshotCacheEntries, writeSnapshots } from "../sources/telegram-alert-snapshots";
import { getSymbol } from "./dispatch-telegram-predicates";
import { buildDispatchResult, type DispatchResult } from "./dispatch-telegram-result";
import { emptyDrainResult } from "../delivery/types";
import { buildTelegramAlertJobSpec } from "../jobs/alert-job";
import {
  cancelRetractedFreezeDeliveries,
  detectTelegramFreezeJobs,
  type FreezeJobDetection,
} from "../jobs/freeze-job";
import { fanOutPlanningTelegramJobs, sweepTelegramJobs } from "../jobs/run-jobs";
import { runTelegramRollupStep, type TelegramRollupStepResult } from "../rollup/rollup-step";
import { loadRetractedFreezeAlertIds } from "../freeze/telegram-alert-freeze";
import { classifyTelegramLogError, logTelegramEvent } from "../../../telegram/common/log";

export type { TelegramDispatchSharedState } from "./dispatch-telegram-state";

/** Kinds carrying freeze claims that Tape retraction must be able to cancel before send. */
const FREEZE_DELIVERY_KINDS = ["freeze", "freeze_batch"] as const;
import type { TelegramDispatchSharedState } from "./dispatch-telegram-state";

/**
 * Delivery v2 dispatcher (docs/telegram-architecture.md#delivery). One path
 * every five minutes, in the same lane, lease and connection budget:
 *   1. detect (existing sources + policy) -> deterministic job row committed
 *      atomically with the snapshot baselines (or a silent seed);
 *   2. freeze Tape events -> one job per event, atomically with the cursor;
 *   3. fan out `planning` jobs one CPU-bounded page at a time;
 *   4. drain due deliveries (4 concurrent chats, chunks serial per chat);
 *   5. sweep: stale `sending` -> unknown, TTL -> expired, finished jobs -> done.
 * Telegram calls happen only in 4 and are skipped while the generic
 * Telegram API circuit is open; detection and fan-out still run so baselines
 * stay continuous and work is queued for the TTL window.
 */
export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
  sharedState?: TelegramDispatchSharedState,
  reportProgress?: CronProgressReporter,
): Promise<{ itemCount: number; metadata: string; status?: "degraded"; error?: string }> {
  const dispatchStartedAtMs = Date.now();
  const nowSec = Math.floor(dispatchStartedAtMs / 1000);
  const softDeadlineAtMs = dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS;
  const transportAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);

  await reportCronProgress(reportProgress, {
    stage: "source-loading",
    message: "Loading Telegram alert sources",
    providerFamily: "telegram-dispatch",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const sourceData = await loadDispatchSourceData(db);
  const snapshotState = buildDispatchSnapshotState(sourceData, nowSec);
  const { currentSnapshots, mustSeedSnapshots, safetySnapshotNeedsSeed, safetySourceAssessment } = snapshotState;
  assignSharedDispatchState(sharedState, { safetySourceAssessment });
  const suppressedSafetyChangesAtSeed = countSuppressedSafetyChangesAtSeed(snapshotState, getSymbol);
  throwIfAborted(signal);

  // Planning failures (freeze/alert detection, fan-out) are isolated: they are
  // recorded and the run ends degraded, but drain and the sweep still
  // run, so already-queued deliveries keep flowing.
  const planningErrors: string[] = [];
  const isolate = async <T>(stage: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted) throw error;
      planningErrors.push(`${stage}:${classifyTelegramLogError(error)}`);
      logTelegramEvent({
        level: "error",
        message: "telegram dispatch planning stage failed",
        action: `telegram-dispatch-${stage}`,
        module: "dispatch-telegram-alerts",
        errorClass: classifyTelegramLogError(error),
      });
      return fallback;
    }
  };

  const freeze: FreezeJobDetection = await isolate("freeze-detection", {
    state: "idle",
    observed: 0,
    jobsCreated: 0,
    skippedNoAudience: 0,
    belowRealtimeThreshold: [],
    droppedUnparsed: 0,
  }, () => detectTelegramFreezeJobs(db, nowSec));

  let eventOverrides: Partial<DispatchResult["eventsDetected"]> = {};
  let alertJobCreated = false;
  let alertJobId: string | null = null;
  let alertFamilies: string[] = [];
  let eventless = false;
  // Both flags describe committed evidence: the seed write and the eventless
  // baseline rewrite each publish only after their batch resolves.
  let snapshotSeedCommitted = false;
  await isolate("alert-detection", undefined, async () => {
    if (mustSeedSnapshots) {
      await writeSnapshots(db, currentSnapshots);
      snapshotSeedCommitted = true;
    } else {
      const { events, changeLogStatements } = await buildTelegramDispatchEvents(
        db, sourceData, snapshotState, getSymbol, signal,
      );
      const summary = summarizeTelegramDispatchEvents(events);
      eventOverrides = summary.eventsDetected;
      // The roll-up transitions and the baselines that consume them commit in
      // one batch (never split): a failure keeps both, so the next run
      // re-detects every transition. The job, when present, goes first.
      const baselineStatements = [
        ...changeLogStatements,
        ...buildTelegramSnapshotCacheEntries(currentSnapshots)
          .map((entry) => prepareCacheUpsert(db, { ...entry, updatedAt: nowSec })),
      ];
      if (summary.total === 0) {
        await executeAtomicBatch(db, baselineStatements, { signal });
        eventless = true;
      } else {
        // A crash re-detects the same events and re-derives the same job id.
        const spec = await buildTelegramAlertJobSpec({
          events,
          baselineDigestInput: JSON.stringify(currentSnapshots),
          detectedAt: nowSec,
        });
        alertJobId = spec.jobId;
        alertFamilies = activeTelegramEventFamilies(events);
        const statements = [...await buildTelegramJobStatements(db, spec), ...baselineStatements];
        const results = await executeAtomicBatch(db, statements, { returnResults: true, signal });
        alertJobCreated = Number(results[0]?.meta?.changes ?? 0) > 0;
      }
    }
  });
  throwIfAborted(signal);

  // Retraction is a send-time safety check: if it cannot run, freeze rows are
  // held (fail closed) this run while every other kind still drains.
  const retractedFreeze = await isolate("freeze-retraction", null, () => cancelRetractedFreezeDeliveries(db, nowSec));
  const holdKinds = retractedFreeze == null ? FREEZE_DELIVERY_KINDS : [];
  const fanout = await isolate("fanout", {
    pages: 0,
    deliveriesPlanned: 0,
    suppressedDuplicate: 0,
    jobsReady: 0,
    jobsFailedClosed: 0,
    presetQueryFailures: 0,
    presetResolutionFailures: 0,
    jobsCancelled: 0,
    cappedRows: 0,
  }, () => fanOutPlanningTelegramJobs(db, nowSec, { signal, softDeadlineAtMs }));
  // Durable evidence for /api/status.telegramBot.presetQueryFailures: add the
  // failures this completed stage attributed, or clear them on a clean run. A
  // fan-out stage that threw names itself in planningErrors and leaves the
  // prior count untouched.
  const presetRunFailures = fanout.presetQueryFailures + fanout.presetResolutionFailures;
  if (!planningErrors.some((error) => error.startsWith("fanout:"))) {
    const priorPresetFailures = await readPresetFailureCount(db);
    // A failed read is unknown, not zero: leave the durable count untouched.
    if (priorPresetFailures != null) {
      const nextPresetFailures = presetRunFailures > 0
        ? priorPresetFailures + presetRunFailures
        : 0;
      if (nextPresetFailures !== priorPresetFailures) {
        await writePresetFailureCount(db, nextPresetFailures);
      }
    }
  }
  await reportCronProgress(reportProgress, {
    stage: "fanout-built",
    message: "Fanned out Telegram jobs",
    providerFamily: "telegram-dispatch",
    itemsDone: fanout.deliveriesPlanned,
    itemsTotal: Math.max(fanout.deliveriesPlanned, 1),
    metadata: { alertJobId, fanoutPages: fanout.pages, jobsReady: fanout.jobsReady },
  });

  // Hourly freeze batch and the 09:00-local roll-up enqueue direct-delivery
  // jobs; a failure here must never block live alerts.
  let rollup: TelegramRollupStepResult | null = null;
  let rollupStepFailed = false;
  try {
    rollup = await runTelegramRollupStep(db, nowSec);
  } catch (error) {
    rollupStepFailed = true;
    logTelegramEvent({
      level: "warn",
      message: "telegram roll-up step failed",
      action: "telegram-rollup-step",
      module: "dispatch-telegram-alerts",
      errorClass: classifyTelegramLogError(error),
    });
  }

  const drain = transportAllowed
    ? await drainTelegramDeliveries(db, botToken, {
      signal,
      softDeadlineAtMs,
      holdKinds,
      // Fresh per send wave; a failed read holds freeze-bearing rows and degrades the run.
      validateFreezeClaims: (keys) => isolate("freeze-revalidation", null, () => loadRetractedFreezeAlertIds(db, keys)),
    })
    : null;
  const sweep = await sweepTelegramJobs(db, Math.floor(Date.now() / 1000));

  const sent = drain?.sent ?? 0;
  const attempted = drain?.attempted ?? 0;
  if (transportAllowed) {
    await recordOutcome(
      db,
      CIRCUIT_SOURCE.TELEGRAM_API,
      attempted === 0 || sent > 0 || (drain?.blocked ?? 0) > 0,
    );
  }

  const capacityAfter = await readTelegramPendingCapacitySnapshot(db, Math.floor(Date.now() / 1000));
  assignSharedDispatchState(sharedState, { pendingCapacitySnapshot: capacityAfter });
  const drainResult = {
    ...emptyDrainResult(),
    attempted,
    sent,
    acceptedChats: drain?.acceptedChats ?? 0,
    blocked: drain?.blocked ?? 0,
    blockedCleanedUp: drain?.blockedChatsDisabled ?? 0,
    retryQueued: drain?.retried ?? 0,
    executionUnknown: drain?.unknown ?? 0,
    dropped: (drain?.failed ?? 0) + (drain?.cancelled ?? 0),
    droppedPermanentFailure: drain?.failedPermanent ?? 0,
    droppedMaxAttemptsFallback: drain?.failedMaxAttempts ?? 0,
    deferred: drain?.deferred ?? 0,
    rateLimited: drain?.globalBackoffUntil != null,
    retryAfterSec: drain?.globalBackoffUntil != null ? Math.max(0, drain.globalBackoffUntil - nowSec) : null,
  };
  const result = buildDispatchResult({
    snapshotSeeded: snapshotSeedCommitted,
    chatsWithActiveSnooze: sourceData.chatsWithActiveSnooze,
    eventOverrides: { ...eventOverrides, freeze: freeze.observed },
    pendingLifecycle: { drainResult, expiredCount: sweep.expired, pendingEnqueued: fanout.deliveriesPlanned },
    capacity: { before: capacityAfter, after: capacityAfter },
    reserve: { assessment: snapshotState.reserveSourceAssessment, unavailable: snapshotState.reserveSourceUnavailable },
    safety: {
      assessment: safetySourceAssessment,
      suppressed: safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
    },
    overrides: {
      ...(transportAllowed ? {} : { skipped: "circuit-open" }),
      ...(eventless ? { eventlessFastPath: true } : {}),
      subscribersNotified: drain?.acceptedChats ?? 0,
      suppressedSafetyChangesAtSeed,
      presetQueryFailures: fanout.presetQueryFailures,
      presetResolutionFailures: fanout.presetResolutionFailures,
      presetFailure: presetRunFailures > 0,
      cappedAtLimit: fanout.jobsFailedClosed > 0 || drain?.stoppedReason === "deadline",
    },
  });
  // Zero-send watchdog evidence: work this run actually made deliverable.
  const deliverablePlanned = Math.max(0, fanout.deliveriesPlanned - fanout.suppressedDuplicate);
  result.freezeTargetCount = deliverablePlanned;
  result.authoritativePlanning = {
    ...result.authoritativePlanning,
    sourceEventId: alertJobId,
    sourceEventFamilies: alertFamilies,
    plannedTargetCount: deliverablePlanned,
    duplicateSuppressedTargetCount: fanout.suppressedDuplicate,
    handoffEnqueuedCount: fanout.deliveriesPlanned,
    handoffPageCount: fanout.pages,
  };
  // R4: every incomplete stage names itself, in stage order. A thrown roll-up
  // hook names only itself, never fabricated sub-step outcomes.
  const reasons: string[] = [];
  if (planningErrors.length > 0) reasons.push("telegram-planning-failed");
  if (fanout.jobsFailedClosed > 0) reasons.push("fanout-page-failed");
  if (rollupStepFailed) reasons.push("telegram-rollup-step-failed");
  if (rollup?.rollup.state === "failed") reasons.push("telegram-rollup-failed");
  if (rollup?.rollup.state === "preset-resolution-failed") reasons.push("telegram-rollup-preset-resolution-failed");
  if (rollup?.freezeBatch.state === "failed") reasons.push("telegram-freeze-batch-failed");
  const metadata = {
    ...result,
    ...(reasons.length > 0 ? { reason: reasons[0], reasons } : {}),
    deliveryV2: {
      alertJobId,
      alertJobCreated,
      freezeJobsCreated: freeze.jobsCreated,
      freezeState: freeze.state,
      freezeBelowRealtimeThreshold: freeze.belowRealtimeThreshold.length,
      freezeSkippedNoAudience: freeze.skippedNoAudience,
      freezeRetractedCancelled: retractedFreeze ?? 0,
      heldKinds: holdKinds,
      fanoutPages: fanout.pages,
      deliveriesPlanned: fanout.deliveriesPlanned,
      suppressedDuplicate: fanout.suppressedDuplicate,
      jobsFailedClosed: fanout.jobsFailedClosed,
      jobsCancelled: fanout.jobsCancelled,
      cappedRows: fanout.cappedRows,
      rollupState: rollup?.rollup.state ?? "failed",
      rollupSentChats: rollup?.rollup.sentChats ?? 0,
      freezeBatchState: rollup?.freezeBatch.state ?? "failed",
      claimed: drain?.claimed ?? 0,
      sent: drain?.sent ?? 0,
      retried: drain?.retried ?? 0,
      failed: drain?.failed ?? 0,
      blocked: drain?.blocked ?? 0,
      unknown: drain?.unknown ?? 0,
      cancelled: drain?.cancelled ?? 0,
      drainStoppedReason: drain?.stoppedReason ?? (transportAllowed ? null : "circuit-open"),
      sweepSendingToUnknown: sweep.sendingToUnknown,
      sweepExpired: sweep.expired,
      jobsDone: sweep.jobsDone,
      planningErrors,
    },
    noWorkRun: reasons.length === 0 && !mustSeedSnapshots && attempted === 0 && fanout.deliveriesPlanned === 0 && sweep.expired === 0
      && !alertJobCreated && freeze.observed === 0,
  };
  await reportCronProgress(reportProgress, {
    stage: "complete",
    message: "Completed Telegram dispatch",
    providerFamily: "telegram-dispatch",
    itemsDone: sent,
    itemsTotal: Math.max(attempted, 1),
  });
  return {
    itemCount: sent,
    metadata: JSON.stringify(metadata),
    ...(reasons.length > 0
      ? {
        status: "degraded" as const,
        error: `Telegram dispatch incomplete: ${[...reasons, ...planningErrors].join(", ")}`,
      }
      : {}),
  };
}
