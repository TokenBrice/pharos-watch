import type { TelegramAlertType } from "@shared/types/status";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import { batchExecute } from "../lib/db";
import type {
  ConfirmBulkPayload,
  ParsedSetCommand,
  PendingActionType,
  PendingDisambiguationRow,
  PresetSubscriptionRow,
  SubscriberRow,
  SubscriptionRow,
} from "./telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "./telegram-webhook-shared";
import { dedupeCoins } from "./telegram-webhook-parsing";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_INTERVAL_SEC,
  TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC,
  TELEGRAM_PROCESSING_STALE_SEC,
} from "../lib/telegram-constants";

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export const PENDING_OWNERSHIP_CONFLICT_MESSAGE =
  "Another user has a pending selection in this chat. Ask them to finish or /cancel it first.";

const TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT = 5_000;

export type TelegramProcessedUpdateClaimStatus = "claimed" | "duplicate" | "in_flight";

export interface TelegramProcessedUpdateClaim {
  status: TelegramProcessedUpdateClaimStatus;
  retryAfterSec?: number;
}

interface ProcessedUpdateRow {
  status: string;
  received_at: number;
}

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

function d1ChangeCount(result: D1Result<unknown>): number {
  const changes = Number(result.meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
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
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO telegram_processed_updates (
         update_id,
         received_at,
         processed_at,
         update_type,
         chat_id,
         status,
         error_class
       )
       VALUES (?, ?, NULL, ?, ?, 'processing', NULL)`,
    )
    .bind(input.updateId, input.nowSec, input.updateType, input.chatId)
    .run();

  if (d1ChangeCount(insert) > 0) {
    return { status: "claimed" };
  }

  const existing = await db
    .prepare(
      "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
    )
    .bind(input.updateId)
    .first<ProcessedUpdateRow>();

  if (!existing) {
    return { status: "in_flight", retryAfterSec: staleSec };
  }

  if (existing.status === "processed") {
    return { status: "duplicate" };
  }

  if (existing.status === "processing" && existing.received_at > staleBefore) {
    return {
      status: "in_flight",
      retryAfterSec: Math.max(1, existing.received_at + staleSec - input.nowSec),
    };
  }

  const reclaim = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET received_at = ?,
              processed_at = NULL,
              update_type = COALESCE(?, update_type),
              chat_id = COALESCE(?, chat_id),
              status = 'processing',
              error_class = NULL
        WHERE update_id = ?
          AND (
            status = 'failed'
            OR (status = 'processing' AND received_at <= ?)
          )`,
    )
    .bind(input.nowSec, input.updateType, input.chatId, input.updateId, staleBefore)
    .run();

  if (d1ChangeCount(reclaim) > 0) {
    return { status: "claimed" };
  }

  return { status: "in_flight", retryAfterSec: staleSec };
}

export async function markTelegramProcessedUpdateProcessed(
  db: D1Database,
  input: { updateId: number; nowSec: number; errorClass?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'processed',
              processed_at = ?,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'`,
    )
    .bind(input.nowSec, input.errorClass ?? null, input.updateId)
    .run();
}

export async function markTelegramProcessedUpdateFailed(
  db: D1Database,
  input: { updateId: number; errorClass: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'failed',
              processed_at = NULL,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'`,
    )
    .bind(input.errorClass, input.updateId)
    .run();
}

export async function pruneTelegramProcessedUpdates(
  db: D1Database,
  input: { nowSec?: number; retentionSec?: number } = {},
): Promise<number> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const result = await db
    .prepare(
      `DELETE FROM telegram_processed_updates
        WHERE update_id IN (
          SELECT update_id
            FROM telegram_processed_updates
           WHERE received_at < ?
           ORDER BY received_at ASC, update_id ASC
           LIMIT ${TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT}
        )`,
    )
    .bind(nowSec - retentionSec)
    .run();
  return d1ChangeCount(result);
}

export async function maybePruneTelegramProcessedUpdates(
  db: D1Database,
  input: {
    nowSec?: number;
    retentionSec?: number;
    intervalSec?: number;
  } = {},
): Promise<number | null> {
  const nowSec = input.nowSec ?? unixNow();
  const intervalSec = input.intervalSec ?? TELEGRAM_PROCESSED_UPDATE_PRUNE_INTERVAL_SEC;
  const eligibleBefore = nowSec - intervalSec;
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES ('telegram:processed-updates:prune:last-run', '1', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE cache.updated_at <= ?`,
    )
    .bind(nowSec, eligibleBefore)
    .run();

  if (d1ChangeCount(result) <= 0) return null;
  return pruneTelegramProcessedUpdates(db, {
    nowSec,
    retentionSec: input.retentionSec,
  });
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

  const row = await db
    .prepare("SELECT updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ updated_at: number }>();
  const lastUsedAt = Number(row?.updated_at);
  const retryAfterSec = Number.isFinite(lastUsedAt)
    ? Math.max(1, input.cooldownSec - (input.nowSec - lastUsedAt))
    : input.cooldownSec;
  return { allowed: false, retryAfterSec };
}

export interface UpsertSubscriberInput {
  chatId: string;
  username: string | null;
  nowSec: number;
  perCoinAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertOverrides?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  quietHours?:
    | { enabled: true; startHourUtc: number; endHourUtc: number }
    | { enabled: false };
}

const ALERT_KEYS: readonly TelegramAlertType[] = ["dews", "depeg", "safety", "launch"];

/**
 * Discriminated normalization of every `telegram_subscribers` upsert. Each
 * variant maps to one mutually-exclusive mutation intent, so adding a future
 * flag in the wrong combination becomes a compile-time error inside this
 * module instead of a left-to-right SQL-evaluation footgun at runtime.
 */
type UpsertSubscriberKind =
  | {
      kind: "bump";
      chatId: string;
      username: string | null;
      nowSec: number;
      perCoinAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
      globalAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
      quietHours?:
        | { enabled: true; startHourUtc: number; endHourUtc: number }
        | { enabled: false };
    }
  | {
      kind: "override";
      chatId: string;
      username: string | null;
      nowSec: number;
      globalAlertOverrides: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
      quietHours?:
        | { enabled: true; startHourUtc: number; endHourUtc: number }
        | { enabled: false };
    }
  | {
      kind: "preference";
      chatId: string;
      username: string | null;
      nowSec: number;
      /** `undefined` = leave existing; explicit `null` = write SQL NULL. */
      timezone?: string | null;
      /** `undefined` = leave existing; explicit `null` = clear snooze. */
      alertSnoozeUntilTs?: number | null;
    };

/**
 * Build the SQL + binds for a single `telegram_subscribers` upsert. All five
 * subscriber-row UPSERT sites in this file route through this builder so that
 * the 15-column INSERT shape, the `created_at`/`last_active_at` defaults, and
 * the COALESCE(excluded.username, ...) preservation rule live in exactly one
 * place. Bind order is stable so the existing `binds[6] === 1` assertion in
 * `telegram-webhook-settings.test.ts` continues to hold for the bump/override
 * shapes.
 */
function buildSubscriberUpsert(
  kind: UpsertSubscriberKind,
): { sql: string; binds: unknown[] } {
  if (kind.kind === "preference") {
    return buildSubscriberPreferenceUpsert(kind);
  }

  const quietHours = kind.quietHours;
  const quietStart = quietHours?.enabled ? quietHours.startHourUtc : null;
  const quietEnd = quietHours?.enabled ? quietHours.endHourUtc : null;
  const quietEnabled = quietHours?.enabled ? 1 : 0;

  const updates: string[] = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
    "last_active_at = excluded.last_active_at",
  ];

  const perCoinRow: Array<0 | 1> = [0, 0, 0, 0];
  if (kind.kind === "bump" && kind.perCoinAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = kind.perCoinAlertBumps[key];
      if (value != null) {
        updates.push(
          `alert_${key} = MAX(telegram_subscribers.alert_${key}, excluded.alert_${key})`,
        );
        perCoinRow[i] = value;
      }
    }
  }

  const globalRow: Array<0 | 1> = [0, 0, 0, 0];
  if (kind.kind === "bump" && kind.globalAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = kind.globalAlertBumps[key];
      if (value != null) {
        updates.push(
          `global_alert_${key} = MAX(telegram_subscribers.global_alert_${key}, excluded.global_alert_${key})`,
        );
        globalRow[i] = value;
      }
    }
  }
  if (kind.kind === "override") {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = kind.globalAlertOverrides[key];
      if (value != null) {
        updates.push(`global_alert_${key} = excluded.global_alert_${key}`);
        globalRow[i] = value;
      }
    }
  }

  if (quietHours != null) {
    updates.push(
      "quiet_hours_enabled = excluded.quiet_hours_enabled",
      "quiet_hours_start_utc = excluded.quiet_hours_start_utc",
      "quiet_hours_end_utc = excluded.quiet_hours_end_utc",
    );
  }

  const sql = `
      INSERT INTO telegram_subscribers (
        chat_id, username,
        alert_dews, alert_depeg, alert_safety, alert_launch,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}
    `;
  const binds: unknown[] = [
    kind.chatId,
    kind.username,
    perCoinRow[0],
    perCoinRow[1],
    perCoinRow[2],
    perCoinRow[3],
    globalRow[0],
    globalRow[1],
    globalRow[2],
    globalRow[3],
    quietEnabled,
    quietStart,
    quietEnd,
    kind.nowSec,
    kind.nowSec,
  ];
  return { sql, binds };
}

/**
 * `preference` upserts touch a single optional column (`timezone` or
 * `alert_snooze_until_ts`) plus the always-written `username`/`last_active_at`
 * pair. All alert flag and quiet-hours columns get their schema defaults on
 * initial insert and are preserved (not mentioned in the SET clause) on
 * conflict.
 */
function buildSubscriberPreferenceUpsert(kind: Extract<
  UpsertSubscriberKind,
  { kind: "preference" }
>): { sql: string; binds: unknown[] } {
  const setsTimezone = kind.timezone !== undefined;
  const setsSnooze = kind.alertSnoozeUntilTs !== undefined;
  // Callers always set exactly one preference column today; if they need to
  // set both in the future, extend this builder rather than reintroducing a
  // hand-rolled INSERT.
  if (setsTimezone === setsSnooze) {
    throw new Error(
      "buildSubscriberPreferenceUpsert: exactly one of timezone or alertSnoozeUntilTs must be set",
    );
  }

  const updates: string[] = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
  ];
  if (setsTimezone) updates.push("timezone = excluded.timezone");
  if (setsSnooze) {
    // Distinguish between "set to NULL" and "set to a timestamp" so the
    // `historyHas("alert_snooze_until_ts = NULL", ...)` assertion in
    // `telegram-mini-app.test.ts:933` keeps matching the clearAlertSnooze path.
    updates.push(
      kind.alertSnoozeUntilTs === null
        ? "alert_snooze_until_ts = NULL"
        : "alert_snooze_until_ts = excluded.alert_snooze_until_ts",
    );
  }
  updates.push("last_active_at = excluded.last_active_at");

  const insertColumns = [
    "chat_id",
    "username",
    "alert_dews",
    "alert_depeg",
    "alert_safety",
    "alert_launch",
    "global_alert_dews",
    "global_alert_depeg",
    "global_alert_safety",
    "global_alert_launch",
    "quiet_hours_enabled",
    "quiet_hours_start_utc",
    "quiet_hours_end_utc",
  ];
  const insertValues = ["?", "?", "0", "0", "0", "0", "0", "0", "0", "0", "0", "NULL", "NULL"];
  const binds: unknown[] = [kind.chatId, kind.username];
  if (setsTimezone) {
    insertColumns.push("timezone");
    insertValues.push("?");
    binds.push(kind.timezone);
  }
  if (setsSnooze) {
    insertColumns.push("alert_snooze_until_ts");
    insertValues.push("?");
    binds.push(kind.alertSnoozeUntilTs);
  }
  insertColumns.push("created_at", "last_active_at");
  insertValues.push("?", "?");
  binds.push(kind.nowSec, kind.nowSec);

  const sql = `INSERT INTO telegram_subscribers (
         ${insertColumns.join(", ")}
       )
       VALUES (${insertValues.join(", ")})
       ON CONFLICT(chat_id) DO UPDATE SET
         ${updates.join(",\n         ")}`;
  return { sql, binds };
}

/**
 * Upserts a telegram_subscribers row. Any field left undefined preserves
 * existing values on conflict and defaults to 0/NULL on initial insert.
 *
 * - `perCoinAlertBumps` / `globalAlertBumps` use MAX(...) so per-coin actions
 *   never downgrade a flag.
 * - `globalAlertOverrides` replaces the value (used by `/set all ... off`).
 * - `quietHours` replaces unconditionally.
 */
export function prepareUpsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): D1PreparedStatement {
  if (input.globalAlertBumps && input.globalAlertOverrides) {
    // Defense-in-depth: the discriminated `UpsertSubscriberKind` makes this
    // unreachable for internal callers, but the wide external `UpsertSubscriberInput`
    // surface still admits it. SQLite applies UPDATE SET clauses left-to-right,
    // so combining both would silently let the override win for any shared
    // column. Forbid it so future external callers cannot rely on order.
    throw new Error(
      "upsertSubscriberRow: globalAlertBumps and globalAlertOverrides cannot be combined",
    );
  }

  const kind: UpsertSubscriberKind = input.globalAlertOverrides
    ? {
        kind: "override",
        chatId: input.chatId,
        username: input.username,
        nowSec: input.nowSec,
        globalAlertOverrides: input.globalAlertOverrides,
        quietHours: input.quietHours,
      }
    : {
        kind: "bump",
        chatId: input.chatId,
        username: input.username,
        nowSec: input.nowSec,
        perCoinAlertBumps: input.perCoinAlertBumps,
        globalAlertBumps: input.globalAlertBumps,
        quietHours: input.quietHours,
      };
  const { sql, binds } = buildSubscriberUpsert(kind);
  return db.prepare(sql).bind(...binds);
}

export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): Promise<void> {
  await prepareUpsertSubscriberRow(db, input).run();
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

export async function loadSubscriberByChat(
  db: D1Database,
  chatId: string,
): Promise<SubscriberRow | null> {
  return db
    .prepare(
      `SELECT
         alert_dews,
         alert_depeg,
         alert_safety,
         alert_launch,
         global_alert_dews,
         global_alert_depeg,
         global_alert_safety,
         global_alert_launch,
         global_depeg_worsening_bps_step,
         quiet_hours_enabled,
         quiet_hours_start_utc,
         quiet_hours_end_utc,
         timezone,
         alert_snooze_until_ts,
         consecutive_block_count,
         consecutive_block_first_at
       FROM telegram_subscribers
      WHERE chat_id = ?`,
    )
    .bind(chatId)
    .first<SubscriberRow>();
}

export async function upsertGlobalAlertTypes(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertBumps: {
      dews: alertTypes.has("dews") ? 1 : 0,
      depeg: alertTypes.has("depeg") ? 1 : 0,
      safety: alertTypes.has("safety") ? 1 : 0,
      launch: alertTypes.has("launch") ? 1 : 0,
    },
  });
}

export function prepareSubscriberAndSubscriptionStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") || options?.depegWorseningBpsStep !== undefined ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const alertLaunch = alertTypes.has("launch") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  const statements: D1PreparedStatement[] = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: {
        dews: alertDews,
        depeg: alertDepeg,
        safety: alertSafety,
        launch: alertLaunch,
      },
    }),
  ];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  for (const stablecoinId of uniqueStablecoinIds) {
    const depegStepUpdate =
      options?.depegWorseningBpsStep === undefined
        ? "depeg_worsening_bps_step = telegram_subscriptions.depeg_worsening_bps_step"
        : "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step";
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id,
          stablecoin_id,
          alert_dews,
          alert_depeg,
          alert_safety,
          alert_launch,
          depeg_worsening_bps_step
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_dews = MAX(telegram_subscriptions.alert_dews, excluded.alert_dews),
          alert_depeg = MAX(telegram_subscriptions.alert_depeg, excluded.alert_depeg),
          alert_safety = MAX(telegram_subscriptions.alert_safety, excluded.alert_safety),
          alert_launch = MAX(telegram_subscriptions.alert_launch, excluded.alert_launch),
          ${depegStepUpdate}
      `).bind(
        chatId,
        stablecoinId,
        alertDews,
        alertDepeg,
        alertSafety,
        alertLaunch,
        options?.depegWorseningBpsStep ?? null,
      ),
    );
  }
  return statements;
}

export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const statements = prepareSubscriberAndSubscriptionStatements(
    db,
    chatId,
    username,
    alertTypes,
    stablecoinIds,
    options,
  );
  if (statements.length > 0) await batchExecute(db, statements);
}

export async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const perCoinAlertBumps: UpsertSubscriberInput["perCoinAlertBumps"] = {};
  if (command.setting === "dews" && command.enabled) perCoinAlertBumps.dews = 1;
  if (command.setting === "depeg" && command.enabled) perCoinAlertBumps.depeg = 1;
  if (command.setting === "depeg-step") perCoinAlertBumps.depeg = 1;
  if (command.setting === "safety" && command.enabled) perCoinAlertBumps.safety = 1;
  if (command.setting === "launch" && command.enabled) perCoinAlertBumps.launch = 1;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps,
  });

  const statements: D1PreparedStatement[] = [];

  for (const coin of coins) {
    switch (command.setting) {
      case "dews":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band
            )
            VALUES (?, ?, ?, 0, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_dews = excluded.alert_dews,
              dews_min_band = excluded.dews_min_band
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.minBand),
        );
        break;
      case "safety":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, safety_mode
            )
            VALUES (?, ?, 0, 0, ?, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_safety = excluded.alert_safety,
              safety_mode = excluded.safety_mode
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.mode),
        );
        break;
      case "launch":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch
            )
            VALUES (?, ?, 0, 0, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_launch = excluded.alert_launch
          `).bind(chatId, coin.id, command.enabled ? 1 : 0),
        );
        break;
      case "depeg":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, ?, 0, NULL)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = excluded.alert_depeg,
              depeg_worsening_bps_step = CASE WHEN excluded.alert_depeg = 0 THEN NULL ELSE telegram_subscriptions.depeg_worsening_bps_step END
          `).bind(chatId, coin.id, command.enabled ? 1 : 0),
        );
        break;
      case "depeg-step":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, 1, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = 1,
              depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
          `).bind(chatId, coin.id, command.step),
        );
        break;
    }
  }

  if (statements.length > 0) await batchExecute(db, statements);
}

export function validateGlobalSetCommand(command: ParsedSetCommand): string | null {
  if (command.setting === "dews" && command.enabled && command.minBand != null) {
    return "Global DEWS alerts only support the default ALERT threshold. Use /subscribe dews all or /set all dews off; WARNING/DANGER remain per-coin.";
  }
  if (command.setting === "safety" && command.enabled && command.mode != null) {
    return "Global safety alerts support all/off only. Upgrade-only and downgrade-only remain per-coin settings.";
  }
  if (command.setting === "launch") {
    return null;
  }
  return null;
}

export async function setGlobalDepegWorseningStep(
  db: D1Database,
  chatId: string,
  username: string | null,
  step: 100 | 250 | 500 | null,
): Promise<void> {
  const now = unixNow();
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    globalAlertBumps: { depeg: 1 },
  });
  await db
    .prepare(
      `UPDATE telegram_subscribers
          SET global_depeg_worsening_bps_step = ?,
              last_active_at = ?
        WHERE chat_id = ?`,
    )
    .bind(step, now, chatId)
    .run();
}

export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  if (command.setting === "depeg-step") {
    await setGlobalDepegWorseningStep(db, chatId, username, command.step);
    return;
  }
  const override: 0 | 1 = command.enabled ? 1 : 0;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [command.setting]: override },
  });
}

/**
 * Replace the subscriber's IANA timezone (used to interpret quiet hours
 * locally). `timezone = null` clears any prior value, reverting the chat to
 * UTC. Routes through the single `buildSubscriberUpsert` builder so the
 * 15-column INSERT shape stays in lock-step with the rest of the file.
 */
export async function setSubscriberTimezone(
  db: D1Database,
  chatId: string,
  username: string | null,
  timezone: string | null,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    timezone,
  });
  await db.prepare(sql).bind(...binds).run();
}

/**
 * Apply a chat-wide alert snooze. Mirrors the inline SQL the snooze callback
 * (`telegram-webhook-callbacks.ts:367-385`) writes today; routed through the
 * store so the Mini App `set-snooze` mutation stays seam-compliant.
 */
export async function setSubscriberSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
  untilSec: number,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: untilSec,
  });
  await db.prepare(sql).bind(...binds).run();
}

/**
 * Apply a per-coin snooze (or clear it). Mirrors the inline SQL the
 * `coinsnooze:` callback (`telegram-webhook-callbacks.ts:434-449`) writes today.
 * Inserts a zero-flagged subscription row when none exists so the dispatcher
 * filter for `alert_snooze_until_ts` takes effect on global fan-out as well.
 */
export async function setSubscriptionSnooze(
  db: D1Database,
  chatId: string,
  stablecoinId: string,
  untilSec: number | null,
): Promise<void> {
  const now = unixNow();
  await db.batch([
    db
      .prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
           alert_snooze_until_ts
         )
         VALUES (?, ?, 0, 0, 0, 0, ?)
         ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
           alert_snooze_until_ts = excluded.alert_snooze_until_ts`,
      )
      .bind(chatId, stablecoinId, untilSec),
    db
      .prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?")
      .bind(now, chatId),
  ]);
}

/**
 * Atomically wipe every subscription, preset follow, and global-alert flag
 * for the chat. Mirrors the inline SQL the bulk-confirm `unsubscribeAll` path
 * (`telegram-webhook-callbacks.ts:1082-1106`) writes today.
 */
export async function unsubscribeAll(db: D1Database, chatId: string): Promise<void> {
  const now = unixNow();
  await db.batch([
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db
      .prepare(
        `UPDATE telegram_subscribers
            SET alert_dews = 0,
                alert_depeg = 0,
                alert_safety = 0,
                alert_launch = 0,
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                global_alert_launch = 0,
                global_depeg_worsening_bps_step = NULL,
                last_active_at = ?
          WHERE chat_id = ?`,
      )
      .bind(now, chatId),
  ]);
}

/**
 * Delete every row this subscriber owns across the Telegram tables. Retains
 * `telegram_processed_updates` so replay-ack idempotency survives a re-/start.
 */
export async function forgetSubscriber(db: D1Database, chatId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_alerts WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(chatId),
  ]);
}

const CHAT_MIGRATION_CACHE_KEY_BUILDERS = [
  (chatId: string) => `telegram:chat-admins:${chatId}`,
  (chatId: string) => `telegram:group-welcome:${chatId}`,
] as const;

function prepareChatMigrationCacheStatements(
  db: D1Database,
  oldChatId: string,
  newChatId: string,
): D1PreparedStatement[] {
  return CHAT_MIGRATION_CACHE_KEY_BUILDERS.flatMap((buildKey) => {
    const oldKey = buildKey(oldChatId);
    const newKey = buildKey(newChatId);
    return [
      db.prepare(`
        INSERT INTO cache (key, value, updated_at)
        SELECT ?, value, updated_at
          FROM cache
         WHERE key = ?
        ON CONFLICT(key) DO UPDATE SET
          value = CASE
            WHEN cache.updated_at <= excluded.updated_at THEN excluded.value
            ELSE cache.value
          END,
          updated_at = MAX(cache.updated_at, excluded.updated_at)
      `).bind(newKey, oldKey),
      db.prepare("DELETE FROM cache WHERE key = ?").bind(oldKey),
    ];
  });
}

/**
 * Per-column merge strategies used when copying a row from the old chat onto
 * an existing new-chat row. Adding a column to a tracked table means picking
 * a strategy here and listing it in `MIGRATION_TABLE_DESCRIPTORS` — no SQL
 * editing required for the common cases.
 */
type MergeStrategy =
  | "max"                // MAX(old, new)
  | "min"                // MIN(old, new)
  | "coalesce-old-first" // COALESCE(old, new) — preserve old non-NULL
  | "nullif-max-zero";   // NULLIF(MAX(COALESCE(old, 0), COALESCE(new, 0)), 0)

interface MigrationDescriptor {
  table: string;
  /** Copy columns in SELECT/INSERT order. `chat_id` is supplied by the bind. */
  copyColumns: readonly string[];
  /** Conflict resolution mode. `insert-or-ignore` skips the DO UPDATE block entirely. */
  mode:
    | { kind: "insert-or-ignore" }
    | {
        kind: "upsert";
        conflictColumns: readonly string[];
        merges: ReadonlyArray<{ column: string; strategy: MergeStrategy }>;
      };
}

const MIGRATION_TABLE_DESCRIPTORS: readonly MigrationDescriptor[] = [
  {
    table: "telegram_subscriptions",
    copyColumns: [
      "stablecoin_id",
      "alert_dews",
      "alert_depeg",
      "alert_safety",
      "alert_launch",
      "dews_min_band",
      "safety_mode",
      "depeg_worsening_bps_step",
      "alert_snooze_until_ts",
    ],
    mode: {
      kind: "upsert",
      conflictColumns: ["chat_id", "stablecoin_id"],
      merges: [
        { column: "alert_dews", strategy: "max" },
        { column: "alert_depeg", strategy: "max" },
        { column: "alert_safety", strategy: "max" },
        { column: "alert_launch", strategy: "max" },
        { column: "dews_min_band", strategy: "coalesce-old-first" },
        { column: "safety_mode", strategy: "coalesce-old-first" },
        { column: "depeg_worsening_bps_step", strategy: "coalesce-old-first" },
        { column: "alert_snooze_until_ts", strategy: "nullif-max-zero" },
      ],
    },
  },
  {
    table: "telegram_preset_subscriptions",
    copyColumns: [
      "preset_id",
      "alert_dews",
      "alert_depeg",
      "alert_safety",
      "depeg_worsening_bps_step",
      "created_at",
      "updated_at",
    ],
    mode: {
      kind: "upsert",
      conflictColumns: ["chat_id", "preset_id"],
      merges: [
        { column: "alert_dews", strategy: "max" },
        { column: "alert_depeg", strategy: "max" },
        { column: "alert_safety", strategy: "max" },
        { column: "depeg_worsening_bps_step", strategy: "coalesce-old-first" },
        { column: "created_at", strategy: "min" },
        { column: "updated_at", strategy: "max" },
      ],
    },
  },
  {
    table: "telegram_pending_disambiguation",
    copyColumns: [
      "alert_types",
      "resolved_ids",
      "ambiguous_ticker",
      "candidates",
      "remaining_tickers",
      "expires_at",
      "action_type",
      "action_payload",
      "initiator_user_id",
    ],
    mode: { kind: "insert-or-ignore" },
  },
  {
    table: "telegram_chat_delivery_diagnostics",
    copyColumns: [
      "last_successful_delivery_at",
      "last_successful_reply_at",
      "last_delivery_attempt_at",
      "recent_failure_class",
      "updated_at",
    ],
    mode: {
      kind: "upsert",
      conflictColumns: ["chat_id"],
      merges: [
        { column: "last_successful_delivery_at", strategy: "nullif-max-zero" },
        { column: "last_successful_reply_at", strategy: "nullif-max-zero" },
        { column: "last_delivery_attempt_at", strategy: "nullif-max-zero" },
        { column: "recent_failure_class", strategy: "coalesce-old-first" },
        { column: "updated_at", strategy: "max" },
      ],
    },
  },
];

function renderMergeExpr(table: string, column: string, strategy: MergeStrategy): string {
  switch (strategy) {
    case "max":
      return `MAX(${table}.${column}, excluded.${column})`;
    case "min":
      return `MIN(${table}.${column}, excluded.${column})`;
    case "coalesce-old-first":
      return `COALESCE(${table}.${column}, excluded.${column})`;
    case "nullif-max-zero":
      return `NULLIF(MAX(COALESCE(${table}.${column}, 0), COALESCE(excluded.${column}, 0)), 0)`;
  }
}

function buildMigrationStatement(
  db: D1Database,
  descriptor: MigrationDescriptor,
): D1PreparedStatement {
  const insertColumns = ["chat_id", ...descriptor.copyColumns].join(",\n        ");
  const selectColumns = ["?", ...descriptor.copyColumns].join(",\n        ");
  // SAFETY: `descriptor.table` and every column in `descriptor.copyColumns` /
  // `descriptor.mode.merges` / `descriptor.mode.conflictColumns` come from the
  // closed-set `MIGRATION_TABLE_DESCRIPTORS` constant defined just above. No
  // runtime data flows into the SQL string.
  const verb = descriptor.mode.kind === "insert-or-ignore" ? "INSERT OR IGNORE INTO" : "INSERT INTO";
  let sql = `${verb} ${descriptor.table} (\n        ${insertColumns}\n      )\n      SELECT\n        ${selectColumns}\n      FROM ${descriptor.table}\n      WHERE chat_id = ?`;
  if (descriptor.mode.kind === "upsert") {
    const conflict = descriptor.mode.conflictColumns.join(", ");
    const setClause = descriptor.mode.merges
      .map((m) => `${m.column} = ${renderMergeExpr(descriptor.table, m.column, m.strategy)}`)
      .join(",\n        ");
    sql += `\n      ON CONFLICT(${conflict}) DO UPDATE SET\n        ${setClause}`;
  }
  return db.prepare(sql);
}

/**
 * Merge Telegram group state after Telegram upgrades a group to a supergroup.
 * Telegram emits both `migrate_to_chat_id` and `migrate_from_chat_id` service
 * messages; this helper is idempotent so either event can safely run first.
 *
 * The `telegram_subscribers` block is intentionally kept inline: it has three
 * outlier merge expressions (`quiet_hours_start_utc`/`quiet_hours_end_utc`
 * jointly track `quiet_hours_enabled`, and `consecutive_block_first_at` uses
 * a MIN-with-NULL CASE) that don't fit the per-column strategy framework. The
 * other four tables flow through `MIGRATION_TABLE_DESCRIPTORS` so adding a
 * column there is a one-line descriptor change.
 */
export async function migrateTelegramChatId(
  db: D1Database,
  oldChatId: string,
  newChatId: string,
): Promise<void> {
  if (!oldChatId || !newChatId || oldChatId === newChatId) return;

  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        alert_launch,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        global_alert_launch,
        quiet_hours_enabled,
        quiet_hours_start_utc,
        quiet_hours_end_utc,
        global_depeg_worsening_bps_step,
        timezone,
        alert_snooze_until_ts,
        consecutive_block_count,
        consecutive_block_first_at,
        created_at,
        last_active_at
      )
      SELECT
        ?,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        alert_launch,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        global_alert_launch,
        quiet_hours_enabled,
        quiet_hours_start_utc,
        quiet_hours_end_utc,
        global_depeg_worsening_bps_step,
        timezone,
        alert_snooze_until_ts,
        consecutive_block_count,
        consecutive_block_first_at,
        created_at,
        last_active_at
      FROM telegram_subscribers
      WHERE chat_id = ?
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(telegram_subscribers.username, excluded.username),
        alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_subscribers.alert_safety, excluded.alert_safety),
        alert_launch = MAX(telegram_subscribers.alert_launch, excluded.alert_launch),
        global_alert_dews = MAX(telegram_subscribers.global_alert_dews, excluded.global_alert_dews),
        global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg),
        global_alert_safety = MAX(telegram_subscribers.global_alert_safety, excluded.global_alert_safety),
        global_alert_launch = MAX(telegram_subscribers.global_alert_launch, excluded.global_alert_launch),
        quiet_hours_enabled = MAX(telegram_subscribers.quiet_hours_enabled, excluded.quiet_hours_enabled),
        quiet_hours_start_utc = CASE
          WHEN telegram_subscribers.quiet_hours_enabled = 1 THEN telegram_subscribers.quiet_hours_start_utc
          WHEN excluded.quiet_hours_enabled = 1 THEN excluded.quiet_hours_start_utc
          ELSE COALESCE(telegram_subscribers.quiet_hours_start_utc, excluded.quiet_hours_start_utc)
        END,
        quiet_hours_end_utc = CASE
          WHEN telegram_subscribers.quiet_hours_enabled = 1 THEN telegram_subscribers.quiet_hours_end_utc
          WHEN excluded.quiet_hours_enabled = 1 THEN excluded.quiet_hours_end_utc
          ELSE COALESCE(telegram_subscribers.quiet_hours_end_utc, excluded.quiet_hours_end_utc)
        END,
        global_depeg_worsening_bps_step = COALESCE(
          telegram_subscribers.global_depeg_worsening_bps_step,
          excluded.global_depeg_worsening_bps_step
        ),
        timezone = COALESCE(telegram_subscribers.timezone, excluded.timezone),
        alert_snooze_until_ts = NULLIF(
          MAX(
            COALESCE(telegram_subscribers.alert_snooze_until_ts, 0),
            COALESCE(excluded.alert_snooze_until_ts, 0)
          ),
          0
        ),
        consecutive_block_count = MAX(
          COALESCE(telegram_subscribers.consecutive_block_count, 0),
          COALESCE(excluded.consecutive_block_count, 0)
        ),
        consecutive_block_first_at = CASE
          WHEN telegram_subscribers.consecutive_block_first_at IS NULL THEN excluded.consecutive_block_first_at
          WHEN excluded.consecutive_block_first_at IS NULL THEN telegram_subscribers.consecutive_block_first_at
          ELSE MIN(telegram_subscribers.consecutive_block_first_at, excluded.consecutive_block_first_at)
        END,
        created_at = MIN(telegram_subscribers.created_at, excluded.created_at),
        last_active_at = MAX(telegram_subscribers.last_active_at, excluded.last_active_at)
    `).bind(newChatId, oldChatId),
    ...MIGRATION_TABLE_DESCRIPTORS.map((descriptor) =>
      buildMigrationStatement(db, descriptor).bind(newChatId, oldChatId),
    ),
    db.prepare("UPDATE telegram_pending_alerts SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE telegram_alert_job_targets SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE telegram_alert_dead_letters SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE telegram_processed_updates SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(oldChatId),
    ...prepareChatMigrationCacheStatements(db, oldChatId, newChatId),
  ];

  await batchExecute(db, statements);
}

export async function clearAlertSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: null,
  });
  await db.prepare(sql).bind(...binds).run();
}

function preparePresetSubscriptionStatements(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return [];
  const now = unixNow();
  return uniquePresetIds.map((presetId) => {
    const depegStepUpdate =
      options?.depegWorseningBpsStep === undefined
        ? "depeg_worsening_bps_step = telegram_preset_subscriptions.depeg_worsening_bps_step"
        : "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step";
    return db.prepare(`
      INSERT INTO telegram_preset_subscriptions (
        chat_id,
        preset_id,
        alert_dews,
        alert_depeg,
        alert_safety,
        depeg_worsening_bps_step,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, preset_id) DO UPDATE SET
        alert_dews = MAX(telegram_preset_subscriptions.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_preset_subscriptions.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_preset_subscriptions.alert_safety, excluded.alert_safety),
        ${depegStepUpdate},
        updated_at = excluded.updated_at
    `).bind(
      chatId,
      presetId,
      alertTypes.has("dews") ? 1 : 0,
      alertTypes.has("depeg") || options?.depegWorseningBpsStep !== undefined ? 1 : 0,
      alertTypes.has("safety") ? 1 : 0,
      options?.depegWorseningBpsStep ?? null,
      now,
      now,
    );
  });
}

export async function upsertPresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const statements = preparePresetSubscriptionStatements(db, chatId, presetIds, alertTypes, options);
  if (statements.length === 0) return;
  await batchExecute(db, statements);
}

export function prepareSubscriberAndPresetStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  presetIds: readonly string[],
  stablecoinIds: string[],
  alertTypes: Set<string>,
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  return [
    ...prepareSubscriberAndSubscriptionStatements(db, chatId, username, alertTypes, stablecoinIds, options),
    ...preparePresetSubscriptionStatements(db, chatId, presetIds, alertTypes, options),
  ];
}

export function prepareRemovePresetSubscriptionStatements(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
): D1PreparedStatement[] {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return [];
  const placeholders = uniquePresetIds.map(() => "?").join(", ");
  return [
    db.prepare(`DELETE FROM telegram_preset_subscriptions WHERE chat_id = ? AND preset_id IN (${placeholders})`)
      .bind(chatId, ...uniquePresetIds),
  ];
}

export async function removePresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
): Promise<void> {
  const statements = prepareRemovePresetSubscriptionStatements(db, chatId, presetIds);
  if (statements.length === 0) return;
  await statements[0].run();
}

export async function loadPresetSubscriptions(
  db: D1Database,
  chatId: string,
): Promise<PresetSubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
         FROM telegram_preset_subscriptions
        WHERE chat_id = ?
        ORDER BY preset_id`,
    )
    .bind(chatId)
    .all<PresetSubscriptionRow>();
  return result.results ?? [];
}

export function prepareRemoveSubscriptionStatements(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): D1PreparedStatement[] {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];

  const now = unixNow();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return [
    db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...uniqueIds),
    db.prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?").bind(now, chatId),
  ];
}

export async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<void> {
  const statements = prepareRemoveSubscriptionStatements(db, chatId, stablecoinIds);
  if (statements.length === 0) return;
  await db.batch(statements);
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

export async function loadSubscriptionsByIds(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<SubscriptionRow[]> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}
