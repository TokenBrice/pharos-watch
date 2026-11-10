import {
  loadActiveAlertSafetySourceAssessment,
  type AlertSafetySourceAssessment,
} from "../../../lib/alert-safety-source-cache";
import { deleteCache, getCache, setCache } from "../../../lib/db-cache";
import type { CronResult } from "../../../lib/cron-logger";
import { createCronResult } from "../../../lib/cron-result";
import { logTelegramEvent } from "../../../telegram/common/log";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { TelegramDispatchCronMetadata } from "@shared/types/status";
import {
  parseTelegramDispatchCronMetadata,
  readMetadataNumber,
  readMetadataRecord,
} from "@shared/lib/status-metadata";
import {
  PENDING_DRAIN_TIME_ALERT_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
} from "../../../telegram/common/constants";
import {
  readTelegramPendingCapacity,
  type TelegramPendingCapacityReadResult,
  type TelegramPendingCapacitySnapshot,
} from "../../../telegram/outbox/pending-capacity";
import { throwIfAborted } from "../../../lib/abort";
import { parseJson } from "../../../lib/json-parse";
import { recordOperatorAlertReceipt } from "../../../lib/status/operator-alert-health";
import { deliverOperatorAlert } from "../../cron-sentinel-rules";
import { escapeHtml, type TelegramCreds } from "../../../telegram/delivery/telegram";

/**
 * Telegram dispatch degradation watchdog. Reads fresh signals after each
 * 5-minute dispatch run and reports degraded when delivery health crosses a
 * documented threshold. Clearing the threshold resets the corresponding
 * episode state.
 */

export const PENDING_BACKLOG_THRESHOLD = 500;
export const PENDING_BACKLOG_SUSTAINED_SEC = 20 * 60;
export const ZERO_SEND_STREAK_THRESHOLD = 3;
export const DELIVERY_ALERT_COOLDOWN_SEC = 30 * 60;

export const WATCHDOG_KEYS = {
  pendingSince: "telegram:degradation:pending-since",
  safetySourceSince: "telegram:degradation:safety-source-since",
  zeroSendStreak: "telegram:degradation:zero-send-streak",
  notifications: "telegram:degradation:notifications:v1",
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
    failureReason: string | null;
    ageSeconds: number | null;
    generation: string | null;
    sourcePublicationGenerationId: string | null;
    acceptedPublicationGenerationId: string | null;
    freshnessMaxAgeSec: number;
    assessedAtSec: number;
    heldSinceSec?: number | null;
    holdAgeSec?: number | null;
    holdReasonCodes?: string[];
  };
  zeroSend: WatchdogOutcome & {
    availability: "available" | "unknown";
    reason: string | null;
    streak: number | null;
    evaluated: boolean;
    runIdentity: string | null;
  };
};

export interface TelegramDegradationWatchdogOptions {
  operatorTelegramCreds?: TelegramCreds | null;
  pendingCapacitySnapshot?: TelegramPendingCapacitySnapshot | null;
  safetySourceAssessment?: AlertSafetySourceAssessment | null;
}

const DELIVERY_CONDITIONS = ["backlog", "near-ttl", "zero-send"] as const;
type DeliveryCondition = typeof DELIVERY_CONDITIONS[number];
interface DeliveryObservation {
  active: boolean;
  observedAt: number;
  detail: string;
}
interface DeliveryTransition extends DeliveryObservation {
  condition: DeliveryCondition;
}
interface PendingCondition extends DeliveryTransition {
  latest: DeliveryObservation;
  transitionCount: number;
}
interface NotificationState {
  version: 2;
  observed: DeliveryCondition[];
  acknowledged: DeliveryCondition[];
  pending: PendingCondition[];
  lastDeliveredAt: number | null;
}

function isDeliveryCondition(value: unknown): value is DeliveryCondition {
  return DELIVERY_CONDITIONS.some((condition) => condition === value);
}

function isDeliveryObservation(value: unknown): value is DeliveryObservation {
  const observation = readMetadataRecord(value);
  return observation != null && typeof observation.active === "boolean" &&
    typeof observation.observedAt === "number" && Number.isSafeInteger(observation.observedAt) &&
    observation.observedAt >= 0 && typeof observation.detail === "string";
}

function isDeliveryTransition(value: unknown): value is DeliveryTransition {
  return isDeliveryObservation(value) && isDeliveryCondition(readMetadataRecord(value)?.condition);
}

function isPendingCondition(value: unknown): value is PendingCondition {
  const entry = readMetadataRecord(value);
  return entry != null && isDeliveryTransition(value) && isDeliveryObservation(entry.latest) &&
    typeof entry.transitionCount === "number" && Number.isSafeInteger(entry.transitionCount) && entry.transitionCount > 0;
}

function captureTransition(pending: PendingCondition[], transition: DeliveryTransition): void {
  const { condition, active, observedAt, detail } = transition;
  const latest = { active, observedAt, detail };
  const prior = pending.find((entry) => entry.condition === condition);
  if (prior) {
    prior.latest = latest;
    prior.transitionCount++;
  } else {
    pending.push({ condition, ...latest, latest, transitionCount: 1 });
  }
}

async function readNotificationState(db: D1Database, signal?: AbortSignal): Promise<NotificationState> {
  const cached = await getCache(db, WATCHDOG_KEYS.notifications, signal);
  if (!cached) return { version: 2, observed: [], acknowledged: [], pending: [], lastDeliveredAt: null };
  const parsed = parseJson(cached.value);
  const state = parsed.ok ? readMetadataRecord(parsed.value) : null;
  if (
    (state?.version !== 1 && state?.version !== 2) ||
    !Array.isArray(state.observed) || !state.observed.every(isDeliveryCondition) ||
    !Array.isArray(state.acknowledged) || !state.acknowledged.every(isDeliveryCondition) ||
    !Array.isArray(state.pending) ||
    !(state.lastDeliveredAt === null ||
      (typeof state.lastDeliveredAt === "number" && Number.isSafeInteger(state.lastDeliveredAt) && state.lastDeliveredAt >= 0))
  ) throw new Error("telegram delivery notification state invalid");
  const pending: PendingCondition[] = [];
  if (state.version === 1) {
    if (!state.pending.every(isDeliveryTransition)) throw new Error("telegram delivery notification state invalid");
    for (const transition of state.pending) captureTransition(pending, transition);
  } else {
    if (!state.pending.every(isPendingCondition) ||
      new Set(state.pending.map((entry) => entry.condition)).size !== state.pending.length
    ) throw new Error("telegram delivery notification state invalid");
    pending.push(...state.pending);
  }
  const normalized: NotificationState = {
    version: 2, observed: state.observed, acknowledged: state.acknowledged,
    pending, lastDeliveredAt: state.lastDeliveredAt,
  };
  // Upgrade the existing durable key before transport; older writers fail closed on v2.
  if (state.version === 1) await setCache(db, WATCHDOG_KEYS.notifications, JSON.stringify(normalized), signal);
  return normalized;
}

function formatTransition(condition: DeliveryCondition, observation: DeliveryObservation): string {
  // Leave room for six HTML-escaped observations plus counts in one Telegram message.
  return `${observation.active ? "RAISED" : "RECOVERED"} ${condition} observed ${new Date(observation.observedAt * 1000).toISOString()}: ${escapeHtml(observation.detail.slice(0, 96))}`;
}

async function notifyDeliveryTransitions(
  db: D1Database,
  state: NotificationState,
  result: WatchdogResult,
  nowSec: number,
  creds: TelegramCreds | null,
  signal?: AbortSignal,
) {
  const { pendingBacklog, zeroSend } = result;
  const observations: Array<[DeliveryCondition, boolean | null, string | null]> = [
    ["backlog", pendingBacklog.availability === "available" && (pendingBacklog.triggered || pendingBacklog.recovered)
      ? pendingBacklog.triggered : null, pendingBacklog.detail],
    ["near-ttl", pendingBacklog.availability === "available"
      ? pendingBacklog.triggered && pendingBacklog.nearTtl != null && pendingBacklog.nearTtl > 0 : null, pendingBacklog.detail],
    ["zero-send", zeroSend.availability === "available" && zeroSend.runIdentity != null
      ? zeroSend.triggered : null, zeroSend.detail],
  ];
  let changed = false;
  for (const [condition, active, detail] of observations) {
    if (active == null || state.observed.includes(condition) === active) continue;
    captureTransition(state.pending, { condition, active, observedAt: nowSec, detail: detail ?? "threshold cleared" });
    state.observed = state.observed.filter((value) => value !== condition);
    if (active) state.observed.push(condition);
    changed = true;
  }
  // Keep recovery evidence until its notification history is durable.
  if (changed) await setCache(db, WATCHDOG_KEYS.notifications, JSON.stringify(state), signal);
  if (pendingBacklog.recovered) await deleteCache(db, WATCHDOG_KEYS.pendingSince);
  const transitions = state.pending;
  const cooldown = transitions.length > 0 && state.lastDeliveredAt != null &&
    nowSec - state.lastDeliveredAt < DELIVERY_ALERT_COOLDOWN_SEC;
  const unknownReason = pendingBacklog.availability === "unknown" ? "pending-backlog-unavailable"
    : zeroSend.availability === "unknown" ? "dispatch-evidence-unavailable" : null;
  let reason = transitions.length === 0 ? unknownReason
    : !creds ? "operator-alert-credentials-missing"
      : cooldown ? "operator-alert-cooldown" : "operator-alert-pending";
  let sent = false;
  let deliveryFailed = false;
  const receipt = () => recordOperatorAlertReceipt(db, "telegramDelivery", {
    nowSec, operatorConfigured: creds != null, pending: state.pending.length > 0, delivered: sent, reason,
  }, signal);
  await receipt();
  if (transitions.length > 0 && creds && !cooldown) {
    const text = [
      "<b>Telegram delivery-risk transitions</b>",
      ...transitions.flatMap((transition) => [
        `${transition.condition}: ${transition.transitionCount} transitions (${transition.transitionCount > 2 ? transition.transitionCount - 2 : 0} intervening)`,
        formatTransition(transition.condition, transition),
        ...(transition.transitionCount > 1 ? [`Latest: ${formatTransition(transition.condition, transition.latest)}`] : []),
      ]),
    ].join("\n");
    try {
      sent = (await deliverOperatorAlert(creds, text, signal)).ok;
    } catch {
      throwIfAborted(signal);
    }
    deliveryFailed = !sent;
    if (sent) {
      for (const transition of transitions) {
        state.acknowledged = state.acknowledged.filter((condition) => condition !== transition.condition);
        if (transition.latest.active) state.acknowledged.push(transition.condition);
      }
      state.pending = [];
      state.lastDeliveredAt = nowSec;
      await setCache(db, WATCHDOG_KEYS.notifications, JSON.stringify(state), signal);
    }
    reason = !sent ? "operator-alert-delivery-failed"
      : state.pending.length > 0 ? "operator-alert-cooldown" : unknownReason;
    await receipt();
  }
  return {
    raised: transitions.filter((transition) => transition.latest.active).map((transition) => transition.condition),
    recovered: transitions.filter((transition) => !transition.latest.active).map((transition) => transition.condition),
    sent, cooldown, deliveryFailed, pending: state.pending.length, reason,
  };
}

function emptyOutcome(): WatchdogOutcome {
  return { triggered: false, recovered: false, detail: null };
}

function logDispatchMetadataWarning(reason: string): void {
  logTelegramEvent({
    level: "warn",
    message: "dispatch metadata unavailable",
    action: "read-dispatch-metadata",
    module: "telegram-degradation-watchdog",
    reason,
  });
}

function hasMalformedDispatchCounts(value: unknown): boolean {
  const record = readMetadataRecord(value);
  if (!record) return true;
  const events = readMetadataRecord(record.eventsDetected);
  if (!events) return true;
  for (const key of [
    "dews",
    "depeg",
    "depegTriggered",
    "depegResolved",
    "depegWorsening",
    "safety",
    "launch",
    "reserve",
    "freeze",
    "suppressedMethodologyChanges",
  ] as const) {
    if (
      Object.prototype.hasOwnProperty.call(events, key) &&
      readMetadataNumber(events[key]) === null
    ) return true;
  }
  for (const key of ["messagesSent", "freezeTargetCount"] as const) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      readMetadataNumber(record[key]) === null
    ) return true;
  }
  return false;
}

/**
 * A planning-stage failure means detection never produced its counts; the
 * zero-filled `eventsDetected`/`messagesSent` defaults must not be read as an
 * observed empty run (ADR-29).
 */
function hasIncompletePlanning(value: unknown): boolean {
  const record = readMetadataRecord(value);
  if (!record) return false;
  if (record.reason === "telegram-planning-failed") return true;
  const reasons = record.reasons;
  if (Array.isArray(reasons) && reasons.includes("telegram-planning-failed")) return true;
  const delivery = readMetadataRecord(record.deliveryV2);
  const planningErrors = delivery?.planningErrors;
  return Array.isArray(planningErrors) && planningErrors.length > 0;
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

type DispatchMetadataReadResult =
  | {
    availability: "available";
    value: {
      runIdentity: string;
      metadata: TelegramDispatchCronMetadata;
    } | null;
  }
  | { availability: "unknown"; reason: string; runIdentity: string | null };

function unknownDispatchEvidence(reason: string, runIdentity: string | null): DispatchMetadataReadResult {
  logDispatchMetadataWarning(reason);
  return { availability: "unknown", reason, runIdentity };
}

async function readLatestDispatchMetadata(db: D1Database): Promise<DispatchMetadataReadResult> {
  try {
    // Exclude aborted/locked runs (error, skipped_locked) so a canceled dispatch
    // does not falsely reset the zero-send streak (post-release-review E.6).
    const row = await db
      .prepare(
        "SELECT id, metadata FROM cron_runs WHERE job = 'dispatch-telegram-alerts' AND status IN ('ok', 'degraded') ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .first<{ id: number | string; metadata: string | null }>();
    if (!row) return { availability: "available", value: null };
    const runIdentity = String(row.id);
    if (!row.metadata) return unknownDispatchEvidence("missing-metadata", runIdentity);
    const parsed = parseJson(row.metadata);
    if (!parsed.ok) return unknownDispatchEvidence("invalid-json", runIdentity);
    const metadata = parseTelegramDispatchCronMetadata(parsed.value);
    if (!metadata) return unknownDispatchEvidence("invalid-shape", runIdentity);
    if (hasMalformedDispatchCounts(parsed.value)) {
      return unknownDispatchEvidence("malformed-count", runIdentity);
    }
    if (hasIncompletePlanning(parsed.value)) {
      return unknownDispatchEvidence("planning-incomplete", runIdentity);
    }
    return { availability: "available", value: { runIdentity, metadata } };
  } catch {
    return unknownDispatchEvidence("read-failed", null);
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

type ZeroSendStateReadResult =
  | { state: ZeroSendState; reason: null }
  | { state: null; reason: string };

async function readZeroSendState(db: D1Database): Promise<ZeroSendStateReadResult> {
  let cached;
  try {
    cached = await getCache(db, WATCHDOG_KEYS.zeroSendStreak);
  } catch {
    return { state: null, reason: "streak-state-read-failed" };
  }
  if (!cached) return { state: { streak: 0, lastRunIdentity: null }, reason: null };
  const parsed = parseJson(cached.value);
  const value = parsed.ok ? parsed.value : null;
  const record = readMetadataRecord(value);
  if (parsed.ok && typeof value !== "number" && (
    !record || Object.keys(record).some((key) => key !== "streak" && key !== "lastRunIdentity")
  )) return { state: null, reason: "unsupported-streak-state" };
  const streak = typeof value === "number" ? value : record?.streak;
  const lastRunIdentity = typeof value === "number" ? null : record?.lastRunIdentity;
  if (
    typeof streak === "number" && Number.isSafeInteger(streak) && streak >= 0 &&
    (lastRunIdentity === null || (typeof lastRunIdentity === "string" && lastRunIdentity.length > 0)) &&
    (record == null || Object.keys(record).length === 2)
  ) return { state: { streak, lastRunIdentity }, reason: null };
  return { state: null, reason: "invalid-streak-state" };
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
    outcome.recovered = true;
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
    failureReason: assessment.failureReason ?? null,
    ageSeconds: assessment.ageSeconds,
    generation: assessment.generation,
    sourcePublicationGenerationId: assessment.sourcePublicationGenerationId,
    acceptedPublicationGenerationId: assessment.acceptedPublicationGenerationId,
    freshnessMaxAgeSec: assessment.freshnessMaxAgeSec,
    assessedAtSec: assessment.assessedAtSec,
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

function sumEvents(metadata: TelegramDispatchCronMetadata): number | null {
  const events = metadata?.eventsDetected;
  if (!events) return null;
  const { dews, depeg, safety, launch } = events;
  if (dews == null || depeg == null || safety == null || launch == null) return null;
  return dews + depeg + safety + launch + (events.reserve ?? 0) + (events.freeze ?? 0);
}

async function evaluateZeroSendStreak(
  db: D1Database,
  previouslyTriggered: boolean,
): Promise<WatchdogResult["zeroSend"]> {
  const dispatchRead = await readLatestDispatchMetadata(db);
  const latestRun = dispatchRead.availability === "available" ? dispatchRead.value : null;
  const { state: priorState, reason: stateReason } = await readZeroSendState(db);
  const outcome: WatchdogResult["zeroSend"] = {
    ...emptyOutcome(),
    triggered: priorState ? priorState.streak >= ZERO_SEND_STREAK_THRESHOLD : previouslyTriggered,
    availability: priorState ? dispatchRead.availability : "unknown",
    reason: stateReason ?? (dispatchRead.availability === "unknown" ? dispatchRead.reason : null),
    streak: priorState?.streak ?? null,
    evaluated: false,
    runIdentity: dispatchRead.availability === "unknown" ? dispatchRead.runIdentity : latestRun?.runIdentity ?? null,
  };

  if (!priorState) {
    if (
      stateReason === "invalid-streak-state" && latestRun &&
      latestRun.metadata.messagesSent != null && latestRun.metadata.messagesSent > 0 &&
      sumEvents(latestRun.metadata) != null
    ) {
      await writeZeroSendState(db, { streak: 0, lastRunIdentity: latestRun.runIdentity });
      return {
        ...outcome, availability: "available", reason: null, streak: 0, evaluated: true,
        triggered: false, recovered: previouslyTriggered,
        detail: "dispatch sent; invalid zero-send state reset",
      };
    }
    outcome.detail = "zero-send state unavailable; existing incident state preserved";
    return outcome;
  }
  const priorStreak = priorState.streak;

  if (!latestRun) {
    if (dispatchRead.availability === "available") outcome.reason = "no-completed-run";
    outcome.detail = "no admitted dispatch metadata; streak preserved";
    return outcome;
  }

  const metadata = latestRun.metadata;
  const events = sumEvents(metadata);
  const messagesSent = metadata.messagesSent;
  const planning = metadata.authoritativePlanning;
  const sourceFamilies = (["dews", "depeg", "safety", "launch", "reserve"] as const)
    .filter((family) => (metadata.eventsDetected?.[family] ?? 0) > 0);
  const planningApplies = planning?.sourceEventId != null &&
    planning.sourceEventFamilies != null &&
    sourceFamilies.every((family) => planning.sourceEventFamilies!.includes(family));
  const freezeEvents = metadata.eventsDetected?.freeze ?? 0;
  const freezeTargetCount = metadata.freezeTargetCount;
  const needsWorkload = events != null && events > 0 && messagesSent === 0;
  const missingReason = events == null || messagesSent == null ? "missing-count"
    : needsWorkload && sourceFamilies.length > 0 && planning?.plannedTargetCount == null ? "missing-planned-target-count"
      : needsWorkload && sourceFamilies.length > 0 && !planningApplies ? "source-workload-not-applicable"
        : needsWorkload && freezeEvents > 0 &&
          (freezeTargetCount == null || !Number.isInteger(freezeTargetCount) || freezeTargetCount < 0)
          ? "missing-freeze-target-count"
          : null;
  if (missingReason || events == null || messagesSent == null) {
    logDispatchMetadataWarning(missingReason ?? "missing-count");
    outcome.availability = "unknown";
    outcome.reason = missingReason ?? "missing-count";
    outcome.detail = "dispatch metadata unavailable; streak preserved";
    return outcome;
  }
  if (priorState.lastRunIdentity === latestRun.runIdentity) {
    outcome.reason = "already-evaluated";
    outcome.detail = `run=${latestRun.runIdentity} already evaluated`;
    return outcome;
  }
  outcome.evaluated = true;
  const zeroSendRun = needsWorkload &&
    ((sourceFamilies.length > 0 && planningApplies && planning!.plannedTargetCount! > 0) ||
      (freezeEvents > 0 && freezeTargetCount! > 0));

  if (zeroSendRun) {
    const nextStreak = priorStreak + 1;
    await writeZeroSendState(db, { streak: nextStreak, lastRunIdentity: latestRun.runIdentity });
    outcome.streak = nextStreak;
    outcome.triggered = nextStreak >= ZERO_SEND_STREAK_THRESHOLD;
    outcome.detail = `eventsDetected=${events}, sourceEventId=${planning?.sourceEventId}, plannedTargetCount=${planning?.plannedTargetCount}, freezeTargetCount=${freezeTargetCount}, streak=${nextStreak}`;
    return outcome;
  }

  outcome.streak = 0;
  outcome.triggered = false;
  await writeZeroSendState(db, { streak: 0, lastRunIdentity: latestRun.runIdentity });
  if (priorStreak >= ZERO_SEND_STREAK_THRESHOLD) {
    outcome.recovered = true;
    outcome.detail = `recovered after streak=${priorStreak}`;
  } else if (priorStreak > 0) {
    outcome.detail = `streak reset (priorStreak=${priorStreak})`;
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
  const notificationState = await readNotificationState(db, signal);

  const pendingBacklog = await evaluatePendingBacklog(db, nowSec, options.pendingCapacitySnapshot);
  const safetySource = await evaluateSafetySource(db, nowSec, options.safetySourceAssessment);
  const zeroSend = await evaluateZeroSendStreak(db, notificationState.observed.includes("zero-send"));

  const result: WatchdogResult = { pendingBacklog, safetySource, zeroSend };
  const creds = options.operatorTelegramCreds ?? null;
  const alertTransitions = await notifyDeliveryTransitions(
    db, notificationState, result, nowSec, creds, signal,
  );
  const operatorAlertDegraded = alertTransitions.deliveryFailed || (alertTransitions.pending > 0 && creds == null);
  const degraded =
    operatorAlertDegraded ||
    pendingBacklog.availability === "unknown" ||
    zeroSend.availability === "unknown" ||
    pendingBacklog.triggered ||
    safetySource.triggered ||
    zeroSend.triggered;

  return createCronResult({
    status: degraded ? "degraded" : "ok",
    metadata: {
      ...result,
      alertTransitions,
      reason: pendingBacklog.availability === "unknown" ? "pending-backlog-unavailable"
        : pendingBacklog.triggered ? "pending-backlog-threshold"
          : safetySource.triggered ? "safety-source-unavailable"
            : zeroSend.availability === "unknown" ? "dispatch-evidence-unavailable"
              : zeroSend.triggered ? "zero-send-streak"
                : alertTransitions.deliveryFailed ? "operator-alert-delivery-failed"
                  : operatorAlertDegraded ? "operator-alert-credentials-missing" : "watchdog-completed",
    },
  });
}
