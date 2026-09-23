const MAX_RETRY_DELAY_SEC = 6 * 60 * 60;
const BASE_RETRY_DELAY_SEC = 5 * 60;
// Deterministic failures (a ledger beyond the page cap, shared-millisecond
// evidence, missing config) cannot be fixed by retrying, so they are parked far
// enough out that they stop consuming the run's page budget while staying
// visible as unresolved gaps for the operator repair path.
const PARKED_RETRY_DELAY_SEC = 7 * 24 * 60 * 60;

export type BlacklistAmountRepairQueueOutcome = "resolved" | "retry" | "park" | "unrecoverable";

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
  const terminal = args.outcome === "resolved" || args.outcome === "unrecoverable";
  const delaySec = args.outcome === "park" ? PARKED_RETRY_DELAY_SEC : retryDelay;
  // "park" stays a retry row so the due-time filter, not the status value, decides
  // when the row is eligible again.
  const status = args.outcome === "park" ? "retry" : args.outcome;
  return db
    .prepare(
      `/* blacklist-amount-repair-queue-finish */
       UPDATE blacklist_amount_repair_queue
       SET status = ?,
           attempt_count = attempt_count + 1,
           available_at = ?,
           last_error_class = ?,
           updated_at = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
       WHERE event_id = ?`,
    )
    .bind(
      status,
      terminal ? args.attemptedAt : args.attemptedAt + delaySec,
      args.errorClass,
      args.attemptedAt,
      terminal ? 1 : 0,
      args.attemptedAt,
      args.eventId,
    );
}
