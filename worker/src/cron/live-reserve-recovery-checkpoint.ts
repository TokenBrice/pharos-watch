import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import type { ScheduledRecoveryDomainPolicy } from "../lib/scheduled-recovery-checkpoint";

type ScheduledCheckpoint = Parameters<NonNullable<ScheduledRecoveryDomainPolicy["reconcileAbandonedAttempt"]>>[1];

function buildReserveAbandonmentStatements(
  db: D1Database,
  checkpoint: ScheduledCheckpoint,
  input: {
    timestamp: number;
    error: string;
    metadata: string;
    extraPredicate?: string;
    extraBinds?: readonly unknown[];
  },
): D1PreparedStatement[] {
  const predicate = input.extraPredicate ? `\n              AND ${input.extraPredicate}` : "";
  const sharedBinds = [
    checkpoint.currentItemKey,
    checkpoint.currentDomainAttemptId,
    checkpoint.currentDomainAttemptId,
    ...(input.extraBinds ?? []),
  ];
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO reserve_sync_attempt_history (
           stablecoin_id, attempted_at, adapter_key, breaker_key, attempt_id,
           status, warnings, warning_count, last_error, metadata
         )
         SELECT stablecoin_id, COALESCE(last_attempted_at, ?), adapter_key, breaker_key,
                pending_attempt_id, 'error', NULL, 0, ?, ?
           FROM reserve_sync_state
          WHERE stablecoin_id = ?
            AND pending_attempt_id = ?
            AND last_attempt_id = ?${predicate}`,
      )
      .bind(input.timestamp, input.error, input.metadata, ...sharedBinds),
    db
      .prepare(
        `UPDATE reserve_sync_state
            SET pending_attempt_id = NULL,
                last_status = 'error',
                last_error = ?,
                metadata = ?
          WHERE stablecoin_id = ?
            AND pending_attempt_id = ?
            AND last_attempt_id = ?${predicate}`,
      )
      .bind(input.error, input.metadata, ...sharedBinds),
  ];
}

export const LIVE_RESERVE_RECOVERY_DOMAIN_POLICY: ScheduledRecoveryDomainPolicy = {
  async reconcileAbandonedAttempt(db, checkpoint, context) {
    if (!checkpoint.currentItemKey || !checkpoint.currentDomainAttemptId) return;
    const metadata = JSON.stringify({
      reason: context.reason,
      failureCategory: "platform-abandoned",
      reconciledAt: context.timestamp,
    });
    await runWithOverloadRetry(() => db.batch(buildReserveAbandonmentStatements(db, checkpoint, {
      timestamp: context.timestamp,
      error: context.error,
      metadata,
    })));
  },

  buildIncompatibleRetirementStatements(db, checkpoint, context) {
    if (!checkpoint.currentItemKey || !checkpoint.currentDomainAttemptId) return [];
    const metadata = JSON.stringify({
      reason: "queue-hash-drift",
      failureCategory: "platform-abandoned",
      expectedQueueHash: context.expectedQueueHash,
      checkpointQueueHash: checkpoint.queueHash,
      reconciledAt: context.timestamp,
    });
    return buildReserveAbandonmentStatements(db, checkpoint, {
      timestamp: context.timestamp,
      error: context.error,
      metadata,
      extraPredicate: context.checkpointRetiredExistsSql,
      extraBinds: context.checkpointRetiredExistsBinds,
    });
  },
};
