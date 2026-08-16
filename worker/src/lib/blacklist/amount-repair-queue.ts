const MAX_RETRY_DELAY_SEC = 6 * 60 * 60;
const BASE_RETRY_DELAY_SEC = 5 * 60;

export type BlacklistAmountRepairQueueOutcome = "resolved" | "retry" | "unrecoverable";

export async function refreshBlacklistAmountRepairQueue(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `/* blacklist-amount-repair-queue-enqueue */
       INSERT OR IGNORE INTO blacklist_amount_repair_queue
         (event_id, status, priority, reason, available_at, created_at, updated_at)
       SELECT
         id,
         'pending',
         CASE
           WHEN event_type = 'destroy' THEN 10
           WHEN amount_status = 'recoverable_pending' THEN 20
           WHEN amount_status = 'ambiguous' THEN 30
           ELSE 40
         END,
         CASE
           WHEN amount_source = 'derived' AND amount_native = 0 THEN 'legacy-derived-zero'
           ELSE 'missing-event-amount'
         END,
         0,
         ?,
         ?
       FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND chain_id != 'tron'
         AND (
           amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
           OR (amount_source = 'derived' AND amount_native = 0 AND amount_status = 'resolved')
         )`,
    )
    .bind(now, now)
    .run();

  await db
    .prepare(
      `/* blacklist-amount-repair-queue-reconcile-resolved */
       UPDATE blacklist_amount_repair_queue
       SET status = 'resolved',
           claim_token = NULL,
           lease_expires_at = NULL,
           last_error_class = NULL,
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status != 'resolved'
         AND EXISTS (
           SELECT 1
           FROM blacklist_events
           WHERE blacklist_events.id = blacklist_amount_repair_queue.event_id
             AND blacklist_events.amount_status = 'resolved'
             AND NOT (
               blacklist_events.amount_source = 'derived'
               AND blacklist_events.amount_native = 0
             )
         )`,
    )
    .bind(now, now)
    .run();

  await db
    .prepare(
      `/* blacklist-amount-repair-queue-release-expired */
       UPDATE blacklist_amount_repair_queue
       SET status = 'retry',
           claim_token = NULL,
           lease_expires_at = NULL,
           available_at = MIN(?, updated_at + ?),
           last_error_class = COALESCE(last_error_class, 'lease_expired'),
           updated_at = ?
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?`,
    )
    .bind(now + BASE_RETRY_DELAY_SEC, BASE_RETRY_DELAY_SEC, now, now)
    .run();
}

export function buildBlacklistAmountRepairQueueUpdate(
  db: D1Database,
  args: {
    eventId: string;
    outcome: BlacklistAmountRepairQueueOutcome;
    attemptedAt: number;
    priorAttempts: number;
    errorClass: string | null;
  },
): D1PreparedStatement {
  const retryDelay = Math.min(
    MAX_RETRY_DELAY_SEC,
    BASE_RETRY_DELAY_SEC * 2 ** Math.min(6, Math.max(0, args.priorAttempts)),
  );
  const terminal = args.outcome !== "retry";
  return db
    .prepare(
      `/* blacklist-amount-repair-queue-finish */
       UPDATE blacklist_amount_repair_queue
       SET status = ?,
           attempt_count = attempt_count + 1,
           available_at = ?,
           claim_token = NULL,
           lease_expires_at = NULL,
           last_error_class = ?,
           updated_at = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
       WHERE event_id = ?`,
    )
    .bind(
      args.outcome,
      args.outcome === "retry" ? args.attemptedAt + retryDelay : args.attemptedAt,
      args.errorClass,
      args.attemptedAt,
      terminal ? 1 : 0,
      args.attemptedAt,
      args.eventId,
    );
}
