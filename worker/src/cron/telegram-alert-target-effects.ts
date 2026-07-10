import { throwIfAborted } from "../lib/abort";
import { executeAtomicBatch } from "../lib/db";
import { D1_BATCH_SIZE } from "../lib/constants";
import type { BatchMessage } from "../lib/telegram";
import { buildPendingAlertEnqueueStatement } from "./telegram-pending/enqueue";
import type { PendingEnqueueOptions } from "./telegram-pending/types";

export const TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC = 120;

export type TelegramFreshTargetEffectState =
  | "unstarted"
  | "claimed"
  | "sending"
  | "complete"
  | "execution_unknown";

export interface TelegramFreshTargetIdentity {
  jobId: string;
  targetKey: string;
}

export interface TelegramFreshTargetClaim extends TelegramFreshTargetIdentity {
  owner: string;
  generation: number;
}

export interface TelegramFreshTargetEffectOutcome extends TelegramFreshTargetClaim {
  status: "queued" | "sent" | "failed";
  at: number;
  errorClass?: string | null;
  executionUnknown?: boolean;
}

export interface TelegramFreshTargetPendingHandoff extends TelegramFreshTargetClaim {
  message: BatchMessage;
  options: PendingEnqueueOptions;
  at: number;
  errorClass?: string | null;
}

interface TelegramFreshTargetEffectRow {
  job_id: string;
  target_key: string;
  status: string;
  effect_state: TelegramFreshTargetEffectState;
  effect_owner: string | null;
  effect_generation: number;
  effect_claim_expires_at: number | null;
}

function identityKey(identity: TelegramFreshTargetIdentity): string {
  return `${identity.jobId}\0${identity.targetKey}`;
}

function uniqueIdentities(
  identities: readonly TelegramFreshTargetIdentity[],
): TelegramFreshTargetIdentity[] {
  const unique = new Map<string, TelegramFreshTargetIdentity>();
  for (const identity of identities) unique.set(identityKey(identity), identity);
  return [...unique.values()];
}

async function loadTargetEffectRows(
  db: D1Database,
  identities: readonly TelegramFreshTargetIdentity[],
): Promise<Map<string, TelegramFreshTargetEffectRow>> {
  const rowsByIdentity = new Map<string, TelegramFreshTargetEffectRow>();
  for (let index = 0; index < identities.length; index += 40) {
    const chunk = identities.slice(index, index + 40);
    if (chunk.length === 0) continue;
    const conditions = chunk.map(() => "(job_id = ? AND target_key = ?)").join(" OR ");
    const rows = await db
      .prepare(
        `SELECT job_id, target_key, status, effect_state, effect_owner,
                effect_generation, effect_claim_expires_at
           FROM telegram_alert_job_targets
          WHERE ${conditions}`,
      )
      .bind(...chunk.flatMap((identity) => [identity.jobId, identity.targetKey]))
      .all<TelegramFreshTargetEffectRow>();
    for (const row of rows.results ?? []) rowsByIdentity.set(identityKey({ jobId: row.job_id, targetKey: row.target_key }), row);
  }
  return rowsByIdentity;
}

export function createTelegramFreshTargetOwner(): string {
  const cryptoObj = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
    };
  }).crypto;
  if (!cryptoObj) throw new Error("Web Crypto is required for Telegram fresh target ownership");
  const suffix = cryptoObj.randomUUID?.() ?? (() => {
    if (!cryptoObj.getRandomValues) {
      throw new Error("Secure randomness is required for Telegram fresh target ownership");
    }
    const words = cryptoObj.getRandomValues(new Uint32Array(4));
    return [...words].map((word) => word.toString(16).padStart(8, "0")).join("");
  })();
  return `fresh-${suffix}`;
}

/**
 * Claim exact manifest targets before a send wave. Only an expired pre-effect
 * claim may be taken over; `sending` is never reclaimed automatically.
 */
export async function claimFreshTelegramAlertTargets(
  db: D1Database,
  identities: readonly TelegramFreshTargetIdentity[],
  owner: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ claims: Map<string, TelegramFreshTargetClaim>; skippedTargetKeys: Set<string> }> {
  const unique = uniqueIdentities(identities);
  if (unique.length === 0) return { claims: new Map(), skippedTargetKeys: new Set() };
  const claimExpiresAt = nowSec + TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC;

  await executeAtomicBatch(
    db,
    unique.map((identity) =>
      db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET effect_state = 'claimed',
                  effect_owner = ?,
                  effect_generation = effect_generation + 1,
                  effect_claimed_at = ?,
                  effect_started_at = NULL,
                  effect_completed_at = NULL,
                  effect_claim_expires_at = ?
            WHERE job_id = ?
              AND target_key = ?
              AND status = 'planned'
              AND (
                effect_state = 'unstarted'
                OR (
                  effect_state = 'claimed'
                  AND effect_claim_expires_at IS NOT NULL
                  AND effect_claim_expires_at <= ?
                )
              )`,
        )
        .bind(owner, nowSec, claimExpiresAt, identity.jobId, identity.targetKey, nowSec),
    ),
    { signal },
  );

  const rows = await loadTargetEffectRows(db, unique);
  const claims = new Map<string, TelegramFreshTargetClaim>();
  const skippedTargetKeys = new Set<string>();
  for (const identity of unique) {
    const row = rows.get(identityKey(identity));
    if (!row) {
      throw new Error("Telegram fresh target manifest row is missing");
    }
    if (row.effect_state === "claimed" && row.effect_owner === owner) {
      claims.set(identity.targetKey, {
        ...identity,
        owner,
        generation: Number(row.effect_generation),
      });
      continue;
    }
    if (
      row.status !== "planned" ||
      row.effect_state === "sending" ||
      row.effect_state === "complete" ||
      row.effect_state === "execution_unknown"
    ) {
      skippedTargetKeys.add(identity.targetKey);
      continue;
    }
    if (row.effect_state === "claimed") {
      throw new Error("Telegram fresh target has an active owner");
    }
    throw new Error("Telegram fresh target claim was not confirmed");
  }

  return { claims, skippedTargetKeys };
}

/** Durably cross the external-effect boundary immediately before Bot API I/O. */
export async function markFreshTelegramAlertTargetsSending(
  db: D1Database,
  claims: readonly TelegramFreshTargetClaim[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (claims.length === 0) return;
  const changed = await executeAtomicBatch(
    db,
    claims.map((claim) =>
      db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET effect_state = 'sending',
                  effect_started_at = ?,
                  effect_claim_expires_at = ?
            WHERE job_id = ?
              AND target_key = ?
              AND status = 'planned'
              AND effect_state = 'claimed'
              AND effect_owner = ?
              AND effect_generation = ?`,
        )
        .bind(
          nowSec,
          nowSec + TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC,
          claim.jobId,
          claim.targetKey,
          claim.owner,
          claim.generation,
        ),
    ),
    { signal },
  );
  if (changed !== claims.length) {
    throw new Error(`Telegram fresh target ownership changed before send (${changed}/${claims.length})`);
  }
}

/** Owner/generation-fenced terminal write after a confirmed or ambiguous effect. */
export async function finalizeFreshTelegramAlertTargetEffects(
  db: D1Database,
  outcomes: readonly TelegramFreshTargetEffectOutcome[],
  signal?: AbortSignal,
): Promise<void> {
  if (outcomes.length === 0) return;
  const changed = await executeAtomicBatch(
    db,
    outcomes.map((outcome) => {
      const effectState: TelegramFreshTargetEffectState = outcome.executionUnknown
        ? "execution_unknown"
        : "complete";
      const status = outcome.executionUnknown ? "planned" : outcome.status;
      const finalDeliveryState = outcome.executionUnknown
        ? "execution_unknown"
        : outcome.status === "sent"
          ? "accepted"
          : outcome.status === "failed"
            ? "failed"
            : null;
      const sentAt = status === "sent" ? outcome.at : null;
      const enqueuedAt = status === "queued" ? outcome.at : null;
      const failedAt = status === "failed" ? outcome.at : null;
      return db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET effect_state = ?,
                  effect_completed_at = ?,
                  effect_claim_expires_at = NULL,
                  status = ?,
                  sent_at = COALESCE(sent_at, ?),
                  enqueued_at = COALESCE(enqueued_at, ?),
                  failed_at = COALESCE(failed_at, ?),
                  final_delivery_state = COALESCE(final_delivery_state, ?),
                  final_delivery_at = COALESCE(final_delivery_at, ?),
                  final_delivery_error = COALESCE(final_delivery_error, ?),
                  error_class = COALESCE(?, error_class)
            WHERE job_id = ?
              AND target_key = ?
              AND effect_state = 'sending'
              AND status = 'planned'
              AND effect_owner = ?
              AND effect_generation = ?`,
        )
        .bind(
          effectState,
          outcome.at,
          status,
          sentAt,
          enqueuedAt,
          failedAt,
          finalDeliveryState,
          finalDeliveryState ? outcome.at : null,
          finalDeliveryState ? outcome.errorClass ?? (outcome.executionUnknown ? "execution_unknown" : null) : null,
          outcome.errorClass ?? (outcome.executionUnknown ? "execution_unknown" : null),
          outcome.jobId,
          outcome.targetKey,
          outcome.owner,
          outcome.generation,
        );
    }),
    { signal },
  );
  if (changed !== outcomes.length) {
    throw new Error(`Telegram fresh target terminal state was not confirmed (${changed}/${outcomes.length})`);
  }
}

/**
 * Atomically transfer confirmed retryable fresh sends to the durable pending
 * lifecycle. The conditional INSERT and owner-fenced target finalization share
 * one D1 transaction, so neither side can become authoritative on its own.
 */
export async function handoffFreshTelegramAlertTargetsToPending(
  db: D1Database,
  handoffs: readonly TelegramFreshTargetPendingHandoff[],
  signal?: AbortSignal,
): Promise<void> {
  if (handoffs.length === 0) return;
  const handoffsPerBatch = Math.max(1, Math.floor(D1_BATCH_SIZE / 2));
  for (let offset = 0; offset < handoffs.length; offset += handoffsPerBatch) {
    throwIfAborted(signal);
    const chunk = handoffs.slice(offset, offset + handoffsPerBatch);
    const statements = chunk.flatMap((handoff) => {
      const ownerGuard = {
        sql: `EXISTS (
          SELECT 1
            FROM telegram_alert_job_targets
           WHERE job_id = ?
             AND target_key = ?
             AND status = 'planned'
             AND effect_state = 'sending'
             AND effect_owner = ?
             AND effect_generation = ?
        )`,
        binds: [handoff.jobId, handoff.targetKey, handoff.owner, handoff.generation],
      };
      const pendingInsert = buildPendingAlertEnqueueStatement(
        db,
        handoff.message,
        handoff.at,
        handoff.options,
        ownerGuard,
      );
      const targetFinalize = db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET effect_state = 'complete',
                  effect_completed_at = ?,
                  effect_claim_expires_at = NULL,
                  status = 'queued',
                  enqueued_at = COALESCE(enqueued_at, ?),
                  error_class = COALESCE(?, error_class)
            WHERE job_id = ?
              AND target_key = ?
              AND status = 'planned'
              AND effect_state = 'sending'
              AND effect_owner = ?
              AND effect_generation = ?`,
        )
        .bind(
          handoff.at,
          handoff.at,
          handoff.errorClass ?? null,
          handoff.jobId,
          handoff.targetKey,
          handoff.owner,
          handoff.generation,
        );
      return [pendingInsert, targetFinalize];
    });
    const changed = await executeAtomicBatch(db, statements, { signal });
    if (changed !== statements.length) {
      throw new Error(`Telegram fresh retry handoff was not confirmed (${changed}/${statements.length})`);
    }
  }
}

/** Convert expired post-effect claims into an explicit operator-reconciliation state. */
export async function reconcileUnknownFreshTelegramAlertTargets(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET effect_state = 'execution_unknown',
              effect_completed_at = COALESCE(effect_completed_at, ?),
              effect_claim_expires_at = NULL,
              final_delivery_state = COALESCE(final_delivery_state, 'execution_unknown'),
              final_delivery_at = COALESCE(final_delivery_at, ?),
              final_delivery_error = COALESCE(final_delivery_error, 'fresh_effect_owner_lost'),
              error_class = COALESCE(error_class, 'fresh_effect_owner_lost')
        WHERE effect_state = 'sending'
          AND effect_claim_expires_at IS NOT NULL
          AND effect_claim_expires_at <= ?`,
    )
    .bind(nowSec, nowSec, nowSec)
    .run();
  return Number(result.meta?.changes ?? 0);
}
