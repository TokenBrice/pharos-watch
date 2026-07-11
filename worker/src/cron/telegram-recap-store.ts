import { executeAtomicBatch } from "../lib/db";

export const TELEGRAM_RECAP_PAGE_SIZE = 90;
export const TELEGRAM_RECAP_PENDING_PRIORITY = 100;
export const TELEGRAM_RECAP_PENDING_TTL_SEC = 6 * 60 * 60;
export const TELEGRAM_RECAP_FORMAT_VERSION = 1;

export function buildTelegramRecapDedupeKey(chatId: string, localDate: string): string {
  if (!chatId || !localDate) throw new Error("Telegram recap dedupe identity is required");
  return `recap:${chatId}:${localDate}:v${TELEGRAM_RECAP_FORMAT_VERSION}`;
}

export type TelegramRecapTargetStatus =
  | "skipped_no_changes"
  | "skipped_paused"
  | "skipped_stale"
  | "planned"
  | "queued"
  | "sent"
  | "cancelled"
  | "expired"
  | "execution_unknown"
  | "failed_permanent";

export interface TelegramRecapPreference {
  chatId: string;
  chatKind: "private";
  enabled: boolean;
  cadence: "daily";
  deliveryHourLocal: number;
  nextDueAt: number | null;
  lastWindowEndAt: number | null;
  lastDeliveredLocalDate: string | null;
  createdAt: number;
  updatedAt: number;
  preferenceGeneration: number;
}

export interface TelegramRecapPreferenceInput {
  chatId: string;
  chatKind?: "private";
  enabled: boolean;
  deliveryHourLocal: number;
  nextDueAt: number | null;
  nowSec: number;
  expectedPreferenceGeneration?: number;
}

export interface DueTelegramRecapPreference extends TelegramRecapPreference {
  expectedNextDueAt: number;
}

export interface TelegramRecapTargetInput {
  recapKey: string;
  chatId: string;
  localDate: string;
  windowStartAt: number;
  windowEndAt: number;
  tapeHighWaterId?: number | null;
  preferenceGeneration: number;
  watchlistFingerprint: string;
  payloadHash?: string | null;
  materialCoinCount?: number;
  materialFactCount?: number;
  omittedFactCount?: number;
  pendingDedupeKey: string;
  nextDueAtAfter?: number | null;
  messageHtml: string;
  disableNotification?: boolean;
  markupPolicyJson?: string | null;
  nowSec: number;
  expectedNextDueAt: number;
}

export type TelegramRecapPlanResult = "queued" | "stale";

export interface TelegramRecapSkipInput {
  target: Omit<TelegramRecapTargetInput, "messageHtml" | "pendingDedupeKey"> & {
    pendingDedupeKey?: string | null;
    nextDueAtAfter?: number | null;
  };
  status: "skipped_no_changes" | "skipped_paused" | "skipped_stale";
  reason?: string | null;
  consumeWindow?: boolean;
}

interface PreferenceRow {
  chat_id: string;
  enabled: number;
  cadence: "daily";
  delivery_hour_local: number;
  next_due_at: number | null;
  last_window_end_at: number | null;
  last_delivered_local_date: string | null;
  created_at: number;
  updated_at: number;
  preference_generation: number;
}

interface TargetRow {
  recap_key: string;
  chat_id: string;
  local_date: string;
  window_end_at: number;
  status: TelegramRecapTargetStatus;
}

function mapPreference(row: PreferenceRow): TelegramRecapPreference {
  return {
    chatId: row.chat_id,
    chatKind: "private",
    enabled: Number(row.enabled) === 1,
    cadence: "daily",
    deliveryHourLocal: Number(row.delivery_hour_local),
    nextDueAt: row.next_due_at == null ? null : Number(row.next_due_at),
    lastWindowEndAt: row.last_window_end_at == null ? null : Number(row.last_window_end_at),
    lastDeliveredLocalDate: row.last_delivered_local_date,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    preferenceGeneration: Number(row.preference_generation ?? 0),
  };
}

function validateInput(input: TelegramRecapPreferenceInput): void {
  if (!input.chatId || !Number.isSafeInteger(input.nowSec) || input.nowSec < 0) {
    throw new Error("Invalid Telegram recap preference input");
  }
  if (input.chatKind != null && input.chatKind !== "private") {
    throw new Error("Personalized recaps are private-chat-only");
  }
  if (!Number.isInteger(input.deliveryHourLocal) || input.deliveryHourLocal < 0 || input.deliveryHourLocal > 23) {
    throw new RangeError("Telegram recap delivery hour must be between 0 and 23");
  }
  if (input.expectedPreferenceGeneration != null &&
      (!Number.isSafeInteger(input.expectedPreferenceGeneration) || input.expectedPreferenceGeneration < 0)) {
    throw new RangeError("Telegram recap preference generation is invalid");
  }
}

/** Read the recap preference together with the subscriber's generation fence. */
export async function getTelegramRecapPreference(
  db: D1Database,
  chatId: string,
): Promise<TelegramRecapPreference | null> {
  const row = await db.prepare(`
    SELECT p.chat_id, p.enabled, p.cadence, p.delivery_hour_local,
           p.next_due_at, p.last_window_end_at, p.last_delivered_local_date,
           p.created_at, p.updated_at, s.preference_generation
      FROM telegram_recap_preferences p
      LEFT JOIN telegram_subscribers s ON s.chat_id = p.chat_id
     WHERE p.chat_id = ?
  `).bind(chatId).first<PreferenceRow>();
  return row ? mapPreference(row) : null;
}

/**
 * Set recap intent and bump the shared subscriber generation in one atomic
 * transaction. A stale expected generation is a no-op, never a lost update.
 */
export async function setTelegramRecapPreference(
  db: D1Database,
  input: TelegramRecapPreferenceInput,
): Promise<boolean> {
  validateInput(input);
  const expected = input.expectedPreferenceGeneration;
  const generationGuard = expected == null ? "1 = 1" : "s.preference_generation = ?";
  const generationBinds = expected == null ? [] : [expected];
  const nextGeneration = expected == null ? null : expected + 1;
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO telegram_recap_preferences (
        chat_id, chat_kind, enabled, cadence, delivery_hour_local, next_due_at,
        created_at, updated_at
      )
      SELECT ?, 'private', ?, 'daily', ?, ?, ?, ?
      FROM telegram_subscribers s
       WHERE s.chat_id = ? AND ${generationGuard}
      ON CONFLICT(chat_id) DO UPDATE SET
        enabled = excluded.enabled,
        cadence = excluded.cadence,
        delivery_hour_local = excluded.delivery_hour_local,
        next_due_at = excluded.next_due_at,
        updated_at = excluded.updated_at
    `).bind(
      input.chatId,
      input.enabled ? 1 : 0,
      input.deliveryHourLocal,
      input.nextDueAt,
      input.nowSec,
      input.nowSec,
      input.chatId,
      ...generationBinds,
    ),
    db.prepare(`
      UPDATE telegram_subscribers
         SET preference_generation = preference_generation + 1
       WHERE chat_id = ?
         AND ${expected == null ? "1 = 1" : "preference_generation = ?"}
    `).bind(input.chatId, ...(expected == null ? [] : [expected])),
  ];
  await executeAtomicBatch(db, statements);
  // The first statement is deliberately guarded by the old generation. The
  // second statement's changes count is not portable across D1 mocks, so read
  // back the row and verify the requested state plus the expected bump.
  const current = await getTelegramRecapPreference(db, input.chatId);
  if (!current) return false;
  const generationMatches = expected == null || current.preferenceGeneration === nextGeneration;
  return generationMatches && current.enabled === input.enabled &&
    current.deliveryHourLocal === input.deliveryHourLocal && current.nextDueAt === input.nextDueAt;
}

/** Return a bounded due page. Pagination is schedule-based, so no cursor is needed. */
export async function listDueTelegramRecapPreferences(
  db: D1Database,
  nowSec: number,
  limit: number = TELEGRAM_RECAP_PAGE_SIZE,
): Promise<DueTelegramRecapPreference[]> {
  const boundedLimit = Math.max(1, Math.min(TELEGRAM_RECAP_PAGE_SIZE, Math.floor(limit)));
  const rows = await db.prepare(`
    SELECT p.chat_id, p.enabled, p.cadence, p.delivery_hour_local,
           p.next_due_at, p.last_window_end_at, p.last_delivered_local_date,
           p.created_at, p.updated_at, s.preference_generation
      FROM telegram_recap_preferences p
      JOIN telegram_subscribers s ON s.chat_id = p.chat_id
       WHERE p.enabled = 1 AND p.chat_kind = 'private'
       AND p.next_due_at IS NOT NULL
       AND p.next_due_at <= ?
     ORDER BY p.next_due_at ASC, p.chat_id ASC
     LIMIT ?
  `).bind(nowSec, boundedLimit).all<PreferenceRow>();
  return (rows.results ?? []).map((row) => ({
    ...mapPreference(row),
    expectedNextDueAt: Number(row.next_due_at),
  }));
}

function targetValues(input: TelegramRecapTargetInput, status: TelegramRecapTargetStatus): unknown[] {
  return [
    input.recapKey,
    input.chatId,
    input.localDate,
    input.windowStartAt,
    input.windowEndAt,
    input.tapeHighWaterId ?? null,
    input.preferenceGeneration,
    input.watchlistFingerprint,
    input.payloadHash ?? null,
    input.materialCoinCount ?? 0,
    input.materialFactCount ?? 0,
    input.omittedFactCount ?? 0,
    input.pendingDedupeKey,
    status,
    input.nowSec,
    input.nowSec,
  ];
}

/**
 * Atomically persist a target, exact pending payload, pending identity, and
 * next schedule. Every statement is guarded by the claimed preference state.
 */
export async function queueTelegramRecapTarget(
  db: D1Database,
  input: TelegramRecapTargetInput,
): Promise<TelegramRecapPlanResult> {
  // Avoid treating a replay of an already committed local-date target as a
  // fresh handoff. The unique key is the final defense for concurrent calls;
  // this read gives callers a useful stale result on ordinary retries.
  const existing = await db.prepare(
    "SELECT status FROM telegram_recap_targets WHERE recap_key = ?",
  ).bind(input.recapKey).first<{ status: TelegramRecapTargetStatus }>();
  if (existing) return "stale";
  const values = targetValues(input, "planned");
  const guard = `p.chat_id = ? AND p.chat_kind = 'private' AND p.enabled = 1 AND p.next_due_at = ?
                 AND s.preference_generation = ?`;
  const target = db.prepare(`
    INSERT INTO telegram_recap_targets (
      recap_key, chat_id, local_date, window_start_at, window_end_at,
      tape_high_water_id, preference_generation, watchlist_fingerprint,
      payload_hash, material_coin_count, material_fact_count, omitted_fact_count,
      pending_dedupe_key, status, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM telegram_recap_preferences p
      JOIN telegram_subscribers s ON s.chat_id = p.chat_id
     WHERE ${guard}
       AND NOT EXISTS (
         SELECT 1 FROM telegram_recap_targets existing
          WHERE existing.chat_id = ? AND existing.local_date = ?
       )
  `).bind(...values, input.chatId, input.expectedNextDueAt, input.preferenceGeneration, input.chatId, input.localDate);
  const pending = db.prepare(`
    INSERT INTO telegram_pending_alerts (
      chat_id, message_html, disable_notification, created_at, not_before_at,
      updated_at, dedupe_key, chunk_index, priority, source_type, alert_type,
      expires_at, source_event_id, preference_generation, markup_policy_json
    )
    SELECT ?, ?, ?, ?, NULL, ?, ?, 0, ?, 'personalized_recap', NULL, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM telegram_recap_targets
         WHERE recap_key = ? AND status = 'planned'
      )
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    input.chatId,
    input.messageHtml,
    input.disableNotification ? 1 : 0,
    input.nowSec,
    input.nowSec,
    input.pendingDedupeKey,
    TELEGRAM_RECAP_PENDING_PRIORITY,
    input.nowSec + TELEGRAM_RECAP_PENDING_TTL_SEC,
    input.recapKey,
    input.preferenceGeneration,
    input.markupPolicyJson ?? null,
    input.recapKey,
  );
  const attach = db.prepare(`
    UPDATE telegram_recap_targets
       SET pending_id = (SELECT id FROM telegram_pending_alerts WHERE dedupe_key = ?),
           status = 'queued', queued_at = ?, updated_at = ?
     WHERE recap_key = ? AND status = 'planned'
       AND pending_id IS NULL
       AND EXISTS (SELECT 1 FROM telegram_pending_alerts WHERE dedupe_key = ?)
  `).bind(input.pendingDedupeKey, input.nowSec, input.nowSec, input.recapKey, input.pendingDedupeKey);
  const advance = db.prepare(`
    UPDATE telegram_recap_preferences
       SET next_due_at = ?, updated_at = ?
     WHERE chat_id = ? AND enabled = 1 AND next_due_at = ?
  `).bind(input.nextDueAtAfter ?? null, input.nowSec, input.chatId, input.expectedNextDueAt);
  await executeAtomicBatch(db, [target, pending, attach, advance]);
  const row = await db.prepare(
    "SELECT status FROM telegram_recap_targets WHERE recap_key = ?",
  ).bind(input.recapKey).first<{ status: TelegramRecapTargetStatus }>();
  return row?.status === "queued" ? "queued" : "stale";
}

/** Persist no-change, paused, or stale outcomes while advancing only the safe window. */
export async function recordTelegramRecapSkip(
  db: D1Database,
  input: TelegramRecapSkipInput,
): Promise<boolean> {
  const t = input.target;
  const consumeWindow = input.consumeWindow ?? input.status !== "skipped_stale";
  const target = db.prepare(`
    INSERT INTO telegram_recap_targets (
      recap_key, chat_id, local_date, window_start_at, window_end_at,
      tape_high_water_id, preference_generation, watchlist_fingerprint,
      payload_hash, material_coin_count, material_fact_count, omitted_fact_count,
      pending_dedupe_key, status, terminal_reason, created_at, completed_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM telegram_recap_preferences p
      JOIN telegram_subscribers s ON s.chat_id = p.chat_id
     WHERE p.chat_id = ? AND p.chat_kind = 'private' AND p.enabled = 1 AND p.next_due_at = ?
       AND s.preference_generation = ?
       AND NOT EXISTS (SELECT 1 FROM telegram_recap_targets x
                        WHERE x.chat_id = ? AND x.local_date = ?)
  `).bind(
    t.recapKey, t.chatId, t.localDate, t.windowStartAt, t.windowEndAt,
    t.tapeHighWaterId ?? null, t.preferenceGeneration, t.watchlistFingerprint,
    t.payloadHash ?? null, t.materialCoinCount ?? 0, t.materialFactCount ?? 0,
    t.omittedFactCount ?? 0, t.pendingDedupeKey ?? null, input.status,
    input.reason ?? null, t.nowSec, t.nowSec, t.nowSec,
    t.chatId, t.expectedNextDueAt, t.preferenceGeneration, t.chatId, t.localDate,
  );
  const advance = db.prepare(`
    UPDATE telegram_recap_preferences
       SET next_due_at = ?,
           last_window_end_at = CASE WHEN ? = 1
             THEN MAX(COALESCE(last_window_end_at, 0), ?)
             ELSE last_window_end_at END,
           updated_at = ?
     WHERE chat_id = ? AND enabled = 1 AND next_due_at = ?
  `).bind(t.nextDueAtAfter ?? null, consumeWindow ? 1 : 0, t.windowEndAt, t.nowSec, t.chatId, t.expectedNextDueAt);
  await executeAtomicBatch(db, [target, advance]);
  const row = await db.prepare(
    "SELECT status FROM telegram_recap_targets WHERE recap_key = ?",
  ).bind(t.recapKey).first<{ status: TelegramRecapTargetStatus }>();
  return row?.status === input.status;
}

export type TelegramRecapTerminalOutcome =
  | "accepted"
  | "execution_unknown"
  | "cancelled"
  | "expired"
  | "failed_permanent";

/** Project one terminal pending outcome and consume the window monotonically. */
export async function projectTelegramRecapTerminalOutcome(
  db: D1Database,
  recapKey: string,
  outcome: TelegramRecapTerminalOutcome,
  atSec: number,
  reason?: string | null,
): Promise<boolean> {
  const target = await db.prepare(`
    SELECT recap_key, chat_id, local_date, window_end_at, status
      FROM telegram_recap_targets WHERE recap_key = ?
  `).bind(recapKey).first<TargetRow>();
  if (!target || (target.status !== "planned" && target.status !== "queued")) return false;
  const status: TelegramRecapTargetStatus = outcome === "accepted" ? "sent" : outcome;
  const targetUpdate = db.prepare(`
    UPDATE telegram_recap_targets
       SET status = ?, terminal_reason = COALESCE(?, terminal_reason),
           completed_at = ?, updated_at = ?
     WHERE recap_key = ? AND status IN ('planned', 'queued')
  `).bind(status, reason ?? null, atSec, atSec, recapKey);
  const preferenceUpdate = db.prepare(`
    UPDATE telegram_recap_preferences
       SET last_window_end_at = MAX(COALESCE(last_window_end_at, 0), ?),
           last_delivered_local_date = CASE WHEN ? IN ('sent', 'execution_unknown')
             THEN ? ELSE last_delivered_local_date END,
           updated_at = ?
     WHERE chat_id = ?
  `).bind(target.window_end_at, status, target.local_date, atSec, target.chat_id);
  await executeAtomicBatch(db, [targetUpdate, preferenceUpdate]);
  const updated = await db.prepare(
    "SELECT status FROM telegram_recap_targets WHERE recap_key = ?",
  ).bind(recapKey).first<{ status: TelegramRecapTargetStatus }>();
  return updated?.status === status;
}

export interface TelegramRecapRetentionResult {
  deletedTargets: number;
}

/** Delete only bounded recap audit rows; pending delivery retention remains owned by its queue. */
export async function pruneTelegramRecapTargets(
  db: D1Database,
  nowSec: number,
  options: { aggregateRetentionSec?: number; terminalRetentionSec?: number } = {},
): Promise<TelegramRecapRetentionResult> {
  const aggregateCutoff = nowSec - (options.aggregateRetentionSec ?? 30 * 86400);
  const terminalCutoff = nowSec - (options.terminalRetentionSec ?? 90 * 86400);
  const result = await db.prepare(`
    DELETE FROM telegram_recap_targets
     WHERE (status IN ('sent', 'skipped_no_changes', 'skipped_paused', 'skipped_stale')
            AND updated_at < ?)
        OR (status IN ('execution_unknown', 'failed_permanent') AND updated_at < ?)
  `).bind(aggregateCutoff, terminalCutoff).run();
  return { deletedTargets: Number(result.meta?.changes ?? 0) };
}

// Concise aliases make the store convenient to use from planner code and tests.
export const getRecapPreference = getTelegramRecapPreference;
export const setRecapPreference = setTelegramRecapPreference;
export const listDueRecapPreferences = listDueTelegramRecapPreferences;
export const queueRecapTarget = queueTelegramRecapTarget;
export const recordRecapSkip = recordTelegramRecapSkip;
export const projectRecapTerminalOutcome = projectTelegramRecapTerminalOutcome;
export const pruneRecapTargets = pruneTelegramRecapTargets;
export const recapDedupeKey = buildTelegramRecapDedupeKey;
