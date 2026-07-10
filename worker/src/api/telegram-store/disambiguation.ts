import type { ResolvedCoin } from "../../lib/telegram-alerts";
import type {
  ConfirmBulkPayload,
  PendingActionType,
  PendingDisambiguationRow,
} from "../telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";
import { throwIfAborted } from "../../lib/abort";
import { dedupeCoins } from "../../lib/telegram-coin-dedupe";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import type { CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import { d1ChangeCount } from "./_internals";
import { unixNow } from "./subscribers";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "./_internals";
import { executeAtomicBatch } from "../../lib/db";

interface PendingDisambiguationPersistenceInput {
  chatId: string;
  actionType: string;
  actionPayload: object;
  alertTypes: readonly string[];
  resolvedIds: readonly string[];
  ambiguousTicker: string;
  candidates: readonly unknown[];
  remainingTickers: readonly string[];
  initiatorUserId: string | null;
  expiresAt?: number;
  operationStatements?: D1PreparedStatement[];
}

export async function persistPendingDisambiguation(
  db: D1Database,
  input: {
    chatId: string;
    actionType: PendingActionType;
    actionPayload: object;
    resolvedCoins: ResolvedCoin[];
    ambiguousTicker: string;
    candidates: ResolvedCoin[];
    remainingTickers: string[];
    alertTypes?: Set<string>;
    initiatorUserId: string | null;
    expiresAt?: number;
    operationStatements?: D1PreparedStatement[];
  },
): Promise<boolean> {
  return persistPendingDisambiguationRow(db, {
    chatId: input.chatId,
    actionType: input.actionType,
    actionPayload: input.actionPayload,
    alertTypes: Array.from(input.alertTypes ?? []),
    resolvedIds: dedupeCoins(input.resolvedCoins).map((coin) => coin.id),
    ambiguousTicker: input.ambiguousTicker,
    candidates: input.candidates,
    remainingTickers: input.remainingTickers,
    initiatorUserId: input.initiatorUserId,
    expiresAt: input.expiresAt,
    operationStatements: input.operationStatements,
  });
}

export async function persistPendingDisambiguationRow(
  db: D1Database,
  input: PendingDisambiguationPersistenceInput,
): Promise<boolean> {
  const nowSec = unixNow();
  const expiresAt = input.expiresAt ?? nowSec + DISAMBIGUATION_TTL_SEC;
  const statement = db
    .prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id,
        action_type,
        action_payload,
        alert_types,
        resolved_ids,
        ambiguous_ticker,
        candidates,
        remaining_tickers,
        expires_at,
        initiator_user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        action_type = excluded.action_type,
        action_payload = excluded.action_payload,
        alert_types = excluded.alert_types,
        resolved_ids = excluded.resolved_ids,
        ambiguous_ticker = excluded.ambiguous_ticker,
        candidates = excluded.candidates,
        remaining_tickers = excluded.remaining_tickers,
        expires_at = excluded.expires_at,
        initiator_user_id = excluded.initiator_user_id
      WHERE telegram_pending_disambiguation.expires_at <= ?
         OR telegram_pending_disambiguation.initiator_user_id IS NULL
         OR excluded.initiator_user_id IS NULL
         OR telegram_pending_disambiguation.initiator_user_id = excluded.initiator_user_id
    `)
    .bind(
      input.chatId,
      input.actionType,
      JSON.stringify(input.actionPayload),
      JSON.stringify(input.alertTypes),
      JSON.stringify(input.resolvedIds),
      input.ambiguousTicker,
      JSON.stringify(input.candidates),
      JSON.stringify(input.remainingTickers),
      expiresAt,
      input.initiatorUserId,
      nowSec,
    );
  if ((input.operationStatements?.length ?? 0) > 0) {
    const results = await runWithOverloadRetry(
      () => db.batch([statement, ...(input.operationStatements ?? [])]),
      3,
    );
    return d1ChangeCount(results[0] ?? ({ meta: {} } as D1Result<unknown>)) > 0;
  }
  const result = await statement.run();
  return d1ChangeCount(result) > 0;
}

export async function loadPendingDisambiguation(
  db: D1Database,
  chatId: string,
): Promise<PendingDisambiguationRow | null> {
  return db
    .prepare(
      "SELECT action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = ?",
    )
    .bind(chatId)
    .first<PendingDisambiguationRow>();
}

/**
 * Persist a "confirm-bulk" pending action. Uses the existing
 * telegram_pending_disambiguation row so the standard 5-min TTL cleanup applies.
 * `candidates` is stored as an empty array because no ticker disambiguation
 * is in flight — the user must tap the inline Confirm/Cancel button instead.
 */
export async function persistPendingConfirmBulk(
  db: D1Database,
  input: {
    chatId: string;
    payload: ConfirmBulkPayload;
    initiatorUserId: string | null;
    expiresAt?: number;
    operationStatements?: D1PreparedStatement[];
  },
): Promise<boolean> {
  return persistPendingDisambiguationRow(db, {
    chatId: input.chatId,
    actionType: "confirm-bulk",
    actionPayload: input.payload,
    alertTypes: [],
    resolvedIds: [],
    ambiguousTicker: "",
    candidates: [],
    remainingTickers: [],
    initiatorUserId: input.initiatorUserId,
    expiresAt: input.expiresAt,
    operationStatements: input.operationStatements,
  });
}

/**
 * Persist a "forget-confirm" pending action. Mirrors `persistPendingConfirmBulk`
 * — same TTL, same ownership rules — but uses a distinct `action_type` so the
 * `/forget` two-step flow stays separate from the `/subscribe all` / bulk
 * confirmation flow.
 */
export async function persistPendingForgetConfirm(
  db: D1Database,
  input: {
    chatId: string;
    initiatorUserId: string | null;
    expiresAt?: number;
    operationStatements?: D1PreparedStatement[];
  },
): Promise<boolean> {
  return persistPendingDisambiguationRow(db, {
    chatId: input.chatId,
    actionType: "forget-confirm",
    actionPayload: {},
    alertTypes: [],
    resolvedIds: [],
    ambiguousTicker: "",
    candidates: [],
    remainingTickers: [],
    initiatorUserId: input.initiatorUserId,
    expiresAt: input.expiresAt,
    operationStatements: input.operationStatements,
  });
}

export async function clearPendingDisambiguation(
  db: D1Database,
  chatId: string,
  options: TelegramOperationBatchOptions & {
    expected?: { actionType: string; expiresAt: number };
  } = {},
): Promise<void> {
  const statement = options.expected
    ? db.prepare(
        `DELETE FROM telegram_pending_disambiguation
          WHERE chat_id = ?
            AND action_type = ?
            AND expires_at = ?`,
      ).bind(chatId, options.expected.actionType, options.expected.expiresAt)
    : db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId);
  await executeAtomicBatch(db, appendTelegramOperationStatements([
    statement,
  ], options));
}

// Grace window past `expires_at` before a disambiguation row is eligible for
// cleanup. Two TTLs gives a slow user mid-selection room to finish, with a
// 10-minute floor so the guard remains meaningful if the TTL is ever shortened.
const DISAMBIGUATION_CLEANUP_GRACE_SEC = Math.max(2 * DISAMBIGUATION_TTL_SEC, 600);
const DISAMBIGUATION_CLEANUP_BATCH_SIZE = 500;
const DISAMBIGUATION_CLEANUP_MAX_BATCHES = 10;

/**
 * Deletes expired rows from `telegram_pending_disambiguation`. Rows are only
 * removed once `expires_at` is older than `2 * DISAMBIGUATION_TTL_SEC` (10 min
 * minimum) to avoid racing a slow user mid-selection.
 *
 * Runs on the existing 5-minute Telegram cron slot. Returns a `CronResult`
 * with `disambiguationRowsCleaned` in metadata for observability.
 */
export async function cleanExpiredDisambiguations(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const cutoffSec = Math.floor(Date.now() / 1000) - DISAMBIGUATION_CLEANUP_GRACE_SEC;
  let disambiguationRowsCleaned = 0;
  let batches = 0;
  let lastBatchSize = 0;

  do {
    throwIfAborted(signal);
    const result = await runWithOverloadRetry(
      () =>
        db
          .prepare(
            `
          DELETE FROM telegram_pending_disambiguation
          WHERE chat_id IN (
            SELECT chat_id
              FROM telegram_pending_disambiguation
             WHERE expires_at < ?
             ORDER BY expires_at ASC
             LIMIT ?
          )
        `,
          )
          .bind(cutoffSec, DISAMBIGUATION_CLEANUP_BATCH_SIZE)
          .run(),
      3,
      signal,
    );
    lastBatchSize = result.meta?.changes ?? 0;
    disambiguationRowsCleaned += lastBatchSize;
    batches += 1;
  } while (lastBatchSize >= DISAMBIGUATION_CLEANUP_BATCH_SIZE && batches < DISAMBIGUATION_CLEANUP_MAX_BATCHES);

  throwIfAborted(signal);
  const disambiguationCleanupHasMore = lastBatchSize >= DISAMBIGUATION_CLEANUP_BATCH_SIZE;
  return createCronResult({
    status: "ok",
    itemCount: disambiguationRowsCleaned,
    metadata: { disambiguationRowsCleaned, cutoffSec, batches, disambiguationCleanupHasMore },
  });
}
