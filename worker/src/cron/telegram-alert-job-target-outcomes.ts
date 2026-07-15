import { batchExecute, executeAtomicBatch } from "../lib/db";

export type TelegramTargetFinalDeliveryState =
  | "accepted"
  | "failed"
  | "cancelled"
  | "expired"
  | "execution_unknown";

export type TelegramTargetCounterBucket =
  | "planned"
  | "accepted"
  | "enqueued"
  | "failed"
  | "cancelled"
  | "expired"
  | "execution_unknown";

export interface TelegramJobTargetPendingIdentity {
  pendingDedupeKey: string;
  sourceEventId: string;
}

export interface TelegramJobTargetIdentity {
  jobId: string;
  targetKey: string;
  pendingDedupeKey: string;
  sourceEventId: string;
}

export interface TelegramTargetFinalDeliveryOutcome {
  state: TelegramTargetFinalDeliveryState;
  at: number;
  error?: string | null;
}

export interface TelegramTargetProjectionGuard {
  sql: string;
  binds: readonly unknown[];
}

interface TargetIdentityRow {
  job_id: string;
  target_key: string;
  pending_dedupe_key: string;
  source_event_id: string | null;
}

interface PendingTerminalProjectionRow extends TargetIdentityRow {
  pending_id: number;
  delivery_state: "sent" | "execution_unknown";
  delivery_owner: string | null;
  delivery_generation: number;
  delivery_completed_at: number | null;
  last_error_class: string | null;
}

interface TargetCounterInput {
  status: string;
  effectState?: string | null;
  cancelledAt?: number | null;
  finalDeliveryState?: string | null;
}

export function classifyTelegramTargetCounterBucket(
  target: TargetCounterInput,
): TelegramTargetCounterBucket {
  switch (target.finalDeliveryState) {
    case "accepted":
    case "failed":
    case "cancelled":
    case "expired":
    case "execution_unknown":
      return target.finalDeliveryState;
    default:
      break;
  }
  if (target.cancelledAt != null) return "cancelled";
  if (target.effectState === "execution_unknown") return "execution_unknown";
  if (target.status === "sent") return "accepted";
  if (target.status === "failed") return "failed";
  if (target.status === "expired") return "expired";
  if (
    target.status === "queued" ||
    target.effectState === "sending" ||
    target.effectState === "complete"
  ) {
    return "enqueued";
  }
  return "planned";
}

/**
 * Resolve the one authoritative target owned by a pending row. Source identity
 * is mandatory so an old/reappeared dedupe key cannot update unrelated work.
 */
export async function resolveTelegramJobTargetIdentityForPending(
  db: D1Database,
  identity: TelegramJobTargetPendingIdentity,
): Promise<TelegramJobTargetIdentity | null> {
  const rows = await db
    .prepare(
      `SELECT job_id, target_key, pending_dedupe_key, source_event_id
         FROM telegram_alert_job_targets
        WHERE pending_dedupe_key = ?
          AND source_event_id = ?
        ORDER BY job_id, target_key
        LIMIT 2`,
    )
    .bind(identity.pendingDedupeKey, identity.sourceEventId)
    .all<TargetIdentityRow>();
  const matches = rows.results ?? [];
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("Telegram pending identity matches multiple authoritative targets");
  }
  const row = matches[0];
  if (
    row.pending_dedupe_key !== identity.pendingDedupeKey ||
    row.source_event_id !== identity.sourceEventId
  ) {
    throw new Error("Telegram pending target identity changed during resolution");
  }
  return {
    jobId: row.job_id,
    targetKey: row.target_key,
    pendingDedupeKey: row.pending_dedupe_key,
    sourceEventId: row.source_event_id,
  };
}

export function prepareTelegramJobTargetFinalDeliveryProjection(
  db: D1Database,
  identity: TelegramJobTargetIdentity,
  outcome: TelegramTargetFinalDeliveryOutcome,
  options: { pendingGuard?: TelegramTargetProjectionGuard } = {},
): D1PreparedStatement {
  if (!Number.isSafeInteger(outcome.at) || outcome.at < 0) {
    throw new Error("Telegram target final delivery timestamp is invalid");
  }
  if (outcome.error != null && outcome.error.length > 80) {
    throw new Error("Telegram target final delivery error is too long");
  }
  const status = outcome.state === "accepted"
    ? "sent"
    : outcome.state === "failed"
      ? "failed"
      : outcome.state === "expired"
        ? "expired"
        : null;
  const sentAt = outcome.state === "accepted" ? outcome.at : null;
  const failedAt = outcome.state === "failed" ? outcome.at : null;
  const cancelledAt = outcome.state === "cancelled" ? outcome.at : null;
  const pendingGuardSql = options.pendingGuard ? ` AND (${options.pendingGuard.sql})` : "";
  const pendingGuardBinds = options.pendingGuard?.binds ?? [];
  return db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET final_delivery_state = ?,
              final_delivery_at = COALESCE(final_delivery_at, ?),
              final_delivery_error = COALESCE(?, final_delivery_error),
              status = COALESCE(?, status),
              sent_at = COALESCE(sent_at, ?),
              failed_at = COALESCE(failed_at, ?),
              cancelled_at = COALESCE(cancelled_at, ?),
              cancellation_reason = CASE
                WHEN ? = 'cancelled' THEN COALESCE(cancellation_reason, ?, 'pending_cancelled')
                ELSE cancellation_reason
              END,
              error_class = COALESCE(?, error_class)
        WHERE job_id = ?
          AND target_key = ?
          AND pending_dedupe_key = ?
          AND source_event_id = ?
          AND (final_delivery_state IS NULL OR final_delivery_state = ?)
          ${pendingGuardSql}`,
    )
    .bind(
      outcome.state,
      outcome.at,
      outcome.error ?? null,
      status,
      sentAt,
      failedAt,
      cancelledAt,
      outcome.state,
      outcome.error ?? null,
      outcome.error ?? (outcome.state === "execution_unknown" ? "execution_unknown" : null),
      identity.jobId,
      identity.targetKey,
      identity.pendingDedupeKey,
      identity.sourceEventId,
      outcome.state,
      ...pendingGuardBinds,
    );
}

export async function recordTelegramJobTargetFinalDelivery(
  db: D1Database,
  pendingIdentity: TelegramJobTargetPendingIdentity,
  outcome: TelegramTargetFinalDeliveryOutcome,
): Promise<boolean> {
  const identity = await resolveTelegramJobTargetIdentityForPending(db, pendingIdentity);
  if (!identity) return false;
  const statements = [
    prepareTelegramJobTargetFinalDeliveryProjection(db, identity, outcome),
    prepareTelegramAlertJobCounterReconciliation(db, identity.jobId, outcome.at, {
      targetKey: identity.targetKey,
      finalDeliveryState: outcome.state,
    }),
  ];
  const changed = await executeAtomicBatch(db, statements);
  if (changed !== statements.length) {
    throw new Error("Telegram target final delivery projection was not confirmed");
  }
  return true;
}

/**
 * Repair a crash or rolling-deploy gap where the pending lifecycle reached a
 * terminal state but its authoritative target projection is still absent.
 * The pending row remains the evidence and is rechecked by id/owner/generation
 * in each update, so this pass never infers a result from a missing row.
 */
export async function reconcileTelegramJobTargetFinalDeliveryFromPending(
  db: D1Database,
  nowSec: number,
  limit = 90,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(90, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT target.job_id, target.target_key, target.pending_dedupe_key,
              target.source_event_id, pending.id AS pending_id,
              pending.delivery_state, pending.delivery_owner,
              pending.delivery_generation, pending.delivery_completed_at,
              pending.last_error_class
         FROM telegram_pending_alerts pending
         JOIN telegram_alert_job_targets target
           ON target.pending_dedupe_key = pending.dedupe_key
          AND target.source_event_id = pending.source_event_id
        WHERE pending.source_event_id IS NOT NULL
          AND pending.dedupe_key IS NOT NULL
          AND pending.delivery_state IN ('sent', 'execution_unknown')
          AND target.plan_generation IS NOT NULL
          AND target.final_delivery_state IS NULL
        ORDER BY pending.id, target.job_id, target.target_key
        LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<PendingTerminalProjectionRow>();
  const candidates = rows.results ?? [];
  let projected = 0;
  for (const row of candidates) {
    if (!row.source_event_id) continue;
    const state = row.delivery_state === "sent" ? "accepted" : "execution_unknown";
    const completedAt = row.delivery_completed_at ?? nowSec;
    const statements = [
      prepareTelegramJobTargetFinalDeliveryProjection(
        db,
        {
          jobId: row.job_id,
          targetKey: row.target_key,
          pendingDedupeKey: row.pending_dedupe_key,
          sourceEventId: row.source_event_id,
        },
        {
          state,
          at: completedAt,
          error: row.last_error_class,
        },
        {
          pendingGuard: {
            sql: `EXISTS (
              SELECT 1
                FROM telegram_pending_alerts pending
               WHERE pending.id = ?
                 AND pending.dedupe_key = ?
                 AND pending.source_event_id = ?
                 AND pending.delivery_state = ?
                 AND pending.delivery_owner IS ?
                 AND pending.delivery_generation = ?
            )`,
            binds: [
              row.pending_id,
              row.pending_dedupe_key,
              row.source_event_id,
              row.delivery_state,
              row.delivery_owner,
              row.delivery_generation,
            ],
          },
        },
      ),
      prepareTelegramAlertJobCounterReconciliation(db, row.job_id, completedAt, {
        targetKey: row.target_key,
        finalDeliveryState: state,
      }),
    ];
    const changed = await executeAtomicBatch(db, statements);
    if (changed !== statements.length) {
      throw new Error("Telegram pending target repair was not confirmed");
    }
    projected += 1;
  }
  return projected;
}

const TARGET_BUCKET_SQL = `CASE
  WHEN target.final_delivery_state IS NOT NULL THEN target.final_delivery_state
  WHEN target.cancelled_at IS NOT NULL THEN 'cancelled'
  WHEN target.effect_state = 'execution_unknown' THEN 'execution_unknown'
  WHEN target.status = 'sent' THEN 'accepted'
  WHEN target.status = 'failed' THEN 'failed'
  WHEN target.status = 'expired' THEN 'expired'
  WHEN target.status = 'queued' OR target.effect_state IN ('sending', 'complete') THEN 'enqueued'
  ELSE 'planned'
END`;

export function prepareTelegramAlertJobCounterReconciliation(
  db: D1Database,
  jobId: string,
  nowSec: number,
  projectionGuard?: {
    targetKey: string;
    finalDeliveryState: TelegramTargetFinalDeliveryState;
  },
): D1PreparedStatement {
  const projectionGuardSql = projectionGuard
    ? ` AND EXISTS (
          SELECT 1
            FROM telegram_alert_job_targets projected_target
           WHERE projected_target.job_id = telegram_alert_jobs.job_id
             AND projected_target.target_key = ?
             AND projected_target.final_delivery_state = ?
        )`
    : "";
  const projectionGuardBinds = projectionGuard
    ? [projectionGuard.targetKey, projectionGuard.finalDeliveryState]
    : [];
  return db
    .prepare(
      `WITH target_buckets AS (
         SELECT ${TARGET_BUCKET_SQL} AS bucket
           FROM telegram_alert_job_targets target
          WHERE target.job_id = ?
       ), counts AS (
         SELECT COUNT(*) AS target_count,
                SUM(CASE WHEN bucket = 'planned' THEN 1 ELSE 0 END) AS planned_count,
                SUM(CASE WHEN bucket = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
                SUM(CASE WHEN bucket = 'enqueued' THEN 1 ELSE 0 END) AS enqueued_count,
                SUM(CASE WHEN bucket = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN bucket = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
                SUM(CASE WHEN bucket = 'expired' THEN 1 ELSE 0 END) AS expired_count,
                SUM(CASE WHEN bucket = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count
           FROM target_buckets
       )
       UPDATE telegram_alert_jobs
          SET target_count = COALESCE((SELECT target_count FROM counts), 0),
              planned_count = COALESCE((SELECT planned_count FROM counts), 0),
              accepted_count = COALESCE((SELECT accepted_count FROM counts), 0),
              sent_count = COALESCE((SELECT accepted_count FROM counts), 0),
              enqueued_count = COALESCE((SELECT enqueued_count FROM counts), 0),
              failed_count = COALESCE((SELECT failed_count FROM counts), 0),
              cancelled_count = COALESCE((SELECT cancelled_count FROM counts), 0),
              expired_count = COALESCE((SELECT expired_count FROM counts), 0),
              execution_unknown_count = COALESCE((SELECT execution_unknown_count FROM counts), 0),
              status = CASE
                WHEN COALESCE((SELECT target_count FROM counts), 0) = 0 THEN 'discovered'
                WHEN COALESCE((SELECT failed_count + expired_count + execution_unknown_count FROM counts), 0) > 0
                  THEN 'degraded'
                WHEN COALESCE((SELECT planned_count FROM counts), 0) > 0 THEN 'discovered'
                WHEN COALESCE((SELECT enqueued_count FROM counts), 0) > 0 THEN 'queued'
                ELSE 'sent'
              END,
              metadata = CASE
                WHEN json_valid(metadata) THEN json_set(
                  metadata,
                  '$.countersSource', 'authoritative-target-rows',
                  '$.reconciledAt', ?
                )
                ELSE json_object(
                  'countersSource', 'authoritative-target-rows',
                  'reconciledAt', ?
                )
              END
        WHERE job_id = ?
          ${projectionGuardSql}`,
    )
    .bind(jobId, nowSec, nowSec, jobId, ...projectionGuardBinds);
}

export async function reconcileTelegramAlertJobCounters(
  db: D1Database,
  jobIds: readonly string[],
  nowSec: number,
): Promise<void> {
  const uniqueJobIds = [...new Set(jobIds)];
  if (uniqueJobIds.length === 0) return;
  await batchExecute(
    db,
    uniqueJobIds.map((jobId) => prepareTelegramAlertJobCounterReconciliation(db, jobId, nowSec)),
  );
}
