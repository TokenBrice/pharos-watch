import {
  loadActiveAlertSafetySourceAssessment,
  type AlertSafetySourceAssessment,
} from "../lib/alert-safety-source-cache";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { logTelegramEvent } from "../lib/telegram/log";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import {
  PENDING_DRAIN_TIME_ALERT_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
} from "../lib/telegram/constants";
import {
  readTelegramPendingCapacity,
  type TelegramPendingCapacityReadResult,
  type TelegramPendingCapacitySnapshot,
} from "../lib/telegram/pending-capacity";
import { throwIfAborted } from "../lib/abort";
import { parseJson } from "../lib/json-parse";

/**
 * Telegram dispatch degradation watchdog. Reads fresh signals after each
 * 5-minute dispatch run and reports degraded when delivery health crosses a
 * documented threshold. Clearing the threshold resets the corresponding
 * episode state.
 */

export const PENDING_BACKLOG_THRESHOLD = 500;
export const PENDING_BACKLOG_SUSTAINED_SEC = 20 * 60;
export const ZERO_SEND_STREAK_THRESHOLD = 3;

export const WATCHDOG_KEYS = {
  pendingSince: "telegram:degradation:pending-since",
  safetySourceSince: "telegram:degradation:safety-source-since",
  zeroSendStreak: "telegram:degradation:zero-send-streak",
} as const;

type WatchdogOutcome = {
  triggered: boolean;
  recovered: boolean;
  detail: string | null;
};

type WatchdogResult = {
  pendingBacklog: WatchdogOutcome & {
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
  safetySource: WatchdogOutcome & {
    state: string | null;
    heldSinceSec?: number | null;
    holdAgeSec?: number | null;
    holdReasonCodes?: string[];
  };
  zeroSend: WatchdogOutcome & {
    streak: number;
    evaluated: boolean;
    runIdentity: string | null;
  };
};

export interface TelegramDegradationWatchdogOptions {
  pendingCapacitySnapshot?: TelegramPendingCapacitySnapshot | null;
  safetySourceAssessment?: AlertSafetySourceAssessment | null;
}

function emptyOutcome(): WatchdogOutcome {
  return { triggered: false, recovered: false, detail: null };
}

/**
 * Shared clear-episode logic: mark recovered and unconditionally delete the
 * episode state.
 */
async function clearEpisode(
  db: D1Database,
  sinceKey: string,
): Promise<{ recovered: true }> {
  await deleteCache(db, sinceKey);
  return { recovered: true };
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
    const parsed = parseJson(row.metadata);
    if (!parsed.ok) return null;
    const metadata = parseTelegramDispatchCronMetadata(parsed.value);
    if (!metadata) return null;
    return {
      runIdentity: String(row.id),
      metadata,
    };
  } catch {
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
    const parsedResult = parseJson(cached.value);
    if (!parsedResult.ok) throw new Error("legacy zero-send state");
    const parsed = parsedResult.value;
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

async function evaluatePendingBacklog(
  db: D1Database,
  nowSec: number,
  preloadedCapacity?: TelegramPendingCapacitySnapshot | null,
): Promise<WatchdogResult["pendingBacklog"]> {
  const capacityRead: TelegramPendingCapacityReadResult = preloadedCapacity
    ? { status: "available", value: preloadedCapacity }
    : await readTelegramPendingCapacity(db, nowSec);
  const capacity = capacityRead.status === "available" ? capacityRead.value : null;
  const count = capacity?.active ?? null;
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.pendingSince);
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
  const executionUnknownBreached =
    capacity.executionUnknown > 0 && (capacity.oldestExecutionUnknownAgeSec ?? 0) >= PENDING_OLD_AGE_ALERT_SEC;
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
      outcome.detail = `${breachReasons.join(", ")}, sustainedSec=${ageSec}`;
    } else {
      outcome.detail = `${breachReasons.join(", ")}, ageSec=${ageSec}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    const cleared = await clearEpisode(
      db,
      WATCHDOG_KEYS.pendingSince,
    );
    outcome.recovered = cleared.recovered;
    outcome.detail = `pending=${count}, recovered`;
  }
  return outcome;
}

async function evaluateSafetySource(
  db: D1Database,
  nowSec: number,
  preloadedAssessment?: AlertSafetySourceAssessment | null,
): Promise<WatchdogResult["safetySource"]> {
  const producerIntervalSec = CRON_INTERVALS["compute-safety-score-v9"];
  const sustainedSec = producerIntervalSec * 2;
  const assessment =
    preloadedAssessment ??
    await loadActiveAlertSafetySourceAssessment(db, nowSec);
  const flagSince = await readCachedTimestamp(db, WATCHDOG_KEYS.safetySourceSince);
  const carriesHeldDiagnostics =
    assessment.heldSinceSec !== undefined ||
    assessment.holdReasonCodes !== undefined;
  const heldSinceSec = assessment.heldSinceSec ?? null;
  const holdAgeSec = heldSinceSec == null
    ? null
    : Math.max(0, nowSec - heldSinceSec);
  const holdReasonCodes = assessment.holdReasonCodes ?? [];
  const heldDetail = carriesHeldDiagnostics
    ? `, heldSinceSec=${heldSinceSec ?? "null"}, holdAgeSec=${holdAgeSec ?? "null"}, holdReasonCodes=${holdReasonCodes.join("|") || "none"}`
    : "";
  const outcome: WatchdogResult["safetySource"] = {
    ...emptyOutcome(),
    state: assessment.state,
    ...(carriesHeldDiagnostics
      ? { heldSinceSec, holdAgeSec, holdReasonCodes }
      : {}),
  };

  if (assessment.state !== "ok") {
    if (flagSince == null) {
      await setCache(db, WATCHDOG_KEYS.safetySourceSince, String(nowSec));
      outcome.detail = `state=${assessment.state}${heldDetail} (newly tripped)`;
      return outcome;
    }
    const ageSec = Math.max(0, nowSec - flagSince);
    if (ageSec >= sustainedSec) {
      outcome.triggered = true;
      outcome.detail = `state=${assessment.state}, sustainedSec=${ageSec}${heldDetail}`;
    } else {
      outcome.detail = `state=${assessment.state}, ageSec=${ageSec}${heldDetail}`;
    }
    return outcome;
  }

  if (flagSince != null) {
    const cleared = await clearEpisode(
      db,
      WATCHDOG_KEYS.safetySourceSince,
    );
    outcome.recovered = cleared.recovered;
    outcome.detail = "state=ok, recovered";
  }
  return outcome;
}

function sumEvents(metadata: ReturnType<typeof parseTelegramDispatchCronMetadata>): number {
  const events = metadata?.eventsDetected;
  if (!events) return 0;
  return (events.dews ?? 0) + (events.depeg ?? 0) + (events.safety ?? 0) + (events.launch ?? 0) + (events.reserve ?? 0);
}

async function evaluateZeroSendStreak(
  db: D1Database,
): Promise<WatchdogResult["zeroSend"]> {
  const latestRun = await readLatestDispatchMetadata(db);
  const priorState = await readZeroSendState(db);
  const priorStreak = priorState.streak;
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
      outcome.detail = `eventsDetected=${events}, freshCandidateChats=${freshCandidateChats}, streak=${nextStreak}`;
    } else {
      outcome.detail = `eventsDetected=${events}, freshCandidateChats=${freshCandidateChats}, streak=${nextStreak}`;
    }
    return outcome;
  }

  if (priorStreak >= ZERO_SEND_STREAK_THRESHOLD) {
    outcome.streak = 0;
    const cleared = await clearEpisode(
      db,
      WATCHDOG_KEYS.zeroSendStreak,
    );
    outcome.recovered = cleared.recovered;
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
  signal?: AbortSignal,
  options: TelegramDegradationWatchdogOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);

  const nowSec = Math.floor(Date.now() / 1000);

  const pendingBacklog = await evaluatePendingBacklog(db, nowSec, options.pendingCapacitySnapshot);
  const safetySource = await evaluateSafetySource(db, nowSec, options.safetySourceAssessment);
  const zeroSend = await evaluateZeroSendStreak(db);

  const result: WatchdogResult = { pendingBacklog, safetySource, zeroSend };
  const degraded =
    pendingBacklog.availability === "unknown" ||
    pendingBacklog.triggered ||
    safetySource.triggered ||
    zeroSend.triggered;

  return createCronResult({
    status: degraded ? "degraded" : "ok",
    metadata: result,
  });
}
