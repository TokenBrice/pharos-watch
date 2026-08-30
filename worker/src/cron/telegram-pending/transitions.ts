import { executeAtomicBatch } from "../../lib/db";
import {
  prepareTelegramAlertJobCounterReconciliation,
  prepareTelegramJobTargetFinalDeliveryProjection,
  resolveTelegramJobTargetIdentityForPending,
} from "../telegram-alert-job-target-outcomes";
import { projectRecapPendingTerminalOutcome } from "./recap-terminal";
import type { PendingAlertRow, PendingDeliveryClaim } from "./types";

interface PendingSendingTargetGuard { sql: string; binds: readonly unknown[] }

export type PendingSendingTransition =
  | { to: "sent"; completedAt: number }
  | { to: "execution_unknown"; completedAt: number; errorClass: string | null }
  | { to: "pending"; notBeforeAt: number | null; errorClass: string | null; retryAfterSec?: number | null };

export type PendingTerminalOutcome = { claim: PendingDeliveryClaim; row: PendingAlertRow; errorClass?: string | null };

interface PendingSendingTransitionOptions { updatedAtSec?: number; targetGuard?: PendingSendingTargetGuard }

const SENT_SQL = `UPDATE telegram_pending_alerts SET delivery_state = 'sent', delivery_completed_at = ?, delivery_claim_expires_at = NULL, updated_at = ? WHERE id = ? AND processing_owner = ? AND delivery_state = 'sending' AND delivery_owner = ? AND delivery_generation = ?`;
const EXECUTION_UNKNOWN_SQL = `UPDATE telegram_pending_alerts SET delivery_state = 'execution_unknown', delivery_completed_at = ?, delivery_claim_expires_at = NULL, last_error_class = COALESCE(?, 'execution_unknown'), processing_owner = NULL, processing_started_at = NULL, processing_expires_at = NULL, updated_at = ? WHERE id = ? AND delivery_state = 'sending' AND delivery_owner = ? AND delivery_generation = ?`;
const RETRY_SQL = `UPDATE telegram_pending_alerts SET attempts = attempts + 1, delivery_state = 'pending', delivery_owner = NULL, delivery_started_at = NULL, delivery_completed_at = NULL, delivery_claim_expires_at = NULL, not_before_at = ?, last_error_class = ?, retry_after_sec = ?, updated_at = ?, processing_owner = NULL, processing_started_at = NULL, processing_expires_at = NULL WHERE id = ? AND delivery_state = 'sending' AND delivery_owner = ? AND delivery_generation = ?`;
const DEFER_SQL = `UPDATE telegram_pending_alerts SET not_before_at = ?, last_error_class = COALESCE(?, last_error_class), updated_at = ?, delivery_state = 'pending', delivery_owner = NULL, delivery_started_at = NULL, delivery_completed_at = NULL, delivery_claim_expires_at = NULL, processing_owner = NULL, processing_started_at = NULL, processing_expires_at = NULL WHERE id = ? AND delivery_state = 'sending' AND delivery_owner = ? AND delivery_generation = ?`;
const TERMINAL_GUARDS = {
  sent: {
    target: ` AND EXISTS (SELECT 1 FROM telegram_alert_job_targets target WHERE target.job_id = ? AND target.target_key = ? AND target.pending_dedupe_key = ? AND target.source_event_id = ? AND (target.final_delivery_state IS NULL OR target.final_delivery_state = 'accepted'))`,
    pending: `EXISTS (SELECT 1 FROM telegram_pending_alerts pending WHERE pending.id = ? AND pending.delivery_state = 'sent' AND pending.delivery_owner = ? AND pending.delivery_generation = ?)`,
    finalDeliveryState: "accepted" as const,
  },
  execution_unknown: {
    target: ` AND EXISTS (SELECT 1 FROM telegram_alert_job_targets target WHERE target.job_id = ? AND target.target_key = ? AND target.pending_dedupe_key = ? AND target.source_event_id = ? AND (target.final_delivery_state IS NULL OR target.final_delivery_state = 'execution_unknown'))`,
    pending: `EXISTS (SELECT 1 FROM telegram_pending_alerts pending WHERE pending.id = ? AND pending.delivery_state = 'execution_unknown' AND pending.delivery_owner = ? AND pending.delivery_generation = ?)`,
    finalDeliveryState: "execution_unknown" as const,
  },
} as const;

export function preparePendingSendingTransition(
  db: D1Database,
  claim: PendingDeliveryClaim,
  transition: PendingSendingTransition,
  options: PendingSendingTransitionOptions = {},
): D1PreparedStatement {
  const targetGuardSql = options.targetGuard?.sql ?? "";
  const targetGuardBinds = options.targetGuard?.binds ?? [];
  const updatedAtSec = options.updatedAtSec ?? Math.floor(Date.now() / 1000);
  switch (transition.to) {
    case "sent":
      return db.prepare(SENT_SQL + targetGuardSql).bind(transition.completedAt, transition.completedAt, claim.id, claim.owner, claim.owner, claim.generation, ...targetGuardBinds);
    case "execution_unknown":
      return db.prepare(EXECUTION_UNKNOWN_SQL + targetGuardSql).bind(transition.completedAt, transition.errorClass, transition.completedAt, claim.id, claim.owner, claim.generation, ...targetGuardBinds);
    case "pending":
      if ("retryAfterSec" in transition) {
        return db.prepare(RETRY_SQL).bind(transition.notBeforeAt, transition.errorClass, transition.retryAfterSec ?? null, updatedAtSec, claim.id, claim.owner, claim.generation);
      }
      return db.prepare(DEFER_SQL).bind(transition.notBeforeAt, transition.errorClass, updatedAtSec, claim.id, claim.owner, claim.generation);
  }
}

export async function persistPendingTerminalOutcomes(
  db: D1Database,
  {
    outcomes,
    state,
    nowSec,
  }: {
    outcomes: ReadonlyArray<PendingTerminalOutcome>;
    state: "sent" | "execution_unknown";
    nowSec: number;
  },
): Promise<void> {
  if (outcomes.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  const counterGuards = new Map<string, { targetKey: string }>();
  const guards = TERMINAL_GUARDS[state];
  for (const { claim, row, errorClass } of outcomes) {
    const identity = row.dedupe_key && row.source_event_id
      ? await resolveTelegramJobTargetIdentityForPending(db, {
        pendingDedupeKey: row.dedupe_key,
        sourceEventId: row.source_event_id,
      })
      : null;
    const targetGuard = identity
      ? {
          sql: guards.target,
          binds: [identity.jobId, identity.targetKey, identity.pendingDedupeKey, identity.sourceEventId],
        }
      : undefined;
    const transition: PendingSendingTransition = state === "sent"
      ? { to: "sent", completedAt: nowSec }
      : { to: "execution_unknown", completedAt: nowSec, errorClass: errorClass ?? null };
    statements.push(preparePendingSendingTransition(db, claim, transition, { targetGuard }));
    if (identity) {
      statements.push(prepareTelegramJobTargetFinalDeliveryProjection(
        db,
        identity,
        state === "sent"
          ? { state: "accepted", at: nowSec }
          : { state: "execution_unknown", at: nowSec, error: errorClass ?? null },
        { pendingGuard: { sql: guards.pending, binds: [claim.id, claim.owner, claim.generation] } },
      ));
      if (!counterGuards.has(identity.jobId)) counterGuards.set(identity.jobId, { targetKey: identity.targetKey });
    }
  }
  for (const [jobId, guard] of counterGuards) {
    statements.push(prepareTelegramAlertJobCounterReconciliation(db, jobId, nowSec, {
      targetKey: guard.targetKey,
      finalDeliveryState: guards.finalDeliveryState,
    }));
  }
  const changed = await executeAtomicBatch(db, statements);
  if (changed !== statements.length) {
    throw new Error(state === "sent"
      ? `Telegram sent-state persistence was not confirmed (${changed}/${statements.length})`
      : `Telegram pending ambiguity state was not confirmed (${changed}/${statements.length})`);
  }
  for (const { row, errorClass } of outcomes) {
    if (state === "sent") {
      await projectRecapPendingTerminalOutcome(db, row, "accepted", nowSec);
    } else {
      await projectRecapPendingTerminalOutcome(db, row, "execution_unknown", nowSec, errorClass ?? null);
    }
  }
}
