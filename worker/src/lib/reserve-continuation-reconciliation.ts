import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { writeScheduledChildTerminal } from "./scheduled-child-terminal";
import type { ScheduledChildAttemptRow } from "./scheduled-child-terminal";
import { SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS } from "./cron-timeouts";

interface ContinuationExecutionRow {
  delivery_id: string;
  schedule_key: string;
  slot_started_at: number;
  invocation_id: string;
  execution_owner: string;
  execution_generation: number;
  updated_at: number;
  state: "running" | "reconciling";
}

/** Independent cron fallback closes only dead Queue events; never renews cron delivery health. */
export async function reconcileReserveContinuations(db: D1Database, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const now = Math.floor(Date.now() / 1000);
  const rows = await runWithOverloadRetry(() => db.prepare(`SELECT delivery_id, schedule_key, slot_started_at,
    invocation_id, execution_owner, execution_generation, updated_at, state FROM reserve_continuation_executions
    WHERE state IN ('running', 'reconciling') AND updated_at < ?
      AND deadline_ms + ? < ? ORDER BY updated_at LIMIT 1`).bind(
    now - 120, SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS, now * 1000).all<ContinuationExecutionRow>());
  let reconciled = 0;
  for (const row of rows.results) {
    signal.throwIfAborted();
    const owner = createLeaseOwner("reserve-queue-reconciler");
    const generation = row.execution_generation + 1;
    const claim = await runWithOverloadRetry(() => db.prepare(`UPDATE reserve_continuation_executions
      SET state = 'reconciling', execution_owner = ?, execution_generation = ?, updated_at = ?
      WHERE delivery_id = ? AND execution_owner = ? AND execution_generation = ? AND state = ? AND updated_at = ?
        AND NOT EXISTS (SELECT 1 FROM reserve_continuation_child_attempts child
          JOIN cron_leases lease ON lease.job = child.job AND lease.lease_owner = child.lease_owner
          WHERE child.delivery_id = ? AND lease.lease_until >= ?)
        AND NOT EXISTS (SELECT 1 FROM cron_leases WHERE job = 'reserve-recovery' AND lease_until >= ?
          AND json_valid(lease_owner) AND json_extract(lease_owner, '$.invocationId') = ?)`)
      .bind(owner, generation, now, row.delivery_id, row.execution_owner, row.execution_generation, row.state,
        row.updated_at, row.delivery_id, now, now, row.invocation_id).run());
    if (claim.meta.changes !== 1) continue;
    signal.throwIfAborted();
    const children = await db.prepare(`SELECT * FROM reserve_continuation_child_attempts
      WHERE delivery_id = ? AND terminal_token IS NULL`).bind(row.delivery_id).all<ScheduledChildAttemptRow>();
    for (const child of children.results) {
      signal.throwIfAborted();
      await writeScheduledChildTerminal(db, {
        identity: { scheduleKey: child.schedule_key, slotStartedAt: child.slot_started_at, job: child.job,
          producerPath: child.producer_path, producerKind: child.producer_kind, invocationId: child.invocation_id,
          workerVersion: child.worker_version, attemptNo: child.attempt_no,
          executionFence: { kind: "reserve-continuation", deliveryId: row.delivery_id,
            scheduleKey: child.execution_schedule_key, slotStartedAt: child.execution_slot_started_at,
            invocationId: child.execution_invocation_id, owner: child.execution_owner,
            generation: child.execution_generation, workerRole: "public" } },
        source: "synthetic", reconciler: { owner, generation, state: "reconciling" },
        startedAt: child.started_at ?? now, completedAt: now, durationMs: Math.max(0, now - (child.started_at ?? now)) * 1000,
        status: "error", degradedReason: "reserve-queue-platform-abandoned", disposition: "abandoned",
        producerOutcome: "abandoned", error: "Reserve Queue event ended without terminal accounting",
        metadata: JSON.stringify({ reason: "reserve-queue-platform-abandoned", deliveryId: row.delivery_id,
          sourceInvocationId: row.invocation_id, reconciledAt: now }),
      });
      // Exact dead-owner cleanup only; a late/new lease or progress row survives.
      await db.batch([
        db.prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ? AND lease_until < ?")
          .bind(child.job, child.lease_owner, now),
        db.prepare(`DELETE FROM cron_run_progress WHERE job = ? AND lease_owner = ?
          AND NOT EXISTS (SELECT 1 FROM cron_leases WHERE job = ? AND lease_owner = ? AND lease_until >= ?)`)
          .bind(child.job, child.lease_owner, child.job, child.lease_owner, now),
      ]);
    }
    const result = await db.prepare(`UPDATE reserve_continuation_executions
      SET state = 'finished', result_status = 'error', finished_at = ?, updated_at = ?, metadata = ?
      WHERE delivery_id = ? AND state = 'reconciling' AND execution_owner = ? AND execution_generation = ?
        AND NOT EXISTS (SELECT 1 FROM reserve_continuation_child_attempts WHERE delivery_id = ? AND terminal_token IS NULL)`)
      .bind(now, now, JSON.stringify({ reason: "reserve-queue-platform-abandoned", reconciledAt: now }),
        row.delivery_id, owner, generation, row.delivery_id).run();
    reconciled += result.meta.changes ?? 0;
  }
  return reconciled;
}
