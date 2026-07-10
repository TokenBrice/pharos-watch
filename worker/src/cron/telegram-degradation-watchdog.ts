import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  assessAlertSafetySourceCache,
  type AlertSafetySourceAssessment,
} from "../lib/alert-safety-source-cache";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { deliverOperationalAlert } from "../lib/operational-alert";
import type { CronResult } from "../lib/cron-logger";
import { logTelegramEvent } from "../lib/telegram-log";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import {
  PENDING_DRAIN_TIME_ALERT_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
} from "../lib/telegram-constants";
import {
  readPendingCapacity,
  type PendingCapacityReadResult,
  type PendingCapacitySnapshot,
} from "./telegram-pending";
import { throwIfAborted } from "../lib/abort";

/**
 * Telegram dispatch degradation watchdog. Reads fresh signals after each
 * 5-minute dispatch run and fires a one-shot alert when delivery health
 * crosses a documented threshold. Clearing the threshold emits a single
 * "recovered" alert and resets the corresponding cache flag.
 */

export const PENDING_BACKLOG_THRESHOLD = 500;
export const PENDING_BACKLOG_SUSTAINED_SEC = 20 * 60;
export const ZERO_SEND_STREAK_THRESHOLD = 3;

export const WATCHDOG_KEYS = {
  pendingSince: "telegram:degradation:pending-since",
  pendingAlerted: "telegram:degradation:pending-alerted",
  safetySourceSince: "telegram:degradation:safety-source-since",
  safetySourceAlerted: "telegram:degradation:safety-source-alerted",
  zeroSendStreak: "telegram:degradation:zero-send-streak",
  zeroSendAlerted: "telegram:degradation:zero-send-alerted",
} as const;

interface WatchdogAlertOutcome {
  triggered: boolean;
  recovered: boolean;
  alertSent: boolean;
  detail: string | null;
}

interface WatchdogResult {
  pendingBacklog: WatchdogAlertOutcome & {
    availability: "available" | "unknown";
    count: number | null;
    oldestAgeSec: number | null;
    estimatedDrainTimeSec: number | null;
    nearTtl: number | null;
    sending: number | null;
    executionUnknown: number | null;
    pendingExecutionUnknown: number | null;
    freshExecutionUnknown: number | null;
    oldestExecutionUnknownAgeSec: number | null;
    sentCleanup: number | null;
    executionUnknownLowerBound: boolean | null;
  };
  safetySource: WatchdogAlertOutcome & { state: string | null };
  zeroSend: WatchdogAlertOutcome & {
    streak: number;
    evaluated: boolean;
    runIdentity: string | null;
  };
}

export interface TelegramDegradationWatchdogOptions {
  pendingCapacitySnapshot?: PendingCapacitySnapshot | null;
  safetySourceAssessment?: AlertSafetySourceAssessment | null;
  alertBrokerMode?: string;
}

function emptyOutcome(): WatchdogAlertOutcome {
  return { triggered: false, recovered: false, alertSent: false, detail: null };
}

/**
 * Shared clear-episode logic: mark recovered, optionally send a recovery alert,
 * and delete the two cache keys only if the alert succeeded (or was not needed).
 * Returns { recovered: true, alertSent } to merge into the caller's outcome.
 */
async function clearEpisodeIfAlerted(
  db: D1Database,
  alreadyAlerted: boolean,
  sinceKey: string,
  alertedKey: string,
  sendRecoveryAlert: () => Promise<boolean>,
): Promise<{ recovered: true; alertSent: boolean }> {
  let canClearEpisode = true;
  let alertSent = false;
  if (alreadyAlerted) {
    alertSent = await sendRecoveryAlert();
    canClearEpisode = alertSent;
  }
  if (canClearEpisode) {
    await deleteCache(db, sinceKey);
    await deleteCache(db, alertedKey);
  }
  return { recovered: true, alertSent };
}

async function readLatestDispatchMetadata(db: D1Database) {
  try {
    // Exclude aborted/locked runs (error, skipped_locked) so a canceled dispatch
    // does not falsely reset the zero-send streak (post-release-review E.6).
    const row = await db
      .prepare(
        "SELECT id, metadata FROM cron_runs WHERE job = 'dispatch-telegram-alerts' AND status IN ('ok', 'degraded') ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .first<{ id: number | string; metadata: string | null }>();
    if (!row?.metadata) return null;
    const metadata = parseTelegramDispatchCronMetadata(JSON.parse(row.metadata));
    if (!metadata) return null;
    return {
      runIdentity: String(row.id),
      metadata,
    };
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "dispatch metadata unavailable",
      action: "read-dispatch-metadata",
      module: "telegram-degradation-watchdog",
    });
    return null;
  }
}

async function readCachedTimestamp(db: D1Database, key: string): Promise<number | null> {
  const cached = await getCache(db, key);
  if (!cached) return null;
  const parsed = Number(cached.value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ZeroSendState {
  streak: number;
  lastRunIdentity: string | null;
}

async function readZeroSendState(db: D1Database): Promise<ZeroSendState> {
  const cached = await getCache(db, WATCHDOG_KEYS.zeroSendStreak);
  if (!cached) return { streak: 0, lastRunIdentity: null };
  try {
    const parsed = JSON.parse(cached.value) as unknown;
    if (typeof parsed !== "object" || parsed == null) throw new Error("legacy zero-send state");
    const state = parsed as Partial<ZeroSendState>;
    const streak = Number(state.streak);
    return {
      streak: Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0,
      lastRunIdentity: typeof state.lastRunIdentity === "string" ? state.lastRunIdentity : null,
    };
  } catch {
    const legacyStreak = Number(cached.value);
    return {
      streak: Number.isFinite(legacyStreak) && legacyStreak > 0 ? Math.floor(legacyStreak) : 0,
      lastRunIdentity: null,
    };
  }
}

async function writeZeroSendState(db: D1Database, state: ZeroSendState): Promise<void> {
  await setCache(db, WATCHDOG_KEYS.zeroSendStreak, JSON.stringify(state));
}

async function readCachedFlag(db: D1Database, key: string): Promise<boolean> {
  const cached = await getCache(db, key);
  return cached?.value === "1";
}

async function evaluatePendingBacklog(
  db: D1Database,
  alertWebhookUrl: string | null,
  nowSec: number,
  preloadedCapacity?: PendingCapacitySnapshot | null,
  alertBrokerMode?: string,
): Promise<WatchdogResult["pendingBacklog"]> {
  const capacityRead: PendingCapacityReadResult = preloadedCapacity
    ? { status: "available", value: preloadedCapacity }
    : await readPendingCapacity(db, nowSec);
  const capacity = capacityRead.status === "available" ? capacityRead.value : null;
  const count = capacity?.active ?? null;
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.pendingSince);
  const alreadyAlerted = await readCachedFlag(db, WATCHDOG_KEYS.pendingAlerted);
  const oldestAgeSec = capacity?.oldestPendingAgeSec ?? null;
  const estimatedDrainTimeSec = capacity?.estimatedDrainTimeSec ?? null;
  const nearTtl = capacity?.nearTtl ?? null;
  const outcome: WatchdogResult["pendingBacklog"] = {
    ...emptyOutcome(),
    availability: capacityRead.status,
    count,
    oldestAgeSec,
    estimatedDrainTimeSec,
    nearTtl,
    sending: capacity?.sending ?? null,
    executionUnknown: capacity?.executionUnknown ?? null,
    pendingExecutionUnknown: capacity?.pendingExecutionUnknown ?? null,
    freshExecutionUnknown: capacity?.freshExecutionUnknown ?? null,
    oldestExecutionUnknownAgeSec: capacity?.oldestExecutionUnknownAgeSec ?? null,
    sentCleanup: capacity?.sentCleanup ?? null,
    executionUnknownLowerBound: capacity?.executionUnknownLowerBound ?? null,
  };

  if (!capacity || count == null) {
    outcome.detail = "capacity unavailable; existing incident state preserved";
    return outcome;
  }

  const countBreached = count > PENDING_BACKLOG_THRESHOLD;
  const oldestBreached = (oldestAgeSec ?? 0) >= PENDING_OLD_AGE_ALERT_SEC;
  const drainBreached = (estimatedDrainTimeSec ?? 0) >= PENDING_DRAIN_TIME_ALERT_SEC;
  const nearTtlBreached = (nearTtl ?? 0) > 0;
  const executionUnknownBreached = capacity.executionUnknown > 0
    && (capacity.oldestExecutionUnknownAgeSec ?? 0) >= PENDING_OLD_AGE_ALERT_SEC;
  const breached = countBreached || oldestBreached || drainBreached || nearTtlBreached || executionUnknownBreached;
  const breachReasons = [
    countBreached ? `pending=${count}>${PENDING_BACKLOG_THRESHOLD}` : null,
    oldestBreached ? `oldestAgeSec=${oldestAgeSec}>=${PENDING_OLD_AGE_ALERT_SEC}` : null,
    drainBreached ? `estimatedDrainTimeSec=${estimatedDrainTimeSec}>=${PENDING_DRAIN_TIME_ALERT_SEC}` : null,
    nearTtlBreached ? `nearTtl=${nearTtl} within ${PENDING_NEAR_TTL_WINDOW_SEC}s of expiry` : null,
    executionUnknownBreached
      ? `executionUnknown=${capacity.executionUnknown}, oldestExecutionUnknownAgeSec=${capacity.oldestExecutionUnknownAgeSec}`
      : null,
  ].filter((reason): reason is string => reason != null);

  if (breached) {
    if (flagSince == null) {
      await setCache(db, WATCHDOG_KEYS.pendingSince, String(nowSec));
      outcome.detail = `${breachReasons.join(", ")} (newly tripped, watching for sustained breach)`;
      return outcome;
    }
    const ageSec = Math.max(0, nowSec - flagSince);
    if (ageSec >= PENDING_BACKLOG_SUSTAINED_SEC || nearTtlBreached) {
      outcome.triggered = true;
      if (!alreadyAlerted) {
        outcome.alertSent = await deliverOperationalAlert({
          db,
          conditionKey: "telegram:pending-delivery-risk",
          active: true,
          severity: "critical",
          title: "Telegram pending delivery risk",
          message: `${breachReasons.join(", ")} for ${Math.round(ageSec / 60)}min`,
          recoveryTitle: "Telegram pending backlog recovered",
          recoveryMessage: `pending=${count} (cleared after sustained breach)`,
          fingerprint: { condition: "telegram-pending-delivery-risk" },
          metadata: {
            count,
            oldestAgeSec,
            estimatedDrainTimeSec,
            nearTtl,
            sending: capacity.sending,
            executionUnknown: capacity.executionUnknown,
            pendingExecutionUnknown: capacity.pendingExecutionUnknown,
            freshExecutionUnknown: capacity.freshExecutionUnknown,
            oldestExecutionUnknownAgeSec: capacity.oldestExecutionUnknownAgeSec,
            sentCleanup: capacity.sentCleanup,
            executionUnknownLowerBound: capacity.executionUnknownLowerBound,
          },
          webhookUrl: alertWebhookUrl,
          brokerMode: alertBrokerMode,
        });
        if (outcome.alertSent) {
          await setCache(db, WATCHDOG_KEYS.pendingAlerted, "1");
        }
      }
      outcome.detail = `${breachReasons.join(", ")}, sustainedSec=${ageSec}`;
    } else {
      outcome.detail = `${breachReasons.join(", ")}, ageSec=${ageSec}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    const cleared = await clearEpisodeIfAlerted(
      db,
      alreadyAlerted,
      WATCHDOG_KEYS.pendingSince,
      WATCHDOG_KEYS.pendingAlerted,
      () => deliverOperationalAlert({
        db,
        conditionKey: "telegram:pending-delivery-risk",
        active: false,
        severity: "critical",
        title: "Telegram pending delivery risk",
        message: `pending=${count}`,
        recoveryTitle: "Telegram pending backlog recovered",
        recoveryMessage: `pending=${count} (cleared after sustained breach)`,
        webhookUrl: alertWebhookUrl,
        brokerMode: alertBrokerMode,
      }),
    );
    outcome.recovered = cleared.recovered;
    outcome.alertSent = cleared.alertSent;
    outcome.detail = `pending=${count}, recovered`;
  }
  return outcome;
}

async function evaluateSafetySource(
  db: D1Database,
  alertWebhookUrl: string | null,
  nowSec: number,
  preloadedAssessment?: AlertSafetySourceAssessment | null,
  alertBrokerMode?: string,
): Promise<WatchdogResult["safetySource"]> {
  const producerIntervalSec = CRON_INTERVALS["publish-report-card-cache"];
  const sustainedSec = producerIntervalSec * 2;
  const assessment = preloadedAssessment ?? assessAlertSafetySourceCache(
    await getCache(db, ALERT_SAFETY_SOURCE_CACHE_KEY),
    { nowSec, producerIntervalSec },
  );
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.safetySourceSince);
  const alreadyAlerted = await readCachedFlag(db, WATCHDOG_KEYS.safetySourceAlerted);
  const outcome: WatchdogResult["safetySource"] = { ...emptyOutcome(), state: assessment.state };

  if (assessment.state !== "ok") {
    if (flagSince == null) {
      await setCache(db, WATCHDOG_KEYS.safetySourceSince, String(nowSec));
      outcome.detail = `state=${assessment.state} (newly tripped)`;
      return outcome;
    }
    const ageSec = Math.max(0, nowSec - flagSince);
    if (ageSec >= sustainedSec) {
      outcome.triggered = true;
      if (!alreadyAlerted) {
        outcome.alertSent = await deliverOperationalAlert({
          db,
          conditionKey: "telegram:safety-source-cache-degraded",
          active: true,
          severity: "warning",
          title: "Telegram safety-source cache degraded",
          message: `state=${assessment.state} for ${Math.round(ageSec / 60)}min ` +
            `(>${Math.round(sustainedSec / 60)}min, ageSeconds=${assessment.ageSeconds ?? "n/a"})`,
          recoveryTitle: "Telegram safety-source cache recovered",
          recoveryMessage: "state=ok",
          fingerprint: { condition: "telegram-safety-source-cache-degraded" },
          metadata: { state: assessment.state, ageSeconds: assessment.ageSeconds },
          webhookUrl: alertWebhookUrl,
          brokerMode: alertBrokerMode,
        });
        if (outcome.alertSent) {
          await setCache(db, WATCHDOG_KEYS.safetySourceAlerted, "1");
        }
      }
      outcome.detail = `state=${assessment.state}, sustainedSec=${ageSec}`;
    } else {
      outcome.detail = `state=${assessment.state}, ageSec=${ageSec}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    const cleared = await clearEpisodeIfAlerted(
      db,
      alreadyAlerted,
      WATCHDOG_KEYS.safetySourceSince,
      WATCHDOG_KEYS.safetySourceAlerted,
      () => deliverOperationalAlert({
        db,
        conditionKey: "telegram:safety-source-cache-degraded",
        active: false,
        severity: "warning",
        title: "Telegram safety-source cache degraded",
        message: "state=ok",
        recoveryTitle: "Telegram safety-source cache recovered",
        recoveryMessage: "state=ok",
        webhookUrl: alertWebhookUrl,
        brokerMode: alertBrokerMode,
      }),
    );
    outcome.recovered = cleared.recovered;
    outcome.alertSent = cleared.alertSent;
    outcome.detail = "state=ok, recovered";
  }
  return outcome;
}

function sumEvents(metadata: ReturnType<typeof parseTelegramDispatchCronMetadata>): number {
  const events = metadata?.eventsDetected;
  if (!events) return 0;
  return (
    (events.dews ?? 0) +
    (events.depeg ?? 0) +
    (events.safety ?? 0) +
    (events.launch ?? 0) +
    (events.reserve ?? 0)
  );
}

async function evaluateZeroSendStreak(
  db: D1Database,
  alertWebhookUrl: string | null,
  alertBrokerMode?: string,
): Promise<WatchdogResult["zeroSend"]> {
  const latestRun = await readLatestDispatchMetadata(db);
  const priorState = await readZeroSendState(db);
  const priorStreak = priorState.streak;
  const alreadyAlerted = await readCachedFlag(db, WATCHDOG_KEYS.zeroSendAlerted);
  const outcome: WatchdogResult["zeroSend"] = {
    ...emptyOutcome(),
    streak: priorStreak,
    evaluated: false,
    runIdentity: latestRun?.runIdentity ?? null,
  };

  if (!latestRun) {
    outcome.detail = "dispatch metadata unavailable; streak preserved";
    return outcome;
  }
  if (priorState.lastRunIdentity === latestRun.runIdentity) {
    outcome.detail = `run=${latestRun.runIdentity} already evaluated`;
    return outcome;
  }

  outcome.evaluated = true;
  const metadata = latestRun.metadata;

  const events = sumEvents(metadata);
  const messagesSent = metadata.messagesSent ?? 0;
  const freshCandidateChats = metadata.freshCandidateChats ?? 0;
  const zeroSendRun = events > 0 && messagesSent === 0 && freshCandidateChats > 0;

  if (zeroSendRun) {
    const nextStreak = priorStreak + 1;
    await writeZeroSendState(db, { streak: nextStreak, lastRunIdentity: latestRun.runIdentity });
    outcome.streak = nextStreak;
    if (nextStreak >= ZERO_SEND_STREAK_THRESHOLD) {
      outcome.triggered = true;
      if (!alreadyAlerted) {
        outcome.alertSent = await deliverOperationalAlert({
          db,
          conditionKey: "telegram:zero-send-with-events",
          active: true,
          severity: "critical",
          title: "Telegram dispatch sent zero messages with pending events",
          message: `eventsDetected=${events}, freshCandidateChats=${freshCandidateChats}, messagesSent=0, consecutiveZeroSendRuns=${nextStreak}`,
          recoveryTitle: "Telegram dispatch zero-send streak recovered",
          recoveryMessage: `messagesSent=${messagesSent}, eventsDetected=${events}`,
          fingerprint: { condition: "telegram-zero-send-with-events" },
          metadata: {
            events,
            freshCandidateChats,
            messagesSent,
            streak: nextStreak,
            dispatchRunIdentity: latestRun.runIdentity,
          },
          webhookUrl: alertWebhookUrl,
          brokerMode: alertBrokerMode,
        });
        if (outcome.alertSent) {
          await setCache(db, WATCHDOG_KEYS.zeroSendAlerted, "1");
        }
      }
      outcome.detail = `eventsDetected=${events}, freshCandidateChats=${freshCandidateChats}, streak=${nextStreak}`;
    } else {
      outcome.detail = `eventsDetected=${events}, freshCandidateChats=${freshCandidateChats}, streak=${nextStreak}`;
    }
    return outcome;
  }

  if (priorStreak >= ZERO_SEND_STREAK_THRESHOLD) {
    outcome.streak = 0;
    const cleared = await clearEpisodeIfAlerted(
      db,
      alreadyAlerted,
      WATCHDOG_KEYS.zeroSendStreak,
      WATCHDOG_KEYS.zeroSendAlerted,
      () => deliverOperationalAlert({
        db,
        conditionKey: "telegram:zero-send-with-events",
        active: false,
        severity: "critical",
        title: "Telegram dispatch sent zero messages with pending events",
        message: `messagesSent=${messagesSent}, eventsDetected=${events}`,
        recoveryTitle: "Telegram dispatch zero-send streak recovered",
        recoveryMessage: `messagesSent=${messagesSent}, eventsDetected=${events}`,
        webhookUrl: alertWebhookUrl,
        brokerMode: alertBrokerMode,
      }),
    );
    outcome.recovered = cleared.recovered;
    outcome.alertSent = cleared.alertSent;
    outcome.detail = `recovered after streak=${priorStreak}`;
    return outcome;
  }

  if (priorStreak > 0) {
    await writeZeroSendState(db, { streak: 0, lastRunIdentity: latestRun.runIdentity });
    outcome.streak = 0;
    outcome.detail = `streak reset (priorStreak=${priorStreak})`;
  } else {
    await writeZeroSendState(db, { streak: 0, lastRunIdentity: latestRun.runIdentity });
  }
  return outcome;
}

export async function runTelegramDegradationWatchdog(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
  options: TelegramDegradationWatchdogOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);

  const pendingBacklog = await evaluatePendingBacklog(
    db,
    alertWebhookUrl,
    nowSec,
    options.pendingCapacitySnapshot,
    options.alertBrokerMode,
  );
  const safetySource = await evaluateSafetySource(
    db,
    alertWebhookUrl,
    nowSec,
    options.safetySourceAssessment,
    options.alertBrokerMode,
  );
  const zeroSend = await evaluateZeroSendStreak(db, alertWebhookUrl, options.alertBrokerMode);

  const result: WatchdogResult = { pendingBacklog, safetySource, zeroSend };
  const degraded = pendingBacklog.availability === "unknown"
    || pendingBacklog.triggered
    || safetySource.triggered
    || zeroSend.triggered;

  return {
    status: degraded ? "degraded" : "ok",
    metadata: JSON.stringify(result),
  };
}
