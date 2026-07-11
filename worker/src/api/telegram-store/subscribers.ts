import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { executeAtomicBatch } from "../../lib/db";
import type { SubscriberRow } from "../telegram-webhook-shared";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "./_internals";

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export const PENDING_OWNERSHIP_CONFLICT_MESSAGE =
  "Another user has a pending selection in this chat. Ask them to finish or /cancel it first.";

export function prepareEnsureSubscriberExists(
  db: D1Database,
  chatId: string,
  username: string | null,
  nowSec: number = unixNow(),
): D1PreparedStatement {
  return db.prepare(`
    INSERT OR IGNORE INTO telegram_subscribers (
      chat_id, username, created_at, last_active_at
    ) VALUES (?, ?, ?, ?)
  `).bind(chatId, username, nowSec, nowSec);
}

export interface UpsertSubscriberInput {
  chatId: string;
  username: string | null;
  nowSec: number;
  perCoinAlertBumps?: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
  globalAlertBumps?: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
  globalAlertOverrides?: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
  quietHours?:
    | { enabled: true; startHourUtc: number; endHourUtc: number }
    | { enabled: false };
  /** Increment in the same UPSERT as an intent mutation not inferable from the fields above. */
  bumpPreferenceGeneration?: boolean;
}

// Canonical order — indexes here are positionally bound to the alert_*/
// global_alert_* columns in the upsert SQL below.
const ALERT_KEYS = TELEGRAM_ALERT_TYPES;

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
      perCoinAlertBumps?: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
      globalAlertBumps?: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
      quietHours?:
        | { enabled: true; startHourUtc: number; endHourUtc: number }
        | { enabled: false };
      bumpPreferenceGeneration?: boolean;
    }
  | {
      kind: "override";
      chatId: string;
      username: string | null;
      nowSec: number;
      globalAlertOverrides: Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;
      quietHours?:
        | { enabled: true; startHourUtc: number; endHourUtc: number }
        | { enabled: false };
      bumpPreferenceGeneration?: boolean;
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
      bumpPreferenceGeneration?: boolean;
    };

/**
 * Build the SQL + binds for a single `telegram_subscribers` upsert. All five
 * subscriber-row UPSERT sites in this file route through this builder so that
 * the alert/default INSERT shape, the `created_at`/`last_active_at` defaults,
 * and the COALESCE(excluded.username, ...) preservation rule live in exactly
 * one place. Bind order is stable so the existing `binds[6] === 1` assertion
 * in `telegram-webhook-settings.test.ts` continues to hold for the bump/override
 * shapes.
 */
export function buildSubscriberUpsert(
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
  const bumpsPreferenceGeneration = kind.bumpPreferenceGeneration === true ||
    kind.quietHours != null ||
    (kind.kind === "bump" && (
      kind.perCoinAlertBumps != null || kind.globalAlertBumps != null
    )) ||
    kind.kind === "override";
  if (bumpsPreferenceGeneration) {
    updates.push("preference_generation = telegram_subscribers.preference_generation + 1");
  }

  const perCoinRow: Array<0 | 1> = TELEGRAM_ALERT_TYPES.map(() => 0);
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

  const globalRow: Array<0 | 1> = TELEGRAM_ALERT_TYPES.map(() => 0);
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
        alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        created_at, last_active_at, preference_generation
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}
    `;
  const binds: unknown[] = [
    kind.chatId,
    kind.username,
    ...perCoinRow,
    ...globalRow,
    quietEnabled,
    quietStart,
    quietEnd,
    kind.nowSec,
    kind.nowSec,
    bumpsPreferenceGeneration ? 1 : 0,
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
  updates.push("preference_generation = telegram_subscribers.preference_generation + 1");

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
  insertColumns.push("created_at", "last_active_at", "preference_generation");
  insertValues.push("?", "?", "1");
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
        bumpPreferenceGeneration: input.bumpPreferenceGeneration,
      }
    : {
        kind: "bump",
        chatId: input.chatId,
        username: input.username,
        nowSec: input.nowSec,
        perCoinAlertBumps: input.perCoinAlertBumps,
        globalAlertBumps: input.globalAlertBumps,
        quietHours: input.quietHours,
        bumpPreferenceGeneration: input.bumpPreferenceGeneration,
      };
  const { sql, binds } = buildSubscriberUpsert(kind);
  return db.prepare(sql).bind(...binds);
}

export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements([prepareUpsertSubscriberRow(db, input)], options),
  );
}

export function preparePreferenceGenerationBump(
  db: D1Database,
  chatId: string,
  nowSec: number = unixNow(),
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE telegram_subscribers
          SET preference_generation = preference_generation + 1,
              last_active_at = ?
        WHERE chat_id = ?`,
    )
    .bind(nowSec, chatId);
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
         alert_reserve,
         global_alert_dews,
         global_alert_depeg,
         global_alert_safety,
         global_alert_launch,
         global_alert_reserve,
         global_depeg_worsening_bps_step,
         quiet_hours_enabled,
         quiet_hours_start_utc,
         quiet_hours_end_utc,
         timezone,
         alert_snooze_until_ts,
         preference_generation,
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
  options: { clearPending?: boolean; operationStatements?: D1PreparedStatement[] } = {},
): Promise<void> {
  const statements = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: unixNow(),
      globalAlertBumps: {
        dews: alertTypes.has("dews") ? 1 : 0,
        depeg: alertTypes.has("depeg") ? 1 : 0,
        safety: alertTypes.has("safety") ? 1 : 0,
        launch: alertTypes.has("launch") ? 1 : 0,
        reserve: alertTypes.has("reserve") ? 1 : 0,
        freeze: alertTypes.has("freeze") ? 1 : 0,
      },
    }),
  ];
  if (options.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}
