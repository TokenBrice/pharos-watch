import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import { LIVE_RESERVE_QUEUE_HASH } from "../cron/sync-live-reserves-shared";
import { loadLiveReserveCheckpoint, type ScheduledRecoveryCheckpoint } from "./scheduled-recovery-checkpoint";
import { reserveRecoveryAdmissionSql, RESERVE_RECOVERY_CLAIM_SEC } from "./reserve-producer-priority";
import { runWithOverloadRetry } from "./d1-overload-retry";
import type { ScheduledExecutionFence } from "./scheduled-slot-fence";
import { assertSlotDeadline, type SlotDeadline } from "./cron-timeouts";

export interface ReserveContinuationClaim {
  fence: ScheduledExecutionFence;
  checkpoint: ScheduledRecoveryCheckpoint;
  readyToClaimMs: number;
}

/** The insert and exact frontier takeover commit together; a failed insert cannot own work. */
export async function claimReserveContinuation(
  db: D1Database,
  message: ReserveContinuationMessage,
  input: { deliveryId: string; owner: string; leaseOwner: string; workerVersion: string | null; deadline: SlotDeadline },
): Promise<ReserveContinuationClaim | null> {
  assertSlotDeadline(input.deadline);
  if (message.queueHash !== LIVE_RESERVE_QUEUE_HASH) return null;
  const checkpoint = await loadLiveReserveCheckpoint(db, message);
  assertSlotDeadline(input.deadline);
  if (!checkpoint || checkpoint.state !== "ready" || checkpoint.completedAt !== null
    || checkpoint.executionGeneration !== message.executionGeneration || checkpoint.queueHash !== message.queueHash
    || checkpoint.invocationId !== message.sourceInvocationId || checkpoint.nextItemKey !== message.nextItemKey
    || checkpoint.itemsDone !== message.itemsDone || checkpoint.currentItemKey !== null
    || checkpoint.currentDomainAttemptId !== null
    || Object.values(checkpoint.childDispositions).includes("running")) return null;
  const exhausted = checkpoint.nextItemKey === null && checkpoint.itemsDone === checkpoint.itemsTotal;
  if ((message.phase === "tail") !== exhausted) return null;
  let sealKey: string | null = null;
  let sealHash: string | null = null;
  if (exhausted) {
    // Only the exhausted event loads the accepted view graph. No adapter graph is run.
    const { loadAcceptedReserveGeneration, ACCEPTED_RESERVE_GENERATION_KEY } = await import("./accepted-reserve-generation");
    const seal = await loadAcceptedReserveGeneration(db);
    assertSlotDeadline(input.deadline);
    if (seal.root.slotStartedAt !== message.slotStartedAt || seal.root.queueHash !== message.queueHash
      || seal.members.length !== checkpoint.itemsTotal
      || seal.sealedBy.attemptNo > message.attemptNo || seal.sealedBy.executionGeneration > message.executionGeneration
      || checkpoint.childDispositions["sync-live-reserves"] !== "completed") return null;
    sealKey = ACCEPTED_RESERVE_GENERATION_KEY;
    sealHash = seal.contentSha256;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const admission = reserveRecoveryAdmissionSql();
  const exact = `schedule_key = ? AND slot_started_at = ? AND job = 'sync-live-reserves'
    AND attempt_no = ? AND execution_generation = ? AND invocation_id = ?
    AND state = 'ready' AND completed_at IS NULL AND queue_hash = ?
    AND next_item_key IS ? AND items_done = ? AND items_total = ?
    AND current_item_key IS NULL AND current_domain_attempt_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(child_dispositions_json) WHERE value = 'running')`;
  const exactBinds = [message.scheduleKey, message.slotStartedAt, message.attemptNo, message.executionGeneration,
    message.sourceInvocationId, message.queueHash, message.nextItemKey, message.itemsDone, checkpoint.itemsTotal];
  const results = await runWithOverloadRetry(() => db.batch([
    db.prepare(`INSERT INTO reserve_continuation_executions (
      delivery_id, schedule_key, slot_started_at, attempt_no, checkpoint_generation, queue_hash,
      next_item_key, items_done, phase, source_invocation_id, execution_owner, execution_generation,
      invocation_id, worker_version, state, started_at, updated_at, deadline_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'running', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM worker_scheduled_checkpoints WHERE ${exact})
        AND EXISTS (SELECT 1 FROM cron_leases WHERE job = 'reserve-recovery' AND lease_owner = ? AND lease_until >= unixepoch())
        AND (EXISTS (SELECT 1 FROM cron_slot_executions WHERE invocation_id = ? AND state = 'finished')
          OR EXISTS (SELECT 1 FROM reserve_continuation_executions WHERE invocation_id = ? AND state = 'finished'))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM cache WHERE key = ?
          AND json_valid(value) AND json_extract(value, '$.contentSha256') = ?))
        AND ${admission.sql}
      ON CONFLICT(delivery_id) DO NOTHING`).bind(
      input.deliveryId, message.scheduleKey, message.slotStartedAt, message.attemptNo, message.executionGeneration,
      message.queueHash, message.nextItemKey, message.itemsDone, message.phase, message.sourceInvocationId,
      input.owner, input.owner, input.workerVersion, timestamp, timestamp, input.deadline.platformDeadlineMs,
      ...exactBinds, input.leaseOwner, message.sourceInvocationId, message.sourceInvocationId,
      sealKey, sealKey, sealHash, ...admission.binds),
    db.prepare(`UPDATE worker_scheduled_checkpoints
      SET state = 'recovering', invocation_id = ?, recovery_owner = ?, recovery_lease_until = ?, updated_at = ?
      WHERE ${exact} AND EXISTS (SELECT 1 FROM reserve_continuation_executions
        WHERE delivery_id = ? AND execution_owner = ? AND state = 'running')`).bind(
      input.owner, input.owner, timestamp + RESERVE_RECOVERY_CLAIM_SEC, timestamp,
      ...exactBinds, input.deliveryId, input.owner),
  ]));
  assertSlotDeadline(input.deadline);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) return null;
  return {
    fence: { kind: "reserve-continuation", deliveryId: input.deliveryId, scheduleKey: message.scheduleKey,
      slotStartedAt: message.slotStartedAt, invocationId: input.owner, owner: input.owner, generation: 1, workerRole: "public" },
    checkpoint: { ...checkpoint, state: "recovering", invocationId: input.owner, recoveryOwner: input.owner,
      recoveryLeaseUntil: timestamp + RESERVE_RECOVERY_CLAIM_SEC, updatedAt: timestamp },
    readyToClaimMs: Math.max(0, Date.now() - checkpoint.updatedAt * 1000),
  };
}

export async function heartbeatReserveContinuation(db: D1Database, fence: ScheduledExecutionFence): Promise<boolean> {
  const result = await runWithOverloadRetry(() => db.prepare(`UPDATE reserve_continuation_executions
    SET updated_at = MAX(updated_at, ?) WHERE delivery_id = ? AND execution_owner = ?
      AND execution_generation = ? AND state = 'running' AND deadline_ms > ?`).bind(
    Math.floor(Date.now() / 1000), fence.deliveryId, fence.owner, fence.generation, Date.now()).run());
  return result.meta.changes === 1;
}

export async function finishReserveContinuation(
  db: D1Database, fence: ScheduledExecutionFence, status: "ok" | "degraded" | "error", metadata: unknown,
): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await runWithOverloadRetry(() => db.prepare(`UPDATE reserve_continuation_executions
    SET state = 'finished', result_status = ?, finished_at = ?, updated_at = ?, metadata = ?
    WHERE delivery_id = ? AND execution_owner = ? AND execution_generation = ? AND state = 'running'
      AND NOT EXISTS (SELECT 1 FROM reserve_continuation_child_attempts
        WHERE delivery_id = ? AND execution_generation = ? AND terminal_token IS NULL)`).bind(
    status, timestamp, timestamp, JSON.stringify(metadata), fence.deliveryId, fence.owner, fence.generation,
    fence.deliveryId, fence.generation).run());
  return result.meta.changes === 1;
}
