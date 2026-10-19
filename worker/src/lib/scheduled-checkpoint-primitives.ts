import { unixNowSec as nowSec } from "@shared/lib/time-constants";

// Keep storage primitives independent of scheduler registries and recovery runners:
// reserve stores are also reachable from the offline Safety Score evaluator.
export interface ScheduledCheckpointIdentity {
  scheduleKey: string;
  slotStartedAt: number;
  job: string;
  attemptNo: number;
  executionGeneration: number;
  invocationId: string;
}

export class ScheduledCheckpointOwnershipLostError extends Error {
  constructor(identity: ScheduledCheckpointIdentity) {
    super(
      `scheduled checkpoint ownership lost for ${identity.scheduleKey}@${identity.slotStartedAt}/${identity.job}#${identity.attemptNo}`,
    );
    this.name = "ScheduledCheckpointOwnershipLostError";
  }
}

export function identityBinds(identity: ScheduledCheckpointIdentity): Array<string | number> {
  return [
    identity.scheduleKey,
    identity.slotStartedAt,
    identity.job,
    identity.attemptNo,
    identity.executionGeneration,
    identity.invocationId,
  ];
}

export function identityWhereSql(): string {
  return `schedule_key = ?
      AND slot_started_at = ?
      AND job = ?
      AND attempt_no = ?
      AND execution_generation = ?
      AND invocation_id = ?`;
}

// Starting the next item also acknowledges the prior item. Persist its domain
// attempt in the same write so recovery can fence any crash before domain work.
export function buildLiveReserveCheckpointItemStartedStatement(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: {
    itemKey: string;
    domainAttemptId?: string | null;
    itemsDone: number;
    itemsTotal: number;
    nowSec?: number;
    recoveryLeaseUntil?: number | null;
    deadlineMs?: number;
  },
): D1PreparedStatement {
  const timestamp = input.nowSec ?? nowSec();
  return db
    .prepare(
      `UPDATE worker_scheduled_checkpoints
          SET next_item_key = ?, current_item_key = ?, current_domain_attempt_id = ?,
              items_done = ?, items_total = ?, updated_at = ?,
              recovery_lease_until = COALESCE(?, recovery_lease_until)
        WHERE ${identityWhereSql()}
          AND state IN ('running', 'recovering')
          AND (? IS NULL OR CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < ?)`,
    )
    .bind(
      input.itemKey,
      input.itemKey,
      input.domainAttemptId ?? null,
      input.itemsDone,
      input.itemsTotal,
      timestamp,
      input.recoveryLeaseUntil ?? null,
      ...identityBinds(identity),
      input.deadlineMs ?? null,
      input.deadlineMs ?? null,
    );
}
