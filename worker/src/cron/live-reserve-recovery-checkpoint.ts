import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import type { ScheduledRecoveryDomainPolicy } from "../lib/scheduled-recovery-checkpoint";

export const LIVE_RESERVE_RECOVERY_DOMAIN_POLICY: ScheduledRecoveryDomainPolicy = {
  async reconcileAbandonedAttempt(db, checkpoint, context) {
    if (!checkpoint.currentItemKey || !checkpoint.currentDomainAttemptId) return;
    const metadata = JSON.stringify({
      reason: context.reason,
      failureCategory: "platform-abandoned",
      reconciledAt: context.timestamp,
    });
    await runWithOverloadRetry(() =>
      db.batch([
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
                AND last_attempt_id = ?`,
          )
          .bind(
            context.timestamp,
            context.error,
            metadata,
            checkpoint.currentItemKey,
            checkpoint.currentDomainAttemptId,
            checkpoint.currentDomainAttemptId,
          ),
        db
          .prepare(
            `UPDATE reserve_sync_state
                SET pending_attempt_id = NULL,
                    last_status = 'error',
                    last_error = ?,
                    metadata = ?
              WHERE stablecoin_id = ?
                AND pending_attempt_id = ?
                AND last_attempt_id = ?`,
          )
          .bind(
            context.error,
            metadata,
            checkpoint.currentItemKey,
            checkpoint.currentDomainAttemptId,
            checkpoint.currentDomainAttemptId,
          ),
      ]),
    );
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
              AND last_attempt_id = ?
              AND ${context.checkpointRetiredExistsSql}`,
        )
        .bind(
          context.timestamp,
          context.error,
          metadata,
          checkpoint.currentItemKey,
          checkpoint.currentDomainAttemptId,
          checkpoint.currentDomainAttemptId,
          ...context.checkpointRetiredExistsBinds,
        ),
      db
        .prepare(
          `UPDATE reserve_sync_state
              SET pending_attempt_id = NULL,
                  last_status = 'error',
                  last_error = ?,
                  metadata = ?
            WHERE stablecoin_id = ?
              AND pending_attempt_id = ?
              AND last_attempt_id = ?
              AND ${context.checkpointRetiredExistsSql}`,
        )
        .bind(
          context.error,
          metadata,
          checkpoint.currentItemKey,
          checkpoint.currentDomainAttemptId,
          checkpoint.currentDomainAttemptId,
          ...context.checkpointRetiredExistsBinds,
        ),
    ];
  },
};
