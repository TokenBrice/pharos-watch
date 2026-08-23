import { throwIfAborted } from "./abort";
import { executeAtomicBatch } from "./db";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import { parseJson } from "./json-parse";
import { buildTelegramMessage, sendToChat, type TelegramCreds } from "./telegram";
import { splitMessage } from "./telegram-alerts";
import type { TelegramDigestSuccessAction } from "./telegram-digest-appendices";
import {
  claimTelegramTransportPermit,
  recordTelegramTransportOutcomes,
  type TelegramTransportOutcome,
} from "./telegram-transport-control";
import { parseTelegramTransportErrorClass } from "./telegram-transport-errors";
import { logWorkerEvent } from "./structured-log";
import {
  DigestSafetyContextSchema,
  type DigestSafetyContext,
} from "@shared/types/digest";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  checkDigestSafetyContextForDelivery,
  findUnboundDigestSafetyClaimMarkers,
  parseDigestSafetyContext,
} from "./digest-safety-context";

export const TELEGRAM_DIGEST_OUTBOX_CLAIM_TTL_SEC = 120;
const TELEGRAM_DIGEST_OUTBOX_DRAIN_LIMIT = 4;
const TELEGRAM_DIGEST_OUTBOX_SENT_RETENTION_SEC = 90 * 86_400;
const TELEGRAM_DIGEST_OUTBOX_MAX_SUCCESS_ACTIONS = 20;
const TELEGRAM_DIGEST_OUTBOX_MAX_BACKOFF_SEC = 60 * 60;
const SAFETY_MAP_URL_PATTERN = /https:\/\/pharos\.watch\/safety-scores\/map\.png\?date=\d{4}-\d{2}-\d{2}/;

export type TelegramDigestKind = "daily" | "weekly";
export type TelegramDigestOutboxState =
  | "pending"
  | "sending"
  | "sent"
  | "execution_unknown"
  | "failed_permanent";

interface TelegramDigestOutboxRow {
  edition_key: string;
  digest_kind: TelegramDigestKind;
  digest_generated_at: number;
  target_chat_id: string;
  payload_chunks_json: string;
  success_actions_json: string;
  safety_context_json: string;
  state: TelegramDigestOutboxState;
  next_chunk_index: number;
  attempts: number;
  next_attempt_at: number | null;
  delivery_owner: string | null;
  delivery_generation: number;
  delivery_claim_expires_at: number | null;
  last_error_class: string | null;
  last_status_code: number | null;
}

interface TelegramDigestOutboxClaim {
  row: TelegramDigestOutboxRow;
  owner: string;
  generation: number;
  chunks: string[];
  successActions: TelegramDigestSuccessAction[];
  safetyContext: DigestSafetyContext;
}

export interface EnqueueTelegramDigestEditionInput {
  editionKey: string;
  digestKind: TelegramDigestKind;
  digestGeneratedAt: number;
  targetChatId: string;
  title: string;
  extended: string;
  date: string;
  editionNumber?: number | null;
  appendixHtml?: string | null;
  imageUrl?: string | null;
  successActions?: readonly TelegramDigestSuccessAction[];
  safetyContext: DigestSafetyContext;
}

export interface EnqueueTelegramDigestEditionResult {
  created: boolean;
  payloadMatched: boolean;
  editionKey: string;
  state: TelegramDigestOutboxState;
  chunks: readonly string[];
}

export interface TelegramDigestDeliveryResult {
  editionKey: string;
  state: TelegramDigestOutboxState;
  outcome: "sent" | "pending" | "execution_unknown" | "failed_permanent" | "skipped";
  chunksSent: number;
  nextChunkIndex: number;
  chunkCount: number;
  errorClass: string | null;
  retryAfterSec: number | null;
}

export interface TelegramDigestOutboxDrainSummary {
  due: number;
  attempted: number;
  sent: number;
  pending: number;
  executionUnknown: number;
  failedPermanent: number;
  skipped: number;
  staleSendingReconciled: number;
  retainedExecutionUnknown: number;
  retainedFailedPermanent: number;
  prunedSent: number;
}

function digestTransportOutcome(
  chatId: string,
  delivery: TelegramDigestDeliveryResult,
): TelegramTransportOutcome | null {
  if (delivery.outcome === "sent") {
    return {
      chatId,
      result: { ok: true, errorClass: null, retryAfterSec: null },
    };
  }
  const errorClass = parseTelegramTransportErrorClass(delivery.errorClass);
  if (errorClass == null || delivery.outcome === "skipped") return null;
  return {
    chatId,
    result: {
      ok: false,
      errorClass,
      retryAfterSec: delivery.retryAfterSec,
      ...(errorClass === "rate_limit" ? { rateLimitScope: "chat" as const } : {}),
    },
  };
}

function parseStringArray(raw: string, label: string): string[] {
  const result = parseJson(raw);
  if (!result.ok) throw new Error(`${label} must be valid JSON`);
  const parsed = result.value;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return parsed;
}

function parseSuccessActions(raw: string): TelegramDigestSuccessAction[] {
  const result = parseJson(raw);
  if (!result.ok) throw new Error("Telegram digest success actions must be valid JSON");
  const parsed = result.value;
  if (
    !Array.isArray(parsed)
    || parsed.length > TELEGRAM_DIGEST_OUTBOX_MAX_SUCCESS_ACTIONS
    || !parsed.every((value) => (
      value != null
      && typeof value === "object"
      && typeof (value as { key?: unknown }).key === "string"
      && typeof (value as { value?: unknown }).value === "string"
    ))
  ) {
    throw new Error("Telegram digest success actions are invalid");
  }
  return parsed as TelegramDigestSuccessAction[];
}

function parseStoredSafetyContext(raw: string): DigestSafetyContext {
  const result = parseJson(raw);
  if (!result.ok) throw new Error("Telegram digest safety context must be valid JSON");
  const context = parseDigestSafetyContext(result.value);
  if (!context) throw new Error("Telegram digest safety context is invalid");
  return context;
}

function createDeliveryOwner(): string {
  const cryptoObject = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  if (!cryptoObject?.randomUUID) {
    throw new Error("Web Crypto randomUUID is required for Telegram digest delivery ownership");
  }
  return `digest-${cryptoObject.randomUUID()}`;
}

function retryDelaySec(attempts: number, retryAfterSec: number | null): number {
  const exponential = Math.min(
    TELEGRAM_DIGEST_OUTBOX_MAX_BACKOFF_SEC,
    30 * (2 ** Math.max(0, Math.min(7, attempts - 1))),
  );
  return Math.max(exponential, retryAfterSec ?? 0);
}

async function loadEdition(
  db: D1Database,
  editionKey: string,
): Promise<TelegramDigestOutboxRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT edition_key, digest_kind, digest_generated_at, target_chat_id,
                payload_chunks_json, success_actions_json, safety_context_json, state, next_chunk_index,
                attempts, next_attempt_at, delivery_owner, delivery_generation,
                delivery_claim_expires_at, last_error_class, last_status_code
           FROM telegram_digest_outbox
          WHERE edition_key = ?`,
      )
      .bind(editionKey)
      .first<TelegramDigestOutboxRow>(),
  );
}

export async function enqueueTelegramDigestEdition(
  db: D1Database,
  input: EnqueueTelegramDigestEditionInput,
  signal?: AbortSignal,
): Promise<EnqueueTelegramDigestEditionResult> {
  throwIfAborted(signal);
  const expectedImageUrl = `${SITE_ORIGIN}/safety-scores/map.png?date=${encodeURIComponent(input.date)}`;
  if (input.imageUrl && input.imageUrl !== expectedImageUrl) {
    throw new Error("Telegram digest image URL must be the canonical dated Safety Score map");
  }
  const rendered = buildTelegramMessage(
    input.title,
    input.extended,
    input.date,
    input.editionNumber,
    input.appendixHtml,
    input.imageUrl,
  );
  const chunks = splitMessage(rendered);
  const payloadJson = JSON.stringify(chunks);
  const successActionsJson = JSON.stringify(input.successActions ?? []);
  const safetyContext = DigestSafetyContextSchema.parse(input.safetyContext);
  const unboundSafetyClaimMarkers = findUnboundDigestSafetyClaimMarkers(
    safetyContext,
    // The independently freshness-gated map publication is allowed even when
    // the authored digest copy omitted Safety Score claims. Remove only the
    // exact canonical URL; all human-readable copy remains under this guard.
    { extended: input.imageUrl ? rendered.replace(input.imageUrl, "") : rendered },
  );
  if (unboundSafetyClaimMarkers.length > 0) {
    throw new Error(
      `Telegram digest copy has Safety Score claims without an identified publication (${unboundSafetyClaimMarkers.join(", ")})`,
    );
  }
  const safetyContextJson = JSON.stringify(safetyContext);
  const nowSec = Math.floor(Date.now() / 1000);
  const insert = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO telegram_digest_outbox (
           edition_key, digest_kind, digest_generated_at, target_chat_id,
           payload_chunks_json, success_actions_json, safety_context_json, state, next_attempt_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        input.editionKey,
        input.digestKind,
        input.digestGeneratedAt,
        input.targetChatId,
        payloadJson,
        successActionsJson,
        safetyContextJson,
        nowSec,
        nowSec,
        nowSec,
      )
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const row = await loadEdition(db, input.editionKey);
  if (!row) throw new Error(`Telegram digest outbox insert was not confirmed (${input.editionKey})`);
  const payloadMatched = row.payload_chunks_json === payloadJson
    && row.success_actions_json === successActionsJson
    && row.safety_context_json === safetyContextJson
    && row.target_chat_id === input.targetChatId;
  if (!payloadMatched) {
    logWorkerEvent({ scope: "lib", level: "warn", event: "telegram_digest_immutable_edition_preserved", message: "Preserving immutable existing Telegram digest edition", metadata: { editionKey: input.editionKey } });
  }
  return {
    created: Number(insert.meta?.changes ?? 0) > 0,
    payloadMatched,
    editionKey: input.editionKey,
    state: row.state,
    chunks: parseStringArray(row.payload_chunks_json, "Telegram digest payload"),
  };
}

async function reconcileStaleSending(db: D1Database, nowSec: number): Promise<number> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE telegram_digest_outbox
            SET state = 'execution_unknown',
                delivery_completed_at = COALESCE(delivery_completed_at, ?),
                delivery_claim_expires_at = NULL,
                last_error_class = COALESCE(last_error_class, 'delivery_owner_lost'),
                updated_at = ?
          WHERE state = 'sending'
            AND delivery_claim_expires_at IS NOT NULL
            AND delivery_claim_expires_at <= ?`,
      )
      .bind(nowSec, nowSec, nowSec)
      .run(),
  );
  return Number(result.meta?.changes ?? 0);
}

async function claimEdition(
  db: D1Database,
  editionKey: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<TelegramDigestOutboxClaim | null> {
  throwIfAborted(signal);
  const candidate = await loadEdition(db, editionKey);
  if (!candidate || candidate.state !== "pending" || (candidate.next_attempt_at ?? 0) > nowSec) {
    return null;
  }
  const owner = createDeliveryOwner();
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE telegram_digest_outbox
            SET state = 'sending',
                delivery_owner = ?,
                delivery_generation = delivery_generation + 1,
                delivery_claimed_at = ?,
                delivery_started_at = ?,
                delivery_completed_at = NULL,
                delivery_claim_expires_at = ?,
                attempts = attempts + 1,
                last_error_class = NULL,
                last_status_code = NULL,
                updated_at = ?
          WHERE edition_key = ?
            AND state = 'pending'
            AND delivery_generation = ?
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .bind(
        owner,
        nowSec,
        nowSec,
        nowSec + TELEGRAM_DIGEST_OUTBOX_CLAIM_TTL_SEC,
        nowSec,
        editionKey,
        candidate.delivery_generation,
        nowSec,
      )
      .run(),
    3,
    signal,
  );
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  const row = await loadEdition(db, editionKey);
  if (!row || row.state !== "sending" || row.delivery_owner !== owner) {
    throw new Error(`Telegram digest outbox claim was not confirmed (${editionKey})`);
  }
  return {
    row,
    owner,
    generation: Number(row.delivery_generation),
    chunks: parseStringArray(row.payload_chunks_json, "Telegram digest payload"),
    successActions: parseSuccessActions(row.success_actions_json),
    safetyContext: parseStoredSafetyContext(row.safety_context_json),
  };
}

type ClaimedDigestTransition =
  | { state: "execution_unknown"; transitionAt: number; updatedAt: number; confirmation: "ambiguity" }
  | { state: "pending"; transitionAt: number; updatedAt: number; confirmation: "retry" }
  | { state: "failed_permanent"; transitionAt: number; updatedAt: number; confirmation: "permanent failure" };

async function transitionClaimedDigestEdition(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  transition: ClaimedDigestTransition,
  errorClass: string,
  statusCode: number | null,
): Promise<void> {
  const transitionSql = transition.state === "pending"
    ? `state = 'pending',
                next_attempt_at = ?,
                delivery_owner = NULL,
                delivery_claim_expires_at = NULL,
                last_error_class = ?,
                last_status_code = ?,
                updated_at = ?`
    : `state = '${transition.state}',
                delivery_completed_at = ?,
                delivery_claim_expires_at = NULL,
                last_error_class = ?,
                last_status_code = ?,
                updated_at = ?`;
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE telegram_digest_outbox
            SET ${transitionSql}
          WHERE edition_key = ?
            AND state = 'sending'
            AND delivery_owner = ?
            AND delivery_generation = ?`,
      )
      .bind(
        transition.transitionAt,
        errorClass,
        statusCode,
        transition.updatedAt,
        claim.row.edition_key,
        claim.owner,
        claim.generation,
      )
      .run(),
  );
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error(`Telegram digest ${transition.confirmation} state was not confirmed (${claim.row.edition_key})`);
  }
}

async function markExecutionUnknown(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  nowSec: number,
  errorClass: string,
  statusCode: number | null,
): Promise<void> {
  return transitionClaimedDigestEdition(
    db,
    claim,
    { state: "execution_unknown", transitionAt: nowSec, updatedAt: nowSec, confirmation: "ambiguity" },
    errorClass,
    statusCode,
  );
}

async function bestEffortMarkExecutionUnknown(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  nowSec: number,
  errorClass: string,
): Promise<void> {
  try {
    const result = await db
      .prepare(
        `UPDATE telegram_digest_outbox
            SET state = 'execution_unknown',
                delivery_completed_at = COALESCE(delivery_completed_at, ?),
                delivery_claim_expires_at = NULL,
                last_error_class = COALESCE(last_error_class, ?),
                updated_at = ?
          WHERE edition_key = ?
            AND state = 'sending'
            AND delivery_owner = ?
            AND delivery_generation = ?`,
      )
      .bind(
        nowSec,
        errorClass,
        nowSec,
        claim.row.edition_key,
        claim.owner,
        claim.generation,
      )
      .run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      logWorkerEvent({ scope: "lib", level: "error", event: "telegram_digest_ambiguity_persistence_lost", message: "Could not persist Telegram digest delivery ambiguity", metadata: { editionKey: claim.row.edition_key } });
    }
  } catch (error) {
    logWorkerEvent({ scope: "lib", level: "error", event: "telegram_digest_ambiguity_persistence_failed", message: "Failed to persist Telegram digest delivery ambiguity", error, metadata: { editionKey: claim.row.edition_key } });
  }
}

async function returnToPending(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  nowSec: number,
  errorClass: string,
  statusCode: number | null,
  retryAfterSec: number | null,
): Promise<void> {
  const delaySec = retryDelaySec(claim.row.attempts, retryAfterSec);
  return transitionClaimedDigestEdition(
    db,
    claim,
    { state: "pending", transitionAt: nowSec + delaySec, updatedAt: nowSec, confirmation: "retry" },
    errorClass,
    statusCode,
  );
}

async function markPermanentFailure(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  nowSec: number,
  errorClass: string,
  statusCode: number | null,
): Promise<void> {
  return transitionClaimedDigestEdition(
    db,
    claim,
    { state: "failed_permanent", transitionAt: nowSec, updatedAt: nowSec, confirmation: "permanent failure" },
    errorClass,
    statusCode,
  );
}

async function advanceAcceptedChunk(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  chunkIndex: number,
  nowSec: number,
): Promise<void> {
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE telegram_digest_outbox
              SET next_chunk_index = ?,
                  delivery_claim_expires_at = ?,
                  updated_at = ?
            WHERE edition_key = ?
              AND state = 'sending'
              AND delivery_owner = ?
              AND delivery_generation = ?
              AND next_chunk_index = ?`,
        )
        .bind(
          chunkIndex + 1,
          nowSec + TELEGRAM_DIGEST_OUTBOX_CLAIM_TTL_SEC,
          nowSec,
          claim.row.edition_key,
          claim.owner,
          claim.generation,
          chunkIndex,
        )
        .run(),
    );
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error("owner or cursor changed");
    }
  } catch (error) {
    await bestEffortMarkExecutionUnknown(
      db,
      claim,
      nowSec,
      `accepted_chunk_persistence_failed:${toErrorMessage(error).slice(0, 120)}`,
    );
    throw error;
  }
}

async function finalizeSentEdition(
  db: D1Database,
  claim: TelegramDigestOutboxClaim,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const statements = claim.successActions.map((action) =>
    db
      .prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(action.key, action.value, nowSec)
  );
  if (claim.row.digest_kind === "weekly") {
    statements.push(
      db
        .prepare(
          `UPDATE daily_digest
              SET digest_meta = json_set(
                    COALESCE(digest_meta, '{}'),
                    '$.telegramDelivered', json('true'),
                    '$.telegramDeliveryStatus', 'ok',
                    '$.telegramDeliveryUpdatedAt', ?,
                    '$.telegramDeliveredAt', ?
                  )
            WHERE generated_at = ?
              AND json_extract(digest_meta, '$.type') = 'weekly'`,
        )
        .bind(nowSec, nowSec, claim.row.digest_generated_at),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE telegram_digest_outbox
            SET state = 'sent',
                next_attempt_at = NULL,
                delivery_completed_at = ?,
                delivery_claim_expires_at = NULL,
                last_error_class = NULL,
                last_status_code = 200,
                updated_at = ?
          WHERE edition_key = ?
            AND state = 'sending'
            AND delivery_owner = ?
            AND delivery_generation = ?
            AND next_chunk_index = ?`,
      )
      .bind(
        nowSec,
        nowSec,
        claim.row.edition_key,
        claim.owner,
        claim.generation,
        claim.chunks.length,
      ),
  );
  try {
    const changed = await executeAtomicBatch(db, statements, { signal });
    if (changed !== statements.length) {
      throw new Error(`terminal batch changed ${changed}/${statements.length} rows`);
    }
  } catch (error) {
    await bestEffortMarkExecutionUnknown(
      db,
      claim,
      nowSec,
      `accepted_edition_persistence_failed:${toErrorMessage(error).slice(0, 120)}`,
    );
    throw error;
  }
}

function buildDeliveryResult(
  claim: TelegramDigestOutboxClaim,
  state: TelegramDigestOutboxState,
  outcome: TelegramDigestDeliveryResult["outcome"],
  params: {
    chunksSent: number;
    nextChunkIndex: number;
    errorClass?: string | null;
    retryAfterSec?: number | null;
  },
): TelegramDigestDeliveryResult {
  return {
    editionKey: claim.row.edition_key,
    state,
    outcome,
    chunksSent: params.chunksSent,
    nextChunkIndex: params.nextChunkIndex,
    chunkCount: claim.chunks.length,
    errorClass: params.errorClass ?? null,
    retryAfterSec: params.retryAfterSec ?? null,
  };
}

export async function deliverTelegramDigestEdition(
  db: D1Database,
  creds: TelegramCreds,
  editionKey: string,
  signal?: AbortSignal,
): Promise<TelegramDigestDeliveryResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  await reconcileStaleSending(db, nowSec);
  const claim = await claimEdition(db, editionKey, nowSec, signal);
  if (!claim) {
    const row = await loadEdition(db, editionKey);
    if (!row) throw new Error(`Telegram digest outbox edition is missing (${editionKey})`);
    const chunks = parseStringArray(row.payload_chunks_json, "Telegram digest payload");
    return {
      editionKey,
      state: row.state,
      outcome: "skipped",
      chunksSent: 0,
      nextChunkIndex: row.next_chunk_index,
      chunkCount: chunks.length,
      errorClass: row.last_error_class,
      retryAfterSec: null,
    };
  }

  if (claim.row.target_chat_id !== creds.chatId) {
    await markPermanentFailure(db, claim, nowSec, "target_chat_mismatch", null);
    return buildDeliveryResult(claim, "failed_permanent", "failed_permanent", {
      chunksSent: 0,
      nextChunkIndex: claim.row.next_chunk_index,
      errorClass: "target_chat_mismatch",
    });
  }

  const storedCopy = claim.chunks.join("\n");
  const safetyMapUrl = storedCopy.match(SAFETY_MAP_URL_PATTERN)?.[0];
  const unboundSafetyClaimMarkers = findUnboundDigestSafetyClaimMarkers(
    claim.safetyContext,
    { extended: safetyMapUrl ? storedCopy.replace(safetyMapUrl, "") : storedCopy },
  );
  if (unboundSafetyClaimMarkers.length > 0) {
    const errorClass = `unbound_safety_copy:${unboundSafetyClaimMarkers.join(",")}`;
    await markPermanentFailure(db, claim, nowSec, errorClass, null);
    return buildDeliveryResult(claim, "failed_permanent", "failed_permanent", {
      chunksSent: 0,
      nextChunkIndex: claim.row.next_chunk_index,
      errorClass,
    });
  }

  try {
    const safetyCheck = await checkDigestSafetyContextForDelivery(db, claim.safetyContext, signal);
    if (safetyCheck.kind === "stale") {
      await markPermanentFailure(db, claim, nowSec, `stale_safety_identity:${safetyCheck.reason}`, null);
      return buildDeliveryResult(claim, "failed_permanent", "failed_permanent", {
        chunksSent: 0,
        nextChunkIndex: claim.row.next_chunk_index,
        errorClass: `stale_safety_identity:${safetyCheck.reason}`,
      });
    }
    if (safetyCheck.kind === "unavailable") {
      await returnToPending(
        db,
        claim,
        nowSec,
        `safety_identity_unavailable:${safetyCheck.reason}`,
        null,
        null,
      );
      return buildDeliveryResult(claim, "pending", "pending", {
        chunksSent: 0,
        nextChunkIndex: claim.row.next_chunk_index,
        errorClass: `safety_identity_unavailable:${safetyCheck.reason}`,
      });
    }
  } catch (error) {
    const errorClass = `safety_identity_check_failed:${toErrorMessage(error).slice(0, 120)}`;
    await returnToPending(db, claim, nowSec, errorClass, null, null);
    return buildDeliveryResult(claim, "pending", "pending", {
      chunksSent: 0,
      nextChunkIndex: claim.row.next_chunk_index,
      errorClass,
    });
  }

  let chunksSent = 0;
  for (let chunkIndex = claim.row.next_chunk_index; chunkIndex < claim.chunks.length; chunkIndex++) {
    throwIfAborted(signal);
    const chunk = claim.chunks[chunkIndex]!;
    const safetyMapUrl = chunk.match(SAFETY_MAP_URL_PATTERN)?.[0];
    const result = await sendToChat(
      claim.row.target_chat_id,
      chunk,
      creds.botToken,
      {
        signal,
        ...(safetyMapUrl
          ? { linkPreviewOptions: { url: safetyMapUrl, prefer_large_media: true, show_above_text: true } }
          : {}),
      },
    );
    const completedAt = Math.floor(Date.now() / 1000);
    if (result.ok) {
      await advanceAcceptedChunk(db, claim, chunkIndex, completedAt);
      chunksSent++;
      continue;
    }

    const errorClass = result.errorClass ?? "unknown";
    if (result.statusCode == null) {
      await markExecutionUnknown(db, claim, completedAt, errorClass, null);
      return buildDeliveryResult(claim, "execution_unknown", "execution_unknown", {
        chunksSent,
        nextChunkIndex: chunkIndex,
        errorClass,
      });
    }
    if (result.retryable) {
      await returnToPending(
        db,
        claim,
        completedAt,
        errorClass,
        result.statusCode,
        result.retryAfterSec,
      );
      return buildDeliveryResult(claim, "pending", "pending", {
        chunksSent,
        nextChunkIndex: chunkIndex,
        errorClass,
        retryAfterSec: result.retryAfterSec,
      });
    }
    await markPermanentFailure(db, claim, completedAt, errorClass, result.statusCode);
    return buildDeliveryResult(claim, "failed_permanent", "failed_permanent", {
      chunksSent,
      nextChunkIndex: chunkIndex,
      errorClass,
    });
  }

  const completedAt = Math.floor(Date.now() / 1000);
  await finalizeSentEdition(db, claim, completedAt, signal);
  return buildDeliveryResult(claim, "sent", "sent", {
    chunksSent,
    nextChunkIndex: claim.chunks.length,
  });
}

async function listDueEditionKeys(
  db: D1Database,
  nowSec: number,
  limit: number,
): Promise<string[]> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT edition_key
           FROM telegram_digest_outbox
          WHERE state = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?`,
      )
      .bind(nowSec, limit)
      .all<{ edition_key: string }>(),
  );
  return (result.results ?? []).map((row) => row.edition_key);
}

async function countTerminalRows(
  db: D1Database,
): Promise<{ execution_unknown_count: number; failed_permanent_count: number }> {
  return (await db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count,
         SUM(CASE WHEN state = 'failed_permanent' THEN 1 ELSE 0 END) AS failed_permanent_count
       FROM telegram_digest_outbox
       WHERE state IN ('execution_unknown', 'failed_permanent')`,
    )
    .first<{ execution_unknown_count: number; failed_permanent_count: number }>()) ?? {
      execution_unknown_count: 0,
      failed_permanent_count: 0,
    };
}

async function pruneSentRows(db: D1Database, nowSec: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM telegram_digest_outbox
        WHERE edition_key IN (
          SELECT edition_key
            FROM telegram_digest_outbox
           WHERE state = 'sent' AND updated_at < ?
           ORDER BY updated_at ASC
           LIMIT 50
        )`,
    )
    .bind(nowSec - TELEGRAM_DIGEST_OUTBOX_SENT_RETENTION_SEC)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function drainTelegramDigestOutbox(
  db: D1Database,
  creds: TelegramCreds,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TelegramDigestOutboxDrainSummary> {
  const nowSec = Math.floor(Date.now() / 1000);
  const staleSendingReconciled = await reconcileStaleSending(db, nowSec);
  const editionKeys = await listDueEditionKeys(
    db,
    nowSec,
    Math.max(1, Math.min(TELEGRAM_DIGEST_OUTBOX_DRAIN_LIMIT, options.limit ?? TELEGRAM_DIGEST_OUTBOX_DRAIN_LIMIT)),
  );
  const summary: TelegramDigestOutboxDrainSummary = {
    due: editionKeys.length,
    attempted: 0,
    sent: 0,
    pending: 0,
    executionUnknown: 0,
    failedPermanent: 0,
    skipped: 0,
    staleSendingReconciled,
    retainedExecutionUnknown: 0,
    retainedFailedPermanent: 0,
    prunedSent: 0,
  };
  for (const editionKey of editionKeys) {
    throwIfAborted(options.signal);
    const permit = await claimTelegramTransportPermit(db, {
      mode: "fresh",
      owner: `telegram-digest-outbox-drain:${editionKey}`,
      nowSec: Math.floor(Date.now() / 1000),
      requestedDistinctChats: 1,
    });
    if (!permit.allowed) {
      summary.skipped += editionKeys.length - summary.attempted;
      break;
    }
    let result: TelegramDigestDeliveryResult;
    try {
      result = await deliverTelegramDigestEdition(db, creds, editionKey, options.signal);
      const transportOutcome = digestTransportOutcome(creds.chatId, result);
      await recordTelegramTransportOutcomes(
        db,
        permit,
        transportOutcome == null ? [] : [transportOutcome],
        Math.floor(Date.now() / 1000),
      );
    } catch (error) {
      await recordTelegramTransportOutcomes(db, permit, [], Math.floor(Date.now() / 1000));
      throw error;
    }
    summary.attempted++;
    if (result.outcome === "sent") summary.sent++;
    else if (result.outcome === "pending") summary.pending++;
    else if (result.outcome === "execution_unknown") summary.executionUnknown++;
    else if (result.outcome === "failed_permanent") summary.failedPermanent++;
    else summary.skipped++;
  }
  const terminal = await countTerminalRows(db);
  summary.retainedExecutionUnknown = Number(terminal.execution_unknown_count ?? 0);
  summary.retainedFailedPermanent = Number(terminal.failed_permanent_count ?? 0);
  summary.prunedSent = await pruneSentRows(db, nowSec);
  return summary;
}
