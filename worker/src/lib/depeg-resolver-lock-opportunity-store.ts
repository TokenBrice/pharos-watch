import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { executeAtomicBatch } from "./db";
import {
  DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL,
  DDR_LOCK_STATE_INSERT_COLUMNS_SQL,
  type DdrLockTrigger,
  assertLockMetadata,
  assertNonEmpty,
  assertPositiveInteger,
  bindLockMetadata,
  lockAuditInsertValuesSql,
  lockStateOnConflictUpdateSql,
  lockStateInsertValuesSql,
} from "./depeg-resolver-store-validators";
import { sha256Hex } from "./hash";

export type { DdrLockTrigger } from "./depeg-resolver-store-validators";
export type DdrLockState =
  | "pending_lock"
  | "lock_deferred"
  | "frozen"
  | "no_call"
  | "publication_retry_pending"
  | "publication_failed"
  | "published";
export type DdrLockHealthStatus = "healthy" | "degraded" | "skipped";
export type DdrLockAuditAction =
  | "pending"
  | "deferred"
  | "confirmed_seen"
  | "locked_prediction"
  | "locked_no_call"
  | "publication_retry_pending"
  | "publication_failed"
  | "published";

export interface RecordLockDeferralInput {
  incidentKey: string;
  eventId: number;
  predictionPolicyVersion: string;
  eligibleAt: number;
  runAt: number;
  createdAt?: number;
  runId?: string | null;
  reason?: string | null;
  healthStatus?: DdrLockHealthStatus;
  action?: DdrLockAuditAction;
  confirmationAt?: number | null;
  outcomeAt?: number | null;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

function assertLockInput(input: RecordLockDeferralInput): void {
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.eligibleAt, "eligibleAt");
  assertPositiveInteger(input.runAt, "runAt");
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertNonEmpty(input.predictionPolicyVersion, "predictionPolicyVersion");
  if (input.runId != null) assertNonEmpty(input.runId, "runId");
  assertLockMetadata(input);
}

async function lockOpportunityAttemptKey(
  input: RecordLockDeferralInput,
  action: DdrLockAuditAction,
): Promise<string | null> {
  if (input.runId == null) return null;
  return sha256Hex(stableJsonStringifyV1({
    incidentKey: input.incidentKey,
    runId: input.runId,
    action,
  }));
}

export async function recordLockDeferral(db: D1Database, input: RecordLockDeferralInput): Promise<void> {
  assertLockInput(input);

  const createdAt = input.createdAt ?? input.runAt;
  const reason = input.reason ?? null;
  const action = input.action ?? "deferred";
  const attemptKey = await lockOpportunityAttemptKey(input, action);
  await executeAtomicBatch(db, [
    db
      .prepare(
        `INSERT INTO depeg_resolver_prediction_lock_state
         (${DDR_LOCK_STATE_INSERT_COLUMNS_SQL})
         VALUES (${lockStateInsertValuesSql("1", "?", "'lock_deferred'")})
         ${lockStateOnConflictUpdateSql({
           incrementDeferralCount: "if-new-attempt",
           preserveDeferralReason: false,
           preserveMetadata: false,
           lastStateSql: "'lock_deferred'",
         })}`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.predictionPolicyVersion,
        input.eligibleAt,
        input.runAt,
        input.runAt,
        reason,
        createdAt,
        createdAt,
        ...bindLockMetadata(input),
        attemptKey,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO depeg_resolver_lock_opportunity_audit
         (${DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL}, attempt_key)
         VALUES (${lockAuditInsertValuesSql("NULL", "NULL", "?")}, ?)`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.runId ?? null,
        input.runAt,
        input.eligibleAt,
        input.healthStatus ?? "degraded",
        action,
        reason,
        createdAt,
        ...bindLockMetadata(input),
        attemptKey,
      ),
  ]);
}

export async function recordLockOpportunity(
  db: D1Database,
  input: RecordLockDeferralInput & { action: DdrLockAuditAction },
): Promise<void> {
  if (input.action === "deferred") {
    await recordLockDeferral(db, input);
    return;
  }

  assertLockInput(input);

  const createdAt = input.createdAt ?? input.runAt;
  const attemptKey = await lockOpportunityAttemptKey(input, input.action);
  const stateAction =
    input.action === "publication_retry_pending" ||
    input.action === "publication_failed" ||
    input.action === "published"
      ? input.action
      : null;
  const statements: D1PreparedStatement[] = [];
  if (stateAction) {
    statements.push(
      db
        .prepare(
          `INSERT INTO depeg_resolver_prediction_lock_state
           (${DDR_LOCK_STATE_INSERT_COLUMNS_SQL})
           VALUES (${lockStateInsertValuesSql("0", "?", "?")})
           ${lockStateOnConflictUpdateSql({
             incrementDeferralCount: false,
             preserveDeferralReason: true,
             preserveMetadata: true,
             lastStateSql: "excluded.last_state",
           })}`,
        )
        .bind(
          input.incidentKey,
          input.eventId,
          input.predictionPolicyVersion,
          input.eligibleAt,
          input.runAt,
          input.runAt,
          input.reason ?? null,
          stateAction,
          createdAt,
          createdAt,
          ...bindLockMetadata(input),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO depeg_resolver_lock_opportunity_audit
         (${DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL}, attempt_key)
         VALUES (${lockAuditInsertValuesSql("?", "?", "?")}, ?)`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.runId ?? null,
        input.runAt,
        input.eligibleAt,
        input.healthStatus ?? "healthy",
        input.action,
        input.confirmationAt ?? null,
        input.outcomeAt ?? null,
        input.reason ?? null,
        createdAt,
        ...bindLockMetadata(input),
        attemptKey,
      ),
  );
  await executeAtomicBatch(db, statements);
}
