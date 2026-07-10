import { fnv1aHash } from "./hash";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { sendAlert } from "./alerts";
import { toErrorMessage } from "./error-utils";

export type AlertBrokerMode = "off" | "shadow" | "status" | "alert";
export type AlertBrokerSeverity = "warning" | "critical";
export type AlertBrokerTransition = "incident" | "recovery";

type PersistedAlertBrokerMode = Exclude<AlertBrokerMode, "off">;
type AlertConditionState = "pending" | "active" | "recovered";
type AlertDeliveryState =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "missing_target"
  | "shadow"
  | "status_only";

interface AlertConditionRow {
  condition_key: string;
  fingerprint: string;
  state: AlertConditionState;
  mode: PersistedAlertBrokerMode;
  severity: AlertBrokerSeverity;
  generation: number;
  episode: number;
  streak: number;
  first_observed_at: number;
  last_observed_at: number;
  activated_at: number | null;
  recovered_at: number | null;
  cooldown_until: number | null;
  title: string;
  message: string;
  recovery_title: string | null;
  recovery_message: string | null;
  metadata_json: string | null;
  last_transition: AlertBrokerTransition | null;
  updated_at: number;
}

interface AlertDeliveryRow {
  delivery_id: string;
  condition_key: string;
  fingerprint: string;
  episode: number;
  transition: AlertBrokerTransition;
  state: AlertDeliveryState;
  mode: PersistedAlertBrokerMode;
  target_class: string;
  title: string;
  message: string;
  attempts: number;
  next_attempt_at: number | null;
  delivery_lease_until: number | null;
}

export interface AlertBrokerConditionInput {
  conditionKey: string;
  active: boolean;
  fingerprint: unknown;
  severity: AlertBrokerSeverity;
  title: string;
  message: string;
  recoveryTitle?: string;
  recoveryMessage?: string;
  metadata?: Record<string, unknown>;
  minStreak?: number;
  cooldownSec?: number;
  mode?: string | AlertBrokerMode;
  webhookUrl?: string | null;
  nowSec?: number;
}

export interface AlertBrokerConditionResult {
  mode: AlertBrokerMode;
  conditionKey: string;
  fingerprint: string;
  state: "off" | AlertConditionState;
  streak: number;
  transition: AlertBrokerTransition | null;
  deliveryState: AlertDeliveryState | null;
}

export interface AlertBrokerSummary {
  activeCount: number;
  pendingCount: number;
  criticalActiveCount: number;
  failedDeliveryCount: number;
  missingTargetCount: number;
  oldestActiveAt: number | null;
  activeConditionKeys: string[];
  queryFailed: boolean;
}

const CONDITION_COLUMNS = `condition_key, fingerprint, state, mode, severity, generation, episode, streak,
  first_observed_at, last_observed_at, activated_at, recovered_at, cooldown_until,
  title, message, recovery_title, recovery_message, metadata_json, last_transition, updated_at`;
const DELIVERY_COLUMNS = `delivery_id, condition_key, fingerprint, episode, transition, state, mode,
  target_class, title, message, attempts, next_attempt_at, delivery_lease_until`;
const DEFAULT_RETRY_SEC = 5 * 60;
const DELIVERY_LEASE_SEC = 60;
const MAX_DELIVERY_ERROR_CHARS = 500;

export function normalizeAlertBrokerMode(value: string | undefined): AlertBrokerMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "shadow" || normalized === "status" || normalized === "alert"
    ? normalized
    : normalized === "off"
      ? "off"
      : "shadow";
}

function canonicalStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function buildAlertConditionFingerprint(conditionKey: string, value: unknown): string {
  return fnv1aHash(`${conditionKey}:${canonicalStringify(value)}`);
}

function targetClass(webhookUrl: string | null | undefined): string {
  if (!webhookUrl) return "missing-webhook";
  if (webhookUrl.includes("discord.com/api/webhooks")) return "discord-webhook";
  if (webhookUrl.includes("hooks.slack.com")) return "slack-webhook";
  return "webhook";
}

function deliveryId(conditionKey: string, episode: number, transition: AlertBrokerTransition): string {
  return `${fnv1aHash(conditionKey)}:${episode}:${transition}`;
}

async function loadCondition(db: D1Database, conditionKey: string): Promise<AlertConditionRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(`SELECT ${CONDITION_COLUMNS} FROM alert_broker_conditions WHERE condition_key = ?`)
      .bind(conditionKey)
      .first<AlertConditionRow>(),
  );
}

function persistedInitialDeliveryState(mode: PersistedAlertBrokerMode): AlertDeliveryState {
  if (mode === "shadow") return "shadow";
  if (mode === "status") return "status_only";
  return "pending";
}

async function insertTransitionDelivery(
  db: D1Database,
  input: {
    conditionKey: string;
    fingerprint: string;
    episode: number;
    transition: AlertBrokerTransition;
    mode: PersistedAlertBrokerMode;
    webhookUrl?: string | null;
    title: string;
    message: string;
    metadataJson: string | null;
    nowSec: number;
  },
): Promise<string> {
  const id = deliveryId(input.conditionKey, input.episode, input.transition);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO alert_broker_deliveries (
           delivery_id, condition_key, fingerprint, episode, transition, state, mode, target_class,
           title, message, metadata_json, attempts, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        id,
        input.conditionKey,
        input.fingerprint,
        input.episode,
        input.transition,
        persistedInitialDeliveryState(input.mode),
        input.mode,
        targetClass(input.webhookUrl),
        input.title,
        input.message,
        input.metadataJson,
        input.mode === "alert" ? input.nowSec : null,
        input.nowSec,
        input.nowSec,
      )
      .run(),
  );
  return id;
}

async function loadDelivery(db: D1Database, id: string): Promise<AlertDeliveryRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(`SELECT ${DELIVERY_COLUMNS} FROM alert_broker_deliveries WHERE delivery_id = ?`)
      .bind(id)
      .first<AlertDeliveryRow>(),
  );
}

async function claimDelivery(
  db: D1Database,
  row: AlertDeliveryRow,
  owner: string,
  nowSec: number,
): Promise<boolean> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE alert_broker_deliveries
            SET state = 'delivering', delivery_owner = ?, delivery_lease_until = ?,
                attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
          WHERE delivery_id = ?
            AND (
              (state IN ('pending', 'failed', 'missing_target') AND COALESCE(next_attempt_at, 0) <= ?)
              OR (state = 'delivering' AND COALESCE(delivery_lease_until, 0) < ?)
            )`,
      )
      .bind(owner, nowSec + DELIVERY_LEASE_SEC, nowSec, nowSec, row.delivery_id, nowSec, nowSec)
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

async function finishDelivery(
  db: D1Database,
  input: {
    deliveryId: string;
    owner: string;
    state: "delivered" | "failed" | "missing_target";
    nowSec: number;
    error?: string | null;
  },
): Promise<boolean> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE alert_broker_deliveries
            SET state = ?, next_attempt_at = ?, delivered_at = ?, last_error = ?,
                delivery_owner = NULL, delivery_lease_until = NULL, updated_at = ?
          WHERE delivery_id = ? AND state = 'delivering' AND delivery_owner = ?`,
      )
      .bind(
        input.state,
        input.state === "delivered" ? null : input.nowSec + DEFAULT_RETRY_SEC,
        input.state === "delivered" ? input.nowSec : null,
        input.error?.slice(0, MAX_DELIVERY_ERROR_CHARS) ?? null,
        input.nowSec,
        input.deliveryId,
        input.owner,
      )
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

async function attemptDeliveryRow(
  db: D1Database,
  row: AlertDeliveryRow,
  webhookUrl: string | null | undefined,
  nowSec: number,
): Promise<AlertDeliveryState> {
  if (row.mode !== "alert" || row.state === "delivered" || row.state === "shadow" || row.state === "status_only") {
    return row.state;
  }
  const owner = createLeaseOwner(`alert:${row.condition_key}`);
  if (!(await claimDelivery(db, row, owner, nowSec))) {
    return (await loadDelivery(db, row.delivery_id))?.state ?? row.state;
  }
  if (!webhookUrl) {
    await finishDelivery(db, {
      deliveryId: row.delivery_id,
      owner,
      state: "missing_target",
      nowSec,
      error: "ALERT_WEBHOOK_URL is not configured",
    });
    return "missing_target";
  }
  let delivered = false;
  let error: string | null = null;
  try {
    delivered = await sendAlert(webhookUrl, row.title, row.message);
    if (!delivered) error = "webhook transport returned false";
  } catch (cause) {
    error = toErrorMessage(cause);
  }
  const state = delivered ? "delivered" : "failed";
  await finishDelivery(db, { deliveryId: row.delivery_id, owner, state, nowSec, error });
  return state;
}

async function transitionDeliveryState(
  db: D1Database,
  id: string | null,
  webhookUrl: string | null | undefined,
  nowSec: number,
): Promise<AlertDeliveryState | null> {
  if (!id) return null;
  const row = await loadDelivery(db, id);
  return row ? attemptDeliveryRow(db, row, webhookUrl, nowSec) : null;
}

async function writeConditionObservation(
  db: D1Database,
  input: AlertBrokerConditionInput,
  mode: PersistedAlertBrokerMode,
  fingerprint: string,
  nowSec: number,
): Promise<{ row: AlertConditionRow; transition: AlertBrokerTransition | null }> {
  const minStreak = Math.max(1, Math.floor(input.minStreak ?? 1));
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  for (let retry = 0; retry < 4; retry++) {
    const existing = await loadCondition(db, input.conditionKey);
    if (!existing) {
      const streak = input.active ? 1 : 0;
      const state: AlertConditionState = input.active && streak >= minStreak ? "active" : input.active ? "pending" : "recovered";
      const transition: AlertBrokerTransition | null = state === "active" ? "incident" : null;
      const inserted = await runWithOverloadRetry(() =>
        db
          .prepare(
            `INSERT OR IGNORE INTO alert_broker_conditions (
               condition_key, fingerprint, state, mode, severity, generation, episode, streak,
               first_observed_at, last_observed_at, activated_at, recovered_at, cooldown_until,
               title, message, recovery_title, recovery_message, metadata_json, last_transition, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.conditionKey,
            fingerprint,
            state,
            mode,
            input.severity,
            state === "active" ? 1 : 0,
            streak,
            nowSec,
            nowSec,
            state === "active" ? nowSec : null,
            state === "recovered" ? nowSec : null,
            state === "active" ? nowSec + Math.max(0, input.cooldownSec ?? 0) : null,
            input.title,
            input.message,
            input.recoveryTitle ?? null,
            input.recoveryMessage ?? null,
            metadataJson,
            transition,
            nowSec,
          )
          .run(),
      );
      if ((inserted.meta.changes ?? 0) === 1) {
        const row = await loadCondition(db, input.conditionKey);
        if (!row) throw new Error(`alert condition ${input.conditionKey} disappeared after insert`);
        return { row, transition };
      }
      continue;
    }

    const sameIncident = existing.fingerprint === fingerprint && existing.state !== "recovered";
    const nextStreak = input.active ? (sameIncident ? existing.streak + 1 : 1) : 0;
    let state: AlertConditionState;
    let transition: AlertBrokerTransition | null = null;
    if (input.active) {
      state = nextStreak >= minStreak ? "active" : "pending";
      if (state === "active" && (existing.state !== "active" || existing.fingerprint !== fingerprint)) {
        transition = "incident";
      }
    } else {
      state = "recovered";
      if (existing.state === "active") transition = "recovery";
    }

    const effectiveFingerprint = input.active ? fingerprint : existing.fingerprint;
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE alert_broker_conditions
              SET fingerprint = ?, state = ?, mode = ?, severity = ?, generation = generation + 1,
                  episode = CASE WHEN ? = 'incident' THEN episode + 1 ELSE episode END,
                  streak = ?, last_observed_at = ?,
                  activated_at = CASE WHEN ? = 'incident' THEN ? ELSE activated_at END,
                  recovered_at = CASE WHEN ? = 'recovery' THEN ? WHEN ? != 'recovered' THEN NULL ELSE recovered_at END,
                  cooldown_until = CASE WHEN ? = 'incident' THEN ? ELSE cooldown_until END,
                  title = ?, message = ?, recovery_title = ?, recovery_message = ?,
                  metadata_json = ?, last_transition = COALESCE(?, last_transition), updated_at = ?
            WHERE condition_key = ? AND generation = ?`,
        )
        .bind(
          effectiveFingerprint,
          state,
          mode,
          input.severity,
          transition,
          nextStreak,
          nowSec,
          transition,
          nowSec,
          transition,
          nowSec,
          state,
          transition,
          nowSec + Math.max(0, input.cooldownSec ?? 0),
          input.title,
          input.message,
          input.recoveryTitle ?? existing.recovery_title,
          input.recoveryMessage ?? existing.recovery_message,
          metadataJson,
          transition,
          nowSec,
          input.conditionKey,
          existing.generation,
        )
        .run(),
    );
    if ((result.meta.changes ?? 0) !== 1) continue;
    const row = await loadCondition(db, input.conditionKey);
    if (!row) throw new Error(`alert condition ${input.conditionKey} disappeared after update`);
    return { row, transition };
  }
  throw new Error(`alert condition ${input.conditionKey} changed concurrently`);
}

export async function reportAlertCondition(
  db: D1Database,
  input: AlertBrokerConditionInput,
): Promise<AlertBrokerConditionResult> {
  const mode = normalizeAlertBrokerMode(input.mode);
  const fingerprint = buildAlertConditionFingerprint(input.conditionKey, input.fingerprint);
  if (mode === "off") {
    return {
      mode,
      conditionKey: input.conditionKey,
      fingerprint,
      state: "off",
      streak: 0,
      transition: null,
      deliveryState: null,
    };
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const observation = await writeConditionObservation(db, input, mode, fingerprint, nowSec);
  let id: string | null = null;
  if (observation.transition) {
    const recovery = observation.transition === "recovery";
    id = await insertTransitionDelivery(db, {
      conditionKey: input.conditionKey,
      fingerprint: observation.row.fingerprint,
      episode: observation.row.episode,
      transition: observation.transition,
      mode,
      webhookUrl: input.webhookUrl,
      title: recovery ? input.recoveryTitle ?? `${input.title} recovered` : input.title,
      message: recovery ? input.recoveryMessage ?? "The condition has recovered." : input.message,
      metadataJson: observation.row.metadata_json,
      nowSec,
    });
  }
  const deliveryState = await transitionDeliveryState(db, id, input.webhookUrl, nowSec);
  return {
    mode,
    conditionKey: input.conditionKey,
    fingerprint: observation.row.fingerprint,
    state: observation.row.state,
    streak: observation.row.streak,
    transition: observation.transition,
    deliveryState,
  };
}

export async function dispatchPendingAlertBrokerDeliveries(
  db: D1Database,
  options: { webhookUrl?: string | null; nowSec?: number; limit?: number } = {},
): Promise<{ due: number; delivered: number; failed: number; missingTarget: number }> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${DELIVERY_COLUMNS}
           FROM alert_broker_deliveries
          WHERE mode = 'alert'
            AND (
              (state IN ('pending', 'failed', 'missing_target') AND COALESCE(next_attempt_at, 0) <= ?)
              OR (state = 'delivering' AND COALESCE(delivery_lease_until, 0) < ?)
            )
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(nowSec, nowSec, limit)
      .all<AlertDeliveryRow>(),
  );
  const summary = { due: rows.results?.length ?? 0, delivered: 0, failed: 0, missingTarget: 0 };
  for (const row of rows.results ?? []) {
    const state = await attemptDeliveryRow(db, row, options.webhookUrl, nowSec);
    if (state === "delivered") summary.delivered++;
    else if (state === "missing_target") summary.missingTarget++;
    else if (state === "failed") summary.failed++;
  }
  return summary;
}

export async function loadAlertBrokerSummary(db: D1Database): Promise<AlertBrokerSummary> {
  try {
    const [conditionCounts, deliveryCounts, activeRows] = await Promise.all([
      runWithOverloadRetry(() =>
        db
          .prepare(
            `SELECT
               SUM(CASE WHEN state = 'active' AND mode IN ('status', 'alert') THEN 1 ELSE 0 END) AS active_count,
               SUM(CASE WHEN state = 'pending' AND mode IN ('status', 'alert') THEN 1 ELSE 0 END) AS pending_count,
               SUM(CASE WHEN state = 'active' AND severity = 'critical' AND mode IN ('status', 'alert') THEN 1 ELSE 0 END) AS critical_active_count,
               MIN(CASE WHEN state = 'active' AND mode IN ('status', 'alert') THEN activated_at END) AS oldest_active_at
             FROM alert_broker_conditions`,
          )
          .first<{
            active_count: number | null;
            pending_count: number | null;
            critical_active_count: number | null;
            oldest_active_at: number | null;
          }>(),
      ),
      runWithOverloadRetry(() =>
        db
          .prepare(
            `SELECT
               SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN state = 'missing_target' THEN 1 ELSE 0 END) AS missing_target_count
             FROM alert_broker_deliveries
            WHERE mode = 'alert'`,
          )
          .first<{ failed_count: number | null; missing_target_count: number | null }>(),
      ),
      runWithOverloadRetry(() =>
        db
          .prepare(
            `SELECT condition_key
               FROM alert_broker_conditions
              WHERE state = 'active' AND mode IN ('status', 'alert')
              ORDER BY severity DESC, activated_at ASC
              LIMIT 20`,
          )
          .all<{ condition_key: string }>(),
      ),
    ]);
    return {
      activeCount: conditionCounts?.active_count ?? 0,
      pendingCount: conditionCounts?.pending_count ?? 0,
      criticalActiveCount: conditionCounts?.critical_active_count ?? 0,
      failedDeliveryCount: deliveryCounts?.failed_count ?? 0,
      missingTargetCount: deliveryCounts?.missing_target_count ?? 0,
      oldestActiveAt: conditionCounts?.oldest_active_at ?? null,
      activeConditionKeys: (activeRows.results ?? []).map((row) => row.condition_key),
      queryFailed: false,
    };
  } catch (error) {
    console.warn("[alert-broker] Failed to load summary:", error);
    return {
      activeCount: 0,
      pendingCount: 0,
      criticalActiveCount: 0,
      failedDeliveryCount: 0,
      missingTargetCount: 0,
      oldestActiveAt: null,
      activeConditionKeys: [],
      queryFailed: true,
    };
  }
}

export async function pruneAlertBrokerHistory(
  db: D1Database,
  input: { normalCutoff: number; failureCutoff: number; signal?: AbortSignal },
): Promise<{ conditions: number; deliveries: number }> {
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("alert broker prune aborted");
  const results = await runWithOverloadRetry(
    () => db.batch([
      db
        .prepare(
          `DELETE FROM alert_broker_deliveries
            WHERE (state IN ('delivered', 'shadow', 'status_only') AND updated_at < ?)
               OR (state IN ('failed', 'missing_target') AND updated_at < ?)`,
        )
        .bind(input.normalCutoff, input.failureCutoff),
      db
        .prepare(
          `DELETE FROM alert_broker_conditions
            WHERE state = 'recovered'
              AND updated_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM alert_broker_deliveries d
                 WHERE d.condition_key = alert_broker_conditions.condition_key
              )`,
        )
        .bind(input.normalCutoff),
    ]),
    3,
    input.signal,
  );
  return {
    deliveries: results[0]?.meta.changes ?? 0,
    conditions: results[1]?.meta.changes ?? 0,
  };
}
