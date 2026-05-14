import type { ResolvedCoin } from "../lib/telegram-alerts";
import { batchExecute } from "../lib/db";
import type {
  ConfirmBulkPayload,
  ParsedSetCommand,
  PendingActionType,
  PresetSubscriptionRow,
  SubscriberRow,
  SubscriptionRow,
} from "./telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "./telegram-webhook-shared";
import { dedupeCoins } from "./telegram-webhook-parsing";

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

const TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC = 7 * 24 * 60 * 60;
const TELEGRAM_PROCESSING_STALE_SEC = 5 * 60;
const TELEGRAM_PROCESSED_UPDATE_PRUNE_INTERVAL_SEC = 6 * 60 * 60;

export const PENDING_OWNERSHIP_CONFLICT_MESSAGE =
  "Another user has a pending selection in this chat. Ask them to finish or /cancel it first.";

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
    .prepare("DELETE FROM telegram_processed_updates WHERE received_at < ?")
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

const ALERT_KEYS = ["dews", "depeg", "safety", "launch"] as const;
type AlertKey = (typeof ALERT_KEYS)[number];

/**
 * Upserts a telegram_subscribers row. Any field left undefined preserves
 * existing values on conflict and defaults to 0/NULL on initial insert.
 *
 * - `perCoinAlertBumps` / `globalAlertBumps` use MAX(...) so per-coin actions
 *   never downgrade a flag.
 * - `globalAlertOverrides` replaces the value (used by `/set all ... off`).
 * - `quietHours` replaces unconditionally.
 */
export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): Promise<void> {
  if (input.globalAlertBumps && input.globalAlertOverrides) {
    // SQLite applies the UPDATE SET clauses left-to-right, so combining both
    // would silently let the override win for any shared column. Forbid it so
    // future callers cannot accidentally rely on evaluation order.
    throw new Error(
      "upsertSubscriberRow: globalAlertBumps and globalAlertOverrides cannot be combined",
    );
  }

  const quietStart = input.quietHours?.enabled ? input.quietHours.startHourUtc : null;
  const quietEnd = input.quietHours?.enabled ? input.quietHours.endHourUtc : null;
  const quietEnabled = input.quietHours?.enabled ? 1 : 0;

  const updates: string[] = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
    "last_active_at = excluded.last_active_at",
  ];

  const perCoinRow = [0, 0, 0, 0];
  if (input.perCoinAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = input.perCoinAlertBumps[key];
      if (value != null) {
        updates.push(
          `alert_${key} = MAX(telegram_subscribers.alert_${key}, excluded.alert_${key})`,
        );
        perCoinRow[i] = value;
      }
    }
  }

  const globalRow = [0, 0, 0, 0];
  if (input.globalAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = input.globalAlertBumps[key];
      if (value != null) {
        updates.push(
          `global_alert_${key} = MAX(telegram_subscribers.global_alert_${key}, excluded.global_alert_${key})`,
        );
        globalRow[i] = value;
      }
    }
  }
  if (input.globalAlertOverrides) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key: AlertKey = ALERT_KEYS[i];
      const value = input.globalAlertOverrides[key];
      if (value != null) {
        updates.push(`global_alert_${key} = excluded.global_alert_${key}`);
        globalRow[i] = value;
      }
    }
  }

  if (input.quietHours != null) {
    updates.push(
      "quiet_hours_enabled = excluded.quiet_hours_enabled",
      "quiet_hours_start_utc = excluded.quiet_hours_start_utc",
      "quiet_hours_end_utc = excluded.quiet_hours_end_utc",
    );
  }

  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username,
        alert_dews, alert_depeg, alert_safety, alert_launch,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}
    `)
    .bind(
      input.chatId,
      input.username,
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
      input.nowSec,
      input.nowSec,
    )
    .run();
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

export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") || options?.depegWorseningBpsStep !== undefined ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const alertLaunch = alertTypes.has("launch") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  // The subscriber row cannot share a batch with subscriptions because the helper
  // uses a single .run(); run it first, then batch the subscriptions.
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps: {
      dews: alertDews,
      depeg: alertDepeg,
      safety: alertSafety,
      launch: alertLaunch,
    },
  });

  const statements: D1PreparedStatement[] = [];
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

export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  if (command.setting === "depeg-step") {
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
      .bind(command.step, now, chatId)
      .run();
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
 * UTC. Initial-insert defaults match `clearAlertSnooze` so they stay in sync.
 */
export async function setSubscriberTimezone(
  db: D1Database,
  chatId: string,
  username: string | null,
  timezone: string | null,
): Promise<void> {
  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username,
         alert_dews, alert_depeg, alert_safety, alert_launch,
         global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
         timezone,
         created_at, last_active_at
       )
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_subscribers.username),
         timezone = excluded.timezone,
         last_active_at = excluded.last_active_at`,
    )
    .bind(chatId, username, timezone, now, now)
    .run();
}

export async function clearAlertSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
): Promise<void> {
  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username,
         alert_dews, alert_depeg, alert_safety, alert_launch,
         global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
         alert_snooze_until_ts,
         created_at, last_active_at
       )
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_subscribers.username),
         alert_snooze_until_ts = NULL,
         last_active_at = excluded.last_active_at`,
    )
    .bind(chatId, username, now, now)
    .run();
}

export async function upsertPresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return;
  const now = unixNow();
  const statements = uniquePresetIds.map((presetId) => {
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
  await batchExecute(db, statements);
}

export async function removePresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
): Promise<void> {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return;
  const placeholders = uniquePresetIds.map(() => "?").join(", ");
  await db
    .prepare(`DELETE FROM telegram_preset_subscriptions WHERE chat_id = ? AND preset_id IN (${placeholders})`)
    .bind(chatId, ...uniquePresetIds)
    .run();
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

export async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return;

  const now = unixNow();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  await db.batch([
    db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...uniqueIds),
    db.prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?").bind(now, chatId),
  ]);
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
