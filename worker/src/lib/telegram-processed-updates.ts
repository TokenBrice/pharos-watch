import { runWithOverloadRetry } from "./d1-overload-retry";
import { parseJson } from "./json-parse";
import {
  TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC,
  TELEGRAM_PROCESSING_STALE_SEC,
  TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_RETENTION_SEC,
} from "./telegram-constants";
import { d1ChangeCount } from "./telegram-operation-batch";
import { unixNowSec as unixNow } from "@shared/lib/time-constants";

export const TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT = 5_000;
const TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT = TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT + 1;
export const TELEGRAM_WEBHOOK_INTENT_VERSION = 1 as const;
const TELEGRAM_WEBHOOK_INTENT_MAX_BYTES = 65_536;

export interface TelegramProcessedUpdateBacklog {
  count: number;
  exact: boolean;
  probeLimit: number;
}

export type TelegramProcessedUpdateClaimStatus = "claimed" | "duplicate" | "in_flight" | "effect_unknown";

export interface TelegramProcessedUpdateClaim {
  status: TelegramProcessedUpdateClaimStatus;
  retryAfterSec?: number;
  claimOwner?: string;
  claimGeneration?: number;
  storedIntent?: TelegramWebhookOperationIntent;
  mutationAppliedAt?: number | null;
}

export interface TelegramWebhookOperationIntent {
  version: typeof TELEGRAM_WEBHOOK_INTENT_VERSION;
  kind: string;
  mutation: "none" | "required";
  payload: Record<string, unknown>;
}

interface ProcessedUpdateRow {
  status: string;
  received_at: number;
  effect_state: string;
  claim_owner: string | null;
  claim_generation: number;
  intent_version?: number | null;
  intent_kind?: string | null;
  intent_mutates?: number | null;
  intent_payload?: string | null;
  mutation_applied_at?: number | null;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== "object" || value == null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function isBoundedIntentValue(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value == null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 512;
  if (Array.isArray(value)) return value.length <= 512 && value.every((entry) => isBoundedIntentValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 50 && entries.every(([key, entry]) => (
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && isBoundedIntentValue(entry, depth + 1)
  ));
}

function isStringArray(value: unknown, max = 512): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every((entry) => typeof entry === "string" && entry.length <= 128);
}

function isNormalizedCommandIntent(intent: TelegramWebhookOperationIntent): boolean {
  const payload = intent.payload;
  if (intent.mutation !== "required") return false;
  if (payload.stage === "bulk-confirm-prompt") {
    return typeof payload.expiresAt === "number"
      && Number.isSafeInteger(payload.expiresAt)
      && typeof payload.payload === "object"
      && payload.payload != null
      && !Array.isArray(payload.payload);
  }
  if (payload.stage === "disambiguation-prompt") {
    return payload.actionType === intent.kind.slice("command:".length)
      && typeof payload.actionPayload === "object"
      && payload.actionPayload != null
      && !Array.isArray(payload.actionPayload)
      && isStringArray(payload.resolvedCoinIds)
      && typeof payload.ambiguousTicker === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.ambiguousTicker)
      && isStringArray(payload.candidateIds)
      && isStringArray(payload.remainingTickers)
      && typeof payload.expiresAt === "number"
      && Number.isSafeInteger(payload.expiresAt)
      && typeof payload.clearPending === "boolean";
  }
  if (intent.kind === "command:subscribe") {
    return isStringArray(payload.coinIds)
      && isStringArray(payload.presetIds)
      && isStringArray(payload.alertTypes, 8)
      && typeof payload.clearPending === "boolean"
      && (payload.depegWorseningBpsStep === null
        || payload.depegWorseningBpsStep === 100
        || payload.depegWorseningBpsStep === 250
        || payload.depegWorseningBpsStep === 500);
  }
  if (intent.kind === "command:unsubscribe") {
    return isStringArray(payload.coinIds)
      && isStringArray(payload.presetIds)
      && typeof payload.clearPending === "boolean";
  }
  if (intent.kind === "command:set") {
    if (payload.scope === "all") {
      return typeof payload.setting === "object"
        && payload.setting != null
        && !Array.isArray(payload.setting)
        && typeof payload.clearPending === "boolean";
    }
    return isStringArray(payload.coinIds)
      && typeof payload.setting === "object"
      && payload.setting != null
      && !Array.isArray(payload.setting)
      && typeof payload.clearPending === "boolean";
  }
  return false;
}

function isPendingClearIntent(intent: TelegramWebhookOperationIntent): boolean {
  const payload = intent.payload;
  return intent.mutation === "required"
    && typeof payload.actionType === "string"
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.actionType)
    && typeof payload.expiresAt === "number"
    && Number.isSafeInteger(payload.expiresAt)
    && (
      payload.reason === "cancel"
      || payload.reason === "setup-cancel"
      || payload.reason === "invalid"
      || payload.reason === "expired"
      || payload.reason === "clear-and-run"
    );
}

function isSettingsIntent(intent: TelegramWebhookOperationIntent): boolean {
  const payload = intent.payload;
  if (intent.mutation !== "required") return false;
  if (intent.kind === "callback:settings-gt") {
    return typeof payload.alertType === "string" && (payload.next === 0 || payload.next === 1);
  }
  if (intent.kind === "callback:settings-q") return typeof payload.enabled === "boolean";
  if (intent.kind === "callback:settings-sc") return payload.snoozeUntil === null;
  return intent.kind === "callback:settings-c"
    && typeof payload.coinId === "string"
    && typeof payload.setting === "string"
    && typeof payload.value === "string";
}

function isSetupIntent(intent: TelegramWebhookOperationIntent): boolean {
  if (intent.mutation !== "required" || intent.kind !== "callback:setup") return false;
  return typeof intent.payload.action === "string"
    && /^[a-z][a-z-]{0,31}$/.test(intent.payload.action)
    && [intent.payload.nextState, intent.payload.previousState, intent.payload.state]
      .some((state) => typeof state === "object" && state != null && !Array.isArray(state));
}

function isKnownIntentSchema(intent: Partial<TelegramWebhookOperationIntent>): intent is TelegramWebhookOperationIntent {
  if (
    intent.version !== TELEGRAM_WEBHOOK_INTENT_VERSION
    || (intent.mutation !== "none" && intent.mutation !== "required")
    || !intent.kind
    || !/^(ingress:no-effect|outbound:[a-z0-9._/-]+|command:\/?[a-z0-9_-]+|callback:[a-z0-9_-]+|member:lifecycle|chat:migration|pending:[a-z0-9_-]+)$/.test(intent.kind)
    || typeof intent.payload !== "object"
    || intent.payload == null
    || Array.isArray(intent.payload)
    || !isBoundedIntentValue(intent.payload)
  ) {
    return false;
  }
  if (intent.kind === "chat:migration") {
    return intent.mutation === "required"
      && typeof intent.payload.oldChatId === "string"
      && typeof intent.payload.newChatId === "string";
  }
  if (intent.kind === "ingress:no-effect" || intent.kind.startsWith("outbound:")) {
    return intent.mutation === "none";
  }
  if (intent.kind === "command:subscribe" || intent.kind === "command:unsubscribe" || intent.kind === "command:set") {
    return isNormalizedCommandIntent(intent as TelegramWebhookOperationIntent);
  }
  if (intent.kind.startsWith("pending:")) {
    return isPendingClearIntent(intent as TelegramWebhookOperationIntent);
  }
  if (intent.kind.startsWith("callback:settings-")) {
    return isSettingsIntent(intent as TelegramWebhookOperationIntent);
  }
  if (intent.kind === "callback:setup") {
    return isSetupIntent(intent as TelegramWebhookOperationIntent);
  }
  return true;
}

function parseStoredIntent(row: ProcessedUpdateRow): TelegramWebhookOperationIntent | null {
  if (
    row.intent_version !== TELEGRAM_WEBHOOK_INTENT_VERSION
    || !row.intent_kind
    || !row.intent_payload
  ) {
    return null;
  }
  try {
    const parsedResult = parseJson(row.intent_payload);
    if (!parsedResult.ok) return null;
    const parsed = parsedResult.value;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const envelope = parsed as Partial<TelegramWebhookOperationIntent>;
    if (
      envelope.version !== TELEGRAM_WEBHOOK_INTENT_VERSION
      || envelope.kind !== row.intent_kind
      || !isKnownIntentSchema(envelope)
      || Number(row.intent_mutates ?? 0) !== (envelope.mutation === "required" ? 1 : 0)
    ) {
      return null;
    }
    return envelope as TelegramWebhookOperationIntent;
  } catch {
    return null;
  }
}

function serializeIntent(intent: TelegramWebhookOperationIntent): string {
  if (intent.version !== TELEGRAM_WEBHOOK_INTENT_VERSION) {
    throw new Error("Unsupported Telegram webhook intent version");
  }
  if (!isKnownIntentSchema(intent)) throw new Error("Invalid Telegram webhook intent schema");
  const serialized = JSON.stringify(canonicalizeJson(intent));
  if (new TextEncoder().encode(serialized).byteLength > TELEGRAM_WEBHOOK_INTENT_MAX_BYTES) {
    throw new Error("Telegram webhook intent exceeds the storage limit");
  }
  return serialized;
}

function createProcessedUpdateClaimOwner(updateId: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = cryptoObj?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `telegram-update:${updateId}:${suffix}`;
}

export async function claimTelegramProcessedUpdate(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    updateType: string | null;
    chatId: string | null;
    processingStaleSec?: number;
  },
): Promise<TelegramProcessedUpdateClaim> {
  const staleSec = input.processingStaleSec ?? TELEGRAM_PROCESSING_STALE_SEC;
  const staleBefore = input.nowSec - staleSec;
  const claimOwner = createProcessedUpdateClaimOwner(input.updateId);
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO telegram_processed_updates (
         update_id,
         received_at,
         processed_at,
         update_type,
         chat_id,
         status,
         error_class,
         effect_state,
         effect_key,
         effect_started_at,
         claim_owner,
         claim_generation
       )
       VALUES (?, ?, NULL, ?, ?, 'processing', NULL, 'unstarted', ?, NULL, ?, 1)`,
    )
    .bind(
      input.updateId,
      input.nowSec,
      input.updateType,
      input.chatId,
      `telegram-update:${input.updateId}`,
      claimOwner,
    )
    .run();

  if (d1ChangeCount(insert) > 0) {
    return { status: "claimed", claimOwner, claimGeneration: 1 };
  }

  const existing = await db
    .prepare(
      `SELECT status, received_at, effect_state, claim_owner, claim_generation,
              intent_version, intent_kind, intent_mutates, intent_payload, mutation_applied_at
         FROM telegram_processed_updates
        WHERE update_id = ?`,
    )
    .bind(input.updateId)
    .first<ProcessedUpdateRow>();

  if (!existing) {
    return { status: "in_flight", retryAfterSec: staleSec };
  }

  if (existing.status === "processed") {
    return { status: "duplicate" };
  }

  if (existing.effect_state === "started") {
    await db
      .prepare(
        `UPDATE telegram_processed_updates
            SET effect_state = 'execution_unknown',
                error_class = COALESCE(error_class, 'duplicate_after_effect_start')
          WHERE update_id = ?
            AND status <> 'processed'
            AND effect_state = 'started'`,
      )
      .bind(input.updateId)
      .run();
    return { status: "effect_unknown" };
  }

  if (existing.effect_state === "execution_unknown") {
    return { status: "effect_unknown" };
  }

  if (existing.status === "processing" && existing.received_at > staleBefore) {
    return {
      status: "in_flight",
      retryAfterSec: Math.max(1, existing.received_at + staleSec - input.nowSec),
    };
  }

  const storedIntent = existing.effect_state === "planned" ? parseStoredIntent(existing) : undefined;
  if (existing.effect_state === "planned" && !storedIntent) {
    await db
      .prepare(
        `UPDATE telegram_processed_updates
            SET status = 'failed',
                effect_state = 'execution_unknown',
                error_class = 'corrupt_operation_intent'
          WHERE update_id = ?
            AND effect_state = 'planned'
            AND claim_generation = ?`,
      )
      .bind(input.updateId, existing.claim_generation)
      .run();
    return { status: "effect_unknown" };
  }

  const reclaim = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET received_at = ?,
              processed_at = NULL,
              update_type = COALESCE(?, update_type),
              chat_id = COALESCE(?, chat_id),
              status = 'processing',
              error_class = NULL,
              claim_owner = ?,
              claim_generation = claim_generation + 1
        WHERE update_id = ?
          AND effect_state IN ('unstarted', 'planned')
          AND claim_generation = ?
          AND (
            status = 'failed'
            OR (status = 'processing' AND received_at <= ?)
          )`,
    )
    .bind(
      input.nowSec,
      input.updateType,
      input.chatId,
      claimOwner,
      input.updateId,
      existing.claim_generation,
      staleBefore,
    )
    .run();

  if (d1ChangeCount(reclaim) > 0) {
    return {
      status: "claimed",
      claimOwner,
      claimGeneration: existing.claim_generation + 1,
      storedIntent: storedIntent ?? undefined,
      mutationAppliedAt: existing.mutation_applied_at ?? null,
    };
  }

  return { status: "in_flight", retryAfterSec: staleSec };
}

export async function recordTelegramProcessedUpdateIntent(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
    intent: TelegramWebhookOperationIntent;
  },
): Promise<void> {
  const serialized = serializeIntent(input.intent);
  const result = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET effect_state = 'planned',
              intent_version = ?,
              intent_kind = ?,
              intent_mutates = ?,
              intent_payload = ?,
              intent_recorded_at = COALESCE(intent_recorded_at, ?)
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state IN ('unstarted', 'planned')
          AND claim_owner = ?
          AND claim_generation = ?
          AND (intent_kind IS NULL OR intent_kind = ?)
          AND (intent_payload IS NULL OR intent_payload = ?)`,
    )
    .bind(
      input.intent.version,
      input.intent.kind,
      input.intent.mutation === "required" ? 1 : 0,
      serialized,
      input.nowSec,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
      input.intent.kind,
      serialized,
    )
    .run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update lost its operation-intent claim");
  }
}

export async function markTelegramProcessedUpdateMutationApplied(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
  },
): Promise<void> {
  const result = await prepareTelegramProcessedUpdateMutationApplied(db, input).run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update lost its mutation-applied claim");
  }
}

export function prepareTelegramProcessedUpdateMutationApplied(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO telegram_webhook_operation_mutations (
         update_id,
         claim_generation,
         applied_at
       )
       VALUES (
         (
           SELECT update_id
             FROM telegram_processed_updates
            WHERE update_id = ?
              AND status = 'processing'
              AND effect_state = 'planned'
              AND intent_mutates = 1
              AND claim_owner = ?
              AND claim_generation = ?
         ),
         ?,
         ?
       )`,
    )
    .bind(
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
      input.claimGeneration,
      input.nowSec,
    );
}

export function prepareTelegramProcessedUpdatePendingMutationApplied(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO telegram_webhook_operation_mutations (
         update_id,
         claim_generation,
         applied_at
       )
       VALUES (
         (
           SELECT p.update_id
             FROM telegram_processed_updates p
             JOIN telegram_pending_disambiguation d ON d.chat_id = ?
            WHERE p.update_id = ?
              AND p.status = 'processing'
              AND p.effect_state = 'planned'
              AND p.intent_mutates = 1
              AND p.claim_owner = ?
              AND p.claim_generation = ?
              AND d.action_type = ?
              AND d.action_payload = ?
              AND d.expires_at = ?
         ),
         ?,
         ?
       )`,
    )
    .bind(
      input.chatId,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
      input.actionType,
      input.actionPayload,
      input.expiresAt,
      input.claimGeneration,
      input.nowSec,
    );
}

export async function markTelegramProcessedUpdateEffectStarted(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
    effectKind: string;
  },
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(input.effectKind)) {
    throw new Error("Invalid Telegram webhook effect kind");
  }
  const result = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET effect_state = 'started',
              effect_started_at = COALESCE(effect_started_at, ?),
              effect_kind = ?,
              effect_ordinal = effect_ordinal + 1
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state IN ('planned', 'started')
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(input.nowSec, input.effectKind, input.updateId, input.claimOwner, input.claimGeneration)
    .run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update lost its effect-start claim");
  }
}

export async function markTelegramProcessedUpdateProcessed(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
    errorClass?: string | null;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'processed',
              processed_at = ?,
              error_class = ?,
              effect_state = 'complete',
              effect_completed_at = ?
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state IN ('planned', 'started')
          AND (intent_mutates = 0 OR mutation_applied_at IS NOT NULL)
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(
      input.nowSec,
      input.errorClass ?? null,
      input.nowSec,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
    )
    .run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update terminal marker lost ownership");
  }
}

export async function markTelegramProcessedUpdateFailed(
  db: D1Database,
  input: {
    updateId: number;
    claimOwner: string;
    claimGeneration: number;
    errorClass: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'failed',
              processed_at = NULL,
              error_class = ?,
              effect_state = CASE
                WHEN effect_state = 'started' THEN 'execution_unknown'
                ELSE effect_state
              END
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state IN ('unstarted', 'planned', 'started')
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(
      input.errorClass,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
    )
    .run();
}

export async function pruneTelegramProcessedUpdates(
  db: D1Database,
  input: {
    nowSec?: number;
    retentionSec?: number;
    unknownRetentionSec?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const unknownRetentionSec = input.unknownRetentionSec ?? TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_RETENTION_SEC;
  const limit = input.limit ?? TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT) {
    throw new RangeError(
      `Telegram processed-update prune limit must be between 1 and ${TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT}.`,
    );
  }
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `DELETE FROM telegram_processed_updates
            WHERE update_id IN (
              SELECT update_id
                FROM telegram_processed_updates
               WHERE (
                 effect_state NOT IN ('started', 'execution_unknown')
                 AND received_at < ?
               ) OR (
                 effect_state IN ('started', 'execution_unknown')
                 AND received_at < ?
               )
               ORDER BY received_at ASC, update_id ASC
               LIMIT ?
            )`,
        )
        .bind(nowSec - retentionSec, nowSec - unknownRetentionSec, limit)
        .run(),
    3,
    input.signal,
  );
  return d1ChangeCount(result);
}

export async function countTelegramProcessedUpdateBacklog(
  db: D1Database,
  input: {
    nowSec?: number;
    retentionSec?: number;
    unknownRetentionSec?: number;
    signal?: AbortSignal;
  } = {},
): Promise<TelegramProcessedUpdateBacklog> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const unknownRetentionSec = input.unknownRetentionSec ?? TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_RETENTION_SEC;
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM (
               SELECT update_id
                 FROM telegram_processed_updates
                WHERE (
                  effect_state NOT IN ('started', 'execution_unknown')
                  AND received_at < ?
                ) OR (
                  effect_state IN ('started', 'execution_unknown')
                  AND received_at < ?
                )
                ORDER BY received_at ASC, update_id ASC
                LIMIT ?
             )`,
        )
        .bind(
          nowSec - retentionSec,
          nowSec - unknownRetentionSec,
          TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT,
        )
        .first<{ count: number }>(),
    3,
    input.signal,
  );
  const count = Math.max(0, Number(row?.count ?? 0));
  return {
    count,
    exact: count < TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT,
    probeLimit: TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT,
  };
}

export interface TelegramCommandCooldownResult {
  allowed: boolean;
  retryAfterSec: number;
}

export async function acquireTelegramCommandCooldown(
  db: D1Database,
  input: {
    chatId: string;
    commandKey: string;
    nowSec: number;
    cooldownSec: number;
  },
): Promise<TelegramCommandCooldownResult> {
  const key = `telegram:command-cooldown:${input.chatId}:${input.commandKey}`;
  const eligibleBefore = input.nowSec - input.cooldownSec;
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE cache.updated_at <= ?`,
    )
    .bind(key, "1", input.nowSec, eligibleBefore)
    .run();

  if (d1ChangeCount(result) > 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const row = await db.prepare("SELECT updated_at FROM cache WHERE key = ?").bind(key).first<{ updated_at: number }>();
  const lastUsedAt = Number(row?.updated_at);
  const retryAfterSec = Number.isFinite(lastUsedAt)
    ? Math.max(1, input.cooldownSec - (input.nowSec - lastUsedAt))
    : input.cooldownSec;
  return { allowed: false, retryAfterSec };
}

export async function releaseTelegramCommandCooldown(
  db: D1Database,
  input: {
    chatId: string;
    commandKey: string;
  },
): Promise<void> {
  const key = `telegram:command-cooldown:${input.chatId}:${input.commandKey}`;
  await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
}

export interface TelegramChatCommandFloodResult {
  allowed: boolean;
  /** True exactly when this command crossed the limit, so callers reply once. */
  firstExceeded: boolean;
}

/** @internal Exported so the SQLite contention regression executes the production statement. */
export const TELEGRAM_CHAT_FLOOD_UPSERT_SQL = `INSERT INTO cache (key, value, updated_at)
 VALUES (?, '1', ?)
 ON CONFLICT(key) DO UPDATE SET
   value = CASE
     WHEN cache.updated_at <= ? THEN '1'
     ELSE CAST(COALESCE(CAST(cache.value AS INTEGER), 0) + 1 AS TEXT)
   END,
   updated_at = CASE
     WHEN cache.updated_at <= ? THEN excluded.updated_at
     ELSE cache.updated_at
   END
 RETURNING value`;

/**
 * Generous per-chat fixed-window command counter covering every command,
 * including light ones with no per-command cooldown. The conditional upsert
 * increments or rotates the window atomically under concurrent webhooks.
 */
export async function recordTelegramChatCommandFlood(
  db: D1Database,
  input: {
    chatId: string;
    nowSec: number;
    windowSec: number;
    limit: number;
  },
): Promise<TelegramChatCommandFloodResult> {
  const key = `telegram:command-flood:${input.chatId}`;
  const rotateBeforeOrAt = input.nowSec - input.windowSec;
  const row = await db
    .prepare(TELEGRAM_CHAT_FLOOD_UPSERT_SQL)
    .bind(key, input.nowSec, rotateBeforeOrAt, rotateBeforeOrAt)
    .first<{ value: string }>();
  const count = Number.parseInt(row?.value ?? "", 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("Telegram chat flood counter upsert returned no valid count");
  }
  return { allowed: count <= input.limit, firstExceeded: count === input.limit + 1 };
}
