import type { PreSendBatchResult, SendToChatResult } from "./telegram";
import {
  isBotWideTelegramFailure,
  isTransientTelegramOutageFailure,
} from "./telegram-transport-errors";

export const TELEGRAM_DELIVERY_MODES = ["fresh", "pending", "admin"] as const;
export type TelegramDeliveryMode = (typeof TELEGRAM_DELIVERY_MODES)[number];
export type TelegramTransportCircuitState = "closed" | "open" | "half_open";

const FAILURE_WINDOW_SEC = 60;
const TELEGRAM_TRANSPORT_OBSERVATION_RETENTION_SEC = 5 * 60;
const TELEGRAM_TRANSPORT_DISTINCT_CHAT_THRESHOLD = 3;
const DEFAULT_OUTAGE_BACKOFF_SEC = 60;
const AUTH_OUTAGE_BACKOFF_SEC = 15 * 60;
const PROBE_LEASE_SEC = 30;

interface CircuitRow {
  state: TelegramTransportCircuitState;
  generation: number;
  cause_class: string | null;
  cause_scope: "fatal" | "transient" | "rate_limit" | null;
  distinct_failure_count: number;
  first_failure_at: number | null;
  last_failure_at: number | null;
  last_success_at: number | null;
  opened_at: number | null;
  next_probe_at: number | null;
  probe_owner: string | null;
  probe_generation: number | null;
  probe_expires_at: number | null;
  probe_limit: number | null;
  probe_attempted: number;
  updated_at: number;
}

interface PauseRow {
  mode: TelegramDeliveryMode;
  generation: number;
  expires_at: number;
  reason: string;
  actor: string;
  created_at: number;
  updated_at: number;
}

export interface TelegramTransportCircuitSnapshot {
  state: TelegramTransportCircuitState;
  generation: number;
  causeClass: string | null;
  causeScope: "fatal" | "transient" | "rate_limit" | null;
  distinctFailureCount: number;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
  nextProbeAt: number | null;
  probeOwner: string | null;
  probeGeneration: number | null;
  probeExpiresAt: number | null;
  probeLimit: number | null;
  probeAttempted: number;
  updatedAt: number;
}

export interface TelegramDeliveryPauseSnapshot {
  mode: TelegramDeliveryMode;
  generation: number;
  active: boolean;
  expiresAt: number;
  reason: string;
  actor: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramTransportPermit {
  allowed: boolean;
  mode: TelegramDeliveryMode;
  maxDistinctChats: number;
  reason: "closed" | "half_open_probe" | "operator_pause" | "outage_open" | "probe_owned_elsewhere";
  circuitGeneration: number;
  probeOwner: string | null;
  probeGeneration: number | null;
  pauseGeneration: number | null;
  deferUntil: number | null;
}

export interface TelegramFreshHandoffAllowance {
  allowed: boolean;
  maxTargets: number;
  reason: "closed" | "probe_seed" | "operator_pause" | "outage_open" | "half_open";
  deferUntil: number | null;
}

export interface TelegramTransportOutcome {
  chatId: string;
  result: Pick<SendToChatResult, "ok" | "errorClass" | "rateLimitScope" | "retryAfterSec">;
}

function clampProbeLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.floor(value)));
}

function rowToCircuit(row: CircuitRow): TelegramTransportCircuitSnapshot {
  return {
    state: row.state,
    generation: row.generation,
    causeClass: row.cause_class,
    causeScope: row.cause_scope,
    distinctFailureCount: row.distinct_failure_count,
    firstFailureAt: row.first_failure_at,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    openedAt: row.opened_at,
    nextProbeAt: row.next_probe_at,
    probeOwner: row.probe_owner,
    probeGeneration: row.probe_generation,
    probeExpiresAt: row.probe_expires_at,
    probeLimit: row.probe_limit,
    probeAttempted: row.probe_attempted,
    updatedAt: row.updated_at,
  };
}

function rowToPause(row: PauseRow, nowSec: number): TelegramDeliveryPauseSnapshot {
  return {
    mode: row.mode,
    generation: row.generation,
    active: row.expires_at > nowSec,
    expiresAt: row.expires_at,
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readTelegramTransportCircuit(db: D1Database): Promise<TelegramTransportCircuitSnapshot> {
  const row = await db
    .prepare(
      `SELECT state, generation, cause_class, cause_scope, distinct_failure_count,
              first_failure_at, last_failure_at, last_success_at, opened_at, next_probe_at,
              probe_owner, probe_generation, probe_expires_at, probe_limit, probe_attempted, updated_at
         FROM telegram_transport_circuit
        WHERE singleton_id = 1`,
    )
    .first<CircuitRow>();
  if (!row) throw new Error("telegram_transport_circuit singleton is missing");
  return rowToCircuit(row);
}

export async function readTelegramDeliveryPauses(
  db: D1Database,
  nowSec: number,
): Promise<TelegramDeliveryPauseSnapshot[]> {
  const rows = await db
    .prepare(
      `SELECT mode, generation, expires_at, reason, actor, created_at, updated_at
         FROM telegram_delivery_pauses
        ORDER BY mode`,
    )
    .all<PauseRow>();
  return (rows.results ?? []).map((row) => rowToPause(row, nowSec));
}

export async function readTelegramDeliveryPause(
  db: D1Database,
  mode: TelegramDeliveryMode,
  nowSec: number,
): Promise<TelegramDeliveryPauseSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT mode, generation, expires_at, reason, actor, created_at, updated_at
         FROM telegram_delivery_pauses
        WHERE mode = ?`,
    )
    .bind(mode)
    .first<PauseRow>();
  return row ? rowToPause(row, nowSec) : null;
}

/**
 * Gate durable fresh-target handoff without consuming half-open send capacity.
 * A due open circuit may seed at most four pending targets so the pending
 * effect owner can claim the actual probe; all other open states hold targets
 * in their authoritative planned lifecycle.
 */
export async function readTelegramFreshHandoffAllowance(
  db: D1Database,
  nowSec: number,
  requestedTargets: number,
): Promise<TelegramFreshHandoffAllowance> {
  const requested = Math.max(0, Math.floor(requestedTargets));
  const [pause, circuit] = await Promise.all([
    readTelegramDeliveryPause(db, "fresh", nowSec),
    readTelegramTransportCircuit(db),
  ]);
  if (pause?.active) {
    return {
      allowed: false,
      maxTargets: 0,
      reason: "operator_pause",
      deferUntil: pause.expiresAt,
    };
  }
  if (circuit.state === "closed") {
    return { allowed: true, maxTargets: requested, reason: "closed", deferUntil: null };
  }
  if (circuit.state === "open" && (circuit.nextProbeAt == null || circuit.nextProbeAt <= nowSec)) {
    return {
      allowed: requested > 0,
      maxTargets: Math.min(4, requested),
      reason: "probe_seed",
      deferUntil: null,
    };
  }
  return {
    allowed: false,
    maxTargets: 0,
    reason: circuit.state === "half_open" ? "half_open" : "outage_open",
    deferUntil: circuit.probeExpiresAt ?? circuit.nextProbeAt,
  };
}

export function telegramTransportPermitSkip(
  permit: TelegramTransportPermit,
  nowSec: number,
): PreSendBatchResult {
  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: null,
    errorClass: "unknown",
    delivery: "retryable_failure",
    retryAfterSec: permit.deferUntil == null ? null : Math.max(1, permit.deferUntil - nowSec),
    skippedReason: permit.reason === "operator_pause" ? "delivery_mode_pause" : "transport_control",
  };
}

export function telegramDeliveryPauseSkip(
  pause: TelegramDeliveryPauseSnapshot,
  nowSec: number,
): PreSendBatchResult {
  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: null,
    errorClass: "unknown",
    delivery: "retryable_failure",
    retryAfterSec: Math.max(1, pause.expiresAt - nowSec),
    skippedReason: "delivery_mode_pause",
  };
}

export async function claimTelegramTransportPermit(
  db: D1Database,
  input: {
    mode: TelegramDeliveryMode;
    owner: string;
    nowSec: number;
    requestedDistinctChats: number;
  },
): Promise<TelegramTransportPermit> {
  const requested = Number.isFinite(input.requestedDistinctChats)
    ? Math.max(1, Math.floor(input.requestedDistinctChats))
    : 1;
  const pause = await readTelegramDeliveryPause(db, input.mode, input.nowSec);
  const circuit = await readTelegramTransportCircuit(db);
  if (pause?.active) {
    return {
      allowed: false,
      mode: input.mode,
      maxDistinctChats: 0,
      reason: "operator_pause",
      circuitGeneration: circuit.generation,
      probeOwner: null,
      probeGeneration: null,
      pauseGeneration: pause.generation,
      deferUntil: pause.expiresAt,
    };
  }
  if (circuit.state === "closed") {
    return {
      allowed: true,
      mode: input.mode,
      maxDistinctChats: requested,
      reason: "closed",
      circuitGeneration: circuit.generation,
      probeOwner: null,
      probeGeneration: null,
      pauseGeneration: pause?.generation ?? null,
      deferUntil: null,
    };
  }

  const probeLimit = clampProbeLimit(requested);

  const probeDue = circuit.nextProbeAt == null || circuit.nextProbeAt <= input.nowSec;
  const leaseExpired = circuit.probeExpiresAt == null || circuit.probeExpiresAt <= input.nowSec;
  if (!probeDue || (circuit.state === "half_open" && !leaseExpired && circuit.probeOwner !== input.owner)) {
    return {
      allowed: false,
      mode: input.mode,
      maxDistinctChats: 0,
      reason: circuit.state === "half_open" ? "probe_owned_elsewhere" : "outage_open",
      circuitGeneration: circuit.generation,
      probeOwner: circuit.probeOwner,
      probeGeneration: circuit.probeGeneration,
      pauseGeneration: pause?.generation ?? null,
      deferUntil: circuit.probeExpiresAt ?? circuit.nextProbeAt,
    };
  }

  const claim = await db
    .prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'half_open',
              generation = generation + 1,
              probe_owner = ?,
              probe_generation = generation + 1,
              probe_expires_at = ?,
              probe_limit = ?,
              probe_attempted = ?,
              updated_at = ?
        WHERE singleton_id = 1
          AND generation = ?
          AND state IN ('open', 'half_open')
          AND (next_probe_at IS NULL OR next_probe_at <= ?)
          AND (state = 'open' OR probe_expires_at IS NULL OR probe_expires_at <= ? OR probe_owner = ?)`,
    )
    .bind(
      input.owner,
      input.nowSec + PROBE_LEASE_SEC,
      probeLimit,
      0,
      input.nowSec,
      circuit.generation,
      input.nowSec,
      input.nowSec,
      input.owner,
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const winner = await readTelegramTransportCircuit(db);
    return {
      allowed: false,
      mode: input.mode,
      maxDistinctChats: 0,
      reason: winner.state === "open" ? "outage_open" : "probe_owned_elsewhere",
      circuitGeneration: winner.generation,
      probeOwner: winner.probeOwner,
      probeGeneration: winner.probeGeneration,
      pauseGeneration: pause?.generation ?? null,
      deferUntil: winner.probeExpiresAt ?? winner.nextProbeAt,
    };
  }
  return {
    allowed: true,
    mode: input.mode,
    maxDistinctChats: probeLimit,
    reason: "half_open_probe",
    circuitGeneration: circuit.generation + 1,
    probeOwner: input.owner,
    probeGeneration: circuit.generation + 1,
    pauseGeneration: pause?.generation ?? null,
    deferUntil: null,
  };
}

async function openCircuit(
  db: D1Database,
  input: {
    nowSec: number;
    causeClass: string;
    causeScope: "fatal" | "transient" | "rate_limit";
    distinctFailureCount: number;
    retryAfterSec?: number | null;
    expectedClosedGeneration?: number;
  },
): Promise<void> {
  const baseBackoff = input.causeScope === "fatal" ? AUTH_OUTAGE_BACKOFF_SEC : DEFAULT_OUTAGE_BACKOFF_SEC;
  const backoffSec = Math.max(baseBackoff, Math.min(3_600, input.retryAfterSec ?? 0));
  await db
    .prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'open',
              generation = generation + 1,
              cause_class = ?,
              cause_scope = ?,
              distinct_failure_count = ?,
              first_failure_at = COALESCE(first_failure_at, ?),
              last_failure_at = ?,
              opened_at = ?,
              next_probe_at = ?,
              probe_owner = NULL,
              probe_generation = NULL,
              probe_expires_at = NULL,
              probe_limit = NULL,
              probe_attempted = 0,
              updated_at = ?
        WHERE singleton_id = 1
          AND (? IS NULL OR (state = 'closed' AND generation = ?))`,
    )
    .bind(
      input.causeClass,
      input.causeScope,
      input.distinctFailureCount,
      input.nowSec,
      input.nowSec,
      input.nowSec,
      input.nowSec + backoffSec,
      input.nowSec,
      input.expectedClosedGeneration ?? null,
      input.expectedClosedGeneration ?? null,
    )
    .run();
}

async function recordClosedOutcomes(
  db: D1Database,
  outcomes: readonly TelegramTransportOutcome[],
  nowSec: number,
  expectedClosedGeneration: number,
): Promise<void> {
  const attempted = outcomes.filter((outcome) => outcome.result.errorClass != null || outcome.result.ok);
  const fatal = attempted.find((outcome) => outcome.result.errorClass === "auth_error");
  if (fatal) {
    await openCircuit(db, {
      nowSec,
      causeClass: "auth_error",
      causeScope: "fatal",
      distinctFailureCount: 1,
      expectedClosedGeneration,
    });
    return;
  }
  const explicitGlobal = attempted.find((outcome) => isBotWideTelegramFailure({
    errorClass: outcome.result.errorClass ?? "unknown",
    rateLimitScope: outcome.result.rateLimitScope,
  }));
  if (explicitGlobal) {
    await openCircuit(db, {
      nowSec,
      causeClass: "rate_limit",
      causeScope: "rate_limit",
      distinctFailureCount: 1,
      retryAfterSec: explicitGlobal.result.retryAfterSec,
      expectedClosedGeneration,
    });
    return;
  }

  const observations = new Map<string, { scope: "transient" | "rate_limit"; chatId: string; errorClass: string }>();
  for (const outcome of attempted) {
    const errorClass = outcome.result.errorClass;
    if (!errorClass) continue;
    const scope = errorClass === "rate_limit"
      ? "rate_limit"
      : isTransientTelegramOutageFailure({ errorClass })
        ? "transient"
        : null;
    if (!scope) continue;
    observations.set(`${scope}:${outcome.chatId}`, { scope, chatId: outcome.chatId, errorClass });
  }
  if (observations.size === 0) return;

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM telegram_transport_failure_observations WHERE observed_at < ?")
      .bind(nowSec - TELEGRAM_TRANSPORT_OBSERVATION_RETENTION_SEC),
  ];
  for (const observation of observations.values()) {
    statements.push(
      db.prepare(
        `INSERT INTO telegram_transport_failure_observations
           (failure_scope, chat_id, error_class, observed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(failure_scope, chat_id) DO UPDATE SET
           error_class = excluded.error_class,
           observed_at = excluded.observed_at`,
      ).bind(observation.scope, observation.chatId, observation.errorClass, nowSec),
    );
  }
  statements.push(
    db.prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'open',
              generation = generation + 1,
              cause_class = CASE
                WHEN (SELECT COUNT(*) FROM telegram_transport_failure_observations
                       WHERE failure_scope = 'transient' AND observed_at >= ?) >= ?
                THEN 'transient_threshold'
                ELSE 'rate_limit_threshold'
              END,
              cause_scope = CASE
                WHEN (SELECT COUNT(*) FROM telegram_transport_failure_observations
                       WHERE failure_scope = 'transient' AND observed_at >= ?) >= ?
                THEN 'transient'
                ELSE 'rate_limit'
              END,
              distinct_failure_count = MAX(
                (SELECT COUNT(*) FROM telegram_transport_failure_observations
                  WHERE failure_scope = 'transient' AND observed_at >= ?),
                (SELECT COUNT(*) FROM telegram_transport_failure_observations
                  WHERE failure_scope = 'rate_limit' AND observed_at >= ?)
              ),
              first_failure_at = COALESCE(first_failure_at, ?),
              last_failure_at = ?,
              opened_at = ?,
              next_probe_at = ?,
              probe_owner = NULL,
              probe_generation = NULL,
              probe_expires_at = NULL,
              probe_limit = NULL,
              probe_attempted = 0,
              updated_at = ?
        WHERE singleton_id = 1
          AND state = 'closed'
          AND generation = ?
          AND (
            (SELECT COUNT(*) FROM telegram_transport_failure_observations
              WHERE failure_scope = 'transient' AND observed_at >= ?) >= ?
            OR
            (SELECT COUNT(*) FROM telegram_transport_failure_observations
              WHERE failure_scope = 'rate_limit' AND observed_at >= ?) >= ?
          )`,
    ).bind(
      nowSec - FAILURE_WINDOW_SEC,
      TELEGRAM_TRANSPORT_DISTINCT_CHAT_THRESHOLD,
      nowSec - FAILURE_WINDOW_SEC,
      TELEGRAM_TRANSPORT_DISTINCT_CHAT_THRESHOLD,
      nowSec - FAILURE_WINDOW_SEC,
      nowSec - FAILURE_WINDOW_SEC,
      nowSec,
      nowSec,
      nowSec,
      nowSec + DEFAULT_OUTAGE_BACKOFF_SEC,
      nowSec,
      expectedClosedGeneration,
      nowSec - FAILURE_WINDOW_SEC,
      TELEGRAM_TRANSPORT_DISTINCT_CHAT_THRESHOLD,
      nowSec - FAILURE_WINDOW_SEC,
      TELEGRAM_TRANSPORT_DISTINCT_CHAT_THRESHOLD,
    ),
  );
  await db.batch(statements);
}

async function completeHalfOpenProbe(
  db: D1Database,
  permit: TelegramTransportPermit,
  outcomes: readonly TelegramTransportOutcome[],
  nowSec: number,
): Promise<void> {
  const attemptedByChat = new Map(outcomes.map((outcome) => [outcome.chatId, outcome]));
  const attempted = [...attemptedByChat.values()].slice(0, permit.maxDistinctChats);
  if (attempted.length === 0) return;
  const accounted = await db
    .prepare(
      `UPDATE telegram_transport_circuit
          SET probe_attempted = probe_attempted + ?,
              updated_at = ?
        WHERE singleton_id = 1
          AND state = 'half_open'
          AND generation = ?
          AND probe_owner = ?
          AND probe_generation = ?
          AND probe_attempted + ? <= probe_limit`,
    )
    .bind(
      attempted.length,
      nowSec,
      permit.circuitGeneration,
      permit.probeOwner,
      permit.probeGeneration,
      attempted.length,
    )
    .run();
  if ((accounted.meta.changes ?? 0) !== 1) return;

  const failure = attempted.find((outcome) => {
    const errorClass = outcome.result.errorClass;
    return errorClass != null && (
      errorClass === "auth_error"
      || (errorClass === "rate_limit" && outcome.result.rateLimitScope === "global")
      || isTransientTelegramOutageFailure({ errorClass })
    );
  });
  if (failure) {
    const errorClass = failure.result.errorClass ?? "unknown";
    await db
      .prepare(
        `UPDATE telegram_transport_circuit
            SET state = 'open',
                generation = generation + 1,
                cause_class = ?,
                cause_scope = ?,
                distinct_failure_count = 1,
                first_failure_at = COALESCE(first_failure_at, ?),
                last_failure_at = ?,
                opened_at = ?,
                next_probe_at = ?,
                probe_owner = NULL,
                probe_generation = NULL,
                probe_expires_at = NULL,
                probe_limit = NULL,
                probe_attempted = 0,
                updated_at = ?
          WHERE singleton_id = 1
            AND state = 'half_open'
            AND generation = ?
            AND probe_owner = ?
            AND probe_generation = ?`,
      )
      .bind(
        errorClass,
        errorClass === "auth_error" ? "fatal" : errorClass === "rate_limit" ? "rate_limit" : "transient",
        nowSec,
        nowSec,
        nowSec,
        nowSec + (errorClass === "auth_error" ? AUTH_OUTAGE_BACKOFF_SEC : DEFAULT_OUTAGE_BACKOFF_SEC),
        nowSec,
        permit.circuitGeneration,
        permit.probeOwner,
        permit.probeGeneration,
      )
      .run();
    return;
  }
  const definitiveReachability = attempted.some((outcome) =>
    outcome.result.ok
    || (outcome.result.errorClass != null && outcome.result.errorClass !== "rate_limit"),
  );
  if (!definitiveReachability) {
    const retryAfterSec = attempted.reduce(
      (maximum, outcome) => Math.max(maximum, outcome.result.retryAfterSec ?? 0),
      0,
    );
    await db
      .prepare(
        `UPDATE telegram_transport_circuit
            SET state = 'open',
                generation = generation + 1,
                next_probe_at = ?,
                probe_owner = NULL,
                probe_generation = NULL,
                probe_expires_at = NULL,
                probe_limit = NULL,
                probe_attempted = 0,
                updated_at = ?
          WHERE singleton_id = 1
            AND state = 'half_open'
            AND generation = ?
            AND probe_owner = ?
            AND probe_generation = ?`,
      )
      .bind(
        nowSec + Math.max(1, Math.min(3_600, retryAfterSec || DEFAULT_OUTAGE_BACKOFF_SEC)),
        nowSec,
        permit.circuitGeneration,
        permit.probeOwner,
        permit.probeGeneration,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'closed',
              generation = generation + 1,
              cause_class = NULL,
              cause_scope = NULL,
              distinct_failure_count = 0,
              first_failure_at = NULL,
              last_success_at = ?,
              opened_at = NULL,
              next_probe_at = NULL,
              probe_owner = NULL,
              probe_generation = NULL,
              probe_expires_at = NULL,
              probe_limit = NULL,
              probe_attempted = 0,
              updated_at = ?
        WHERE singleton_id = 1
          AND state = 'half_open'
          AND generation = ?
          AND probe_owner = ?
          AND probe_generation = ?`,
    )
    .bind(nowSec, nowSec, permit.circuitGeneration, permit.probeOwner, permit.probeGeneration)
    .run();
}

export async function recordTelegramTransportOutcomes(
  db: D1Database,
  permit: TelegramTransportPermit,
  outcomes: readonly TelegramTransportOutcome[],
  nowSec: number,
): Promise<TelegramTransportCircuitSnapshot> {
  if (!permit.allowed || outcomes.length === 0) return await readTelegramTransportCircuit(db);
  if (permit.reason === "half_open_probe") {
    await completeHalfOpenProbe(db, permit, outcomes, nowSec);
  } else {
    await recordClosedOutcomes(db, outcomes, nowSec, permit.circuitGeneration);
  }
  return await readTelegramTransportCircuit(db);
}

export async function setTelegramDeliveryPause(
  db: D1Database,
  input: {
    mode: TelegramDeliveryMode;
    expectedGeneration: number;
    expiresAt: number;
    reason: string;
    actor: string;
    nowSec: number;
    auditAction?: string;
  },
): Promise<TelegramDeliveryPauseSnapshot | null> {
  const mutation = db.prepare(
      `INSERT INTO telegram_delivery_pauses
         (mode, generation, expires_at, reason, actor, created_at, updated_at)
       SELECT ?, 1, ?, ?, ?, ?, ?
        WHERE ? = 0
       ON CONFLICT(mode) DO UPDATE SET
         generation = telegram_delivery_pauses.generation + 1,
         expires_at = excluded.expires_at,
         reason = excluded.reason,
         actor = excluded.actor,
         updated_at = excluded.updated_at
       WHERE telegram_delivery_pauses.generation = ?`,
    )
    .bind(
      input.mode,
      input.expiresAt,
      input.reason,
      input.actor,
      input.nowSec,
      input.nowSec,
      input.expectedGeneration,
      input.expectedGeneration,
    );
  const results = input.auditAction
    ? await db.batch([
        mutation,
        db.prepare(
          `INSERT INTO admin_action_audit
             (created_at, actor, action, target, result, http_status, details_json)
           SELECT ?, ?, ?, ?, 'ok', 200, ?
            WHERE changes() = 1`,
        ).bind(
          input.nowSec,
          input.actor,
          input.auditAction,
          input.mode,
          JSON.stringify({
            mode: input.mode,
            generation: input.expectedGeneration + 1,
            active: input.expiresAt > input.nowSec,
            expiresAt: input.expiresAt,
            reason: input.reason,
          }),
        ),
      ])
    : [await mutation.run()];
  const result = results[0];
  if (!result) return null;
  if ((result.meta.changes ?? 0) !== 1) return null;
  return await readTelegramDeliveryPause(db, input.mode, input.nowSec);
}

export async function resumeTelegramDelivery(
  db: D1Database,
  input: {
    mode: TelegramDeliveryMode;
    expectedGeneration: number;
    actor: string;
    nowSec: number;
    auditAction?: string;
  },
): Promise<TelegramDeliveryPauseSnapshot | null> {
  const mutation = db.prepare(
      `UPDATE telegram_delivery_pauses
          SET generation = generation + 1,
              expires_at = ?,
              reason = 'operator resume',
              actor = ?,
              updated_at = ?
        WHERE mode = ?
          AND generation = ?`,
    ).bind(input.nowSec, input.actor, input.nowSec, input.mode, input.expectedGeneration);
  const results = input.auditAction
    ? await db.batch([
        mutation,
        db.prepare(
          `INSERT INTO admin_action_audit
             (created_at, actor, action, target, result, http_status, details_json)
           SELECT ?, ?, ?, ?, 'ok', 200, ?
            WHERE changes() = 1`,
        ).bind(
          input.nowSec,
          input.actor,
          input.auditAction,
          input.mode,
          JSON.stringify({
            mode: input.mode,
            generation: input.expectedGeneration + 1,
            active: false,
            expiresAt: input.nowSec,
          }),
        ),
      ])
    : [await mutation.run()];
  const result = results[0];
  if (!result) return null;
  if ((result.meta.changes ?? 0) !== 1) return null;
  return await readTelegramDeliveryPause(db, input.mode, input.nowSec);
}

export async function pruneTelegramTransportObservations(db: D1Database, nowSec: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM telegram_transport_failure_observations WHERE observed_at < ?")
    .bind(nowSec - TELEGRAM_TRANSPORT_OBSERVATION_RETENTION_SEC)
    .run();
  return result.meta.changes ?? 0;
}
