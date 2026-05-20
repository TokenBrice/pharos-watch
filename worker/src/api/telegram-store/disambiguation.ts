import type { ResolvedCoin } from "../../lib/telegram-alerts";
import type {
  ConfirmBulkPayload,
  PendingActionType,
  PendingDisambiguationRow,
} from "../telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";
import { dedupeCoins } from "../telegram-webhook-parsing";
import { d1ChangeCount } from "./_internals";
import { unixNow } from "./subscribers";

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
  });
}

export async function persistPendingDisambiguationRow(
  db: D1Database,
  input: PendingDisambiguationPersistenceInput,
): Promise<boolean> {
  const nowSec = unixNow();
  const expiresAt = input.expiresAt ?? nowSec + DISAMBIGUATION_TTL_SEC;
  const result = await db
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
    )
    .run();
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
  });
}

export async function clearPendingDisambiguation(
  db: D1Database,
  chatId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?")
    .bind(chatId)
    .run();
}
