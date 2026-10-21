import { unixNowSec as unixNow } from "@shared/lib/time-constants";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { executeAtomicBatch } from "../../lib/db";
import type { SubscriberRow } from "../webhook/telegram-webhook-shared";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "../delivery/operation-batch";

/** Re-exported under the worker-local name every Telegram store module already imports. */
export { unixNow };

export const PENDING_OWNERSHIP_CONFLICT_MESSAGE =
  "Another user has a pending selection in this chat. Ask them to finish or /cancel it first.";

function prepareEnsureSubscriberExists(
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

/** Prepend only to a validated enable transition, in its atomic domain batch.
 * Existing effective follows are not proof of a missing historical milestone.
 */
export function prepareTelegramFirstFollowStatements(
  db: D1Database,
  input: {
    chatId: string;
    username: string | null;
    feature: "direct" | "preset" | "global";
    nowSec: number;
    guard?: { sql: string; binds: unknown[] };
    ensureSubscriber?: boolean;
  },
): D1PreparedStatement[] {
  const eligible = `chat_id = ? AND first_follow_at IS NULL
    AND NOT (${TELEGRAM_ALERT_TYPES.map((type) => `global_alert_${type} = 1`).join(" OR ")})
    AND NOT EXISTS (SELECT 1 FROM telegram_subscriptions t WHERE t.chat_id = telegram_subscribers.chat_id
      AND (${TELEGRAM_ALERT_TYPES.map((type) => `t.alert_${type} = 1`).join(" OR ")}))
    AND NOT EXISTS (SELECT 1 FROM telegram_preset_subscriptions p WHERE p.chat_id = telegram_subscribers.chat_id
      AND (p.alert_dews = 1 OR p.alert_depeg = 1 OR p.alert_safety = 1))
    ${input.guard ? `AND (${input.guard.sql})` : ""}`;
  const binds = [input.chatId, ...(input.guard?.binds ?? [])];
  return [
    ...(input.ensureSubscriber === false ? [] : [prepareEnsureSubscriberExists(db, input.chatId, input.username, input.nowSec)]),
    db.prepare(`UPDATE telegram_subscribers SET first_follow_at = ? WHERE ${eligible}`)
      .bind(input.nowSec, ...binds),
  ];
}

interface SubscriberCommonInput {
  chatId: string;
  username: string | null;
  nowSec: number;
}

type AlertFlags = Partial<Record<(typeof TELEGRAM_ALERT_TYPES)[number], 0 | 1>>;

export type UpsertSubscriberInput = SubscriberCommonInput & {
  kind?: never;
  perCoinAlertBumps?: AlertFlags;
  quietHours?:
    | { enabled: true; startHourUtc: number; endHourUtc: number; preserveSavedWindow?: boolean }
    | { enabled: false };
  /** Increment in the same UPSERT as an intent mutation not inferable from the fields above. */
  bumpPreferenceGeneration?: boolean;
} & (
  | { globalAlertBumps?: AlertFlags; globalAlertOverrides?: never }
  | { globalAlertBumps?: never; globalAlertOverrides: AlertFlags }
);

// Canonical order — indexes here are positionally bound to the alert_*/
// global_alert_* columns in the upsert SQL below.
const ALERT_KEYS = TELEGRAM_ALERT_TYPES;
const SUBSCRIBER_ALERT_COLUMNS = [
  ...ALERT_KEYS.map((key) => `alert_${key}`),
  ...ALERT_KEYS.map((key) => `global_alert_${key}`),
].join(",\n         ");

type SubscriberMutationInput = UpsertSubscriberInput | (SubscriberCommonInput & {
  kind: "preference";
  /** `undefined` preserves the column; explicit `null` clears it. */
  timezone?: string | null;
  alertSnoozeUntilTs?: number | null;
});

/** One SQL boundary for alert intent and single-column subscriber preferences. */
export function buildSubscriberUpsert(
  kind: SubscriberMutationInput,
): { sql: string; binds: unknown[] } {
  const updates = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
    "last_active_at = excluded.last_active_at",
  ];
  if (kind.kind === "preference") {
    const setsTimezone = kind.timezone !== undefined;
    if (setsTimezone === (kind.alertSnoozeUntilTs !== undefined)) {
      throw new Error("buildSubscriberUpsert: exactly one of timezone or alertSnoozeUntilTs must be set");
    }
    const column = setsTimezone ? "timezone" : "alert_snooze_until_ts";
    updates.push(`${column} = excluded.${column}`);
    updates.push("preference_generation = telegram_subscribers.preference_generation + 1");
    return {
      sql: `INSERT INTO telegram_subscribers
        (chat_id, username, ${column}, created_at, last_active_at, preference_generation)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}`,
      binds: [kind.chatId, kind.username, setsTimezone ? kind.timezone : kind.alertSnoozeUntilTs, kind.nowSec, kind.nowSec],
    };
  }
  if (kind.globalAlertBumps && kind.globalAlertOverrides) {
    throw new Error("upsertSubscriberRow: globalAlertBumps and globalAlertOverrides cannot be combined");
  }
  const quietHours = kind.quietHours;
  const quietStart = quietHours?.enabled ? quietHours.startHourUtc : null;
  const quietEnd = quietHours?.enabled ? quietHours.endHourUtc : null;
  const quietEnabled = quietHours?.enabled ? 1 : 0;
  const bumpsPreferenceGeneration = kind.bumpPreferenceGeneration === true ||
    quietHours != null || kind.globalAlertOverrides != null ||
    kind.perCoinAlertBumps != null || kind.globalAlertBumps != null;
  if (bumpsPreferenceGeneration) {
    updates.push("preference_generation = telegram_subscribers.preference_generation + 1");
  }
  const perCoinRow: Array<0 | 1> = TELEGRAM_ALERT_TYPES.map(() => 0);
  if (!kind.globalAlertOverrides && kind.perCoinAlertBumps) {
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
  if (kind.globalAlertBumps) {
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
  if (kind.globalAlertOverrides) {
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
    updates.push("quiet_hours_enabled = excluded.quiet_hours_enabled");
    if (quietHours.enabled) {
      // Evaluate the saved window inside the UPSERT, not in a stale pre-toggle read.
      const validSavedWindow = `telegram_subscribers.quiet_hours_start_utc BETWEEN 0 AND 23
        AND telegram_subscribers.quiet_hours_end_utc BETWEEN 0 AND 23
        AND telegram_subscribers.quiet_hours_start_utc = CAST(telegram_subscribers.quiet_hours_start_utc AS INTEGER)
        AND telegram_subscribers.quiet_hours_end_utc = CAST(telegram_subscribers.quiet_hours_end_utc AS INTEGER)
        AND telegram_subscribers.quiet_hours_start_utc <> telegram_subscribers.quiet_hours_end_utc`;
      for (const column of ["quiet_hours_start_utc", "quiet_hours_end_utc"]) {
        updates.push(quietHours.preserveSavedWindow
          ? `${column} = CASE WHEN ${validSavedWindow} THEN telegram_subscribers.${column} ELSE excluded.${column} END`
          : `${column} = excluded.${column}`);
      }
    }
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
 * Upserts a telegram_subscribers row. Any field left undefined preserves
 * existing values on conflict and defaults to 0/NULL on initial insert.
 *
 * - `perCoinAlertBumps` / `globalAlertBumps` use MAX(...) so per-coin actions
 *   never downgrade a flag.
 * - `globalAlertOverrides` replaces the value (used by `/set all ... off`).
 * - `quietHours` changes enabled state; disabling retains the saved window.
 *   Enabling replaces hours unless `preserveSavedWindow` requests atomic valid-window fallback.
 */
export function prepareUpsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): D1PreparedStatement {
  const { sql, binds } = buildSubscriberUpsert(input);
  return db.prepare(sql).bind(...binds);
}

export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const enablesGlobal = Object.values(input.globalAlertOverrides ?? input.globalAlertBumps ?? {}).some((value) => value === 1);
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements([
      ...(enablesGlobal ? prepareTelegramFirstFollowStatements(db, {
        ...input, feature: "global",
      }) : []),
      prepareUpsertSubscriberRow(db, input),
    ], options),
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
         ${SUBSCRIBER_ALERT_COLUMNS},
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
  options: { operationStatements?: D1PreparedStatement[] } = {},
): Promise<void> {
  const nowSec = unixNow();
  const statements = [
    ...(TELEGRAM_ALERT_TYPES.some((type) => alertTypes.has(type))
      ? prepareTelegramFirstFollowStatements(db, { chatId, username, nowSec, feature: "global" })
      : []),
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec,
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
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}
