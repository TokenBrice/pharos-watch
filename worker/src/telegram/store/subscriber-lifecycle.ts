import { executeAtomicBatch } from "../../lib/db";
import { unixNowSec as unixNow } from "@shared/lib/time-constants";
import { TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX } from "../common/constants";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "../delivery/operation-batch";

/**
 * Atomically wipe every subscription, preset follow, and global-alert flag
 * for the chat. Mirrors the inline SQL the bulk-confirm `unsubscribeAll` path
 * (`telegram-webhook-callbacks.ts:1082-1106`) writes today.
 */
export async function unsubscribeAll(
  db: D1Database,
  chatId: string,
  options: { operationStatements?: D1PreparedStatement[] } = {},
): Promise<void> {
  const now = unixNow();
  const statements = [
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db
      .prepare(
        `UPDATE telegram_subscribers
            SET alert_dews = 0,
                alert_depeg = 0,
                alert_safety = 0,
                alert_launch = 0,
                alert_reserve = 0,
                alert_freeze = 0,
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                global_alert_launch = 0,
                global_alert_reserve = 0,
                global_alert_freeze = 0,
                global_depeg_worsening_bps_step = NULL,
                alert_snooze_until_ts = NULL,
                preference_generation = preference_generation + 1,
                last_active_at = ?
          WHERE chat_id = ?`,
      )
      .bind(now, chatId),
  ];
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}

/** Shared by candidate selection and every statement in the conditional purge. */
export const INACTIVE_TELEGRAM_SUBSCRIBER_ELIGIBILITY_SQL = `
  s.last_active_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM telegram_subscriptions sub WHERE sub.chat_id = s.chat_id
      AND (sub.alert_dews <> 0 OR sub.alert_depeg <> 0 OR sub.alert_safety <> 0
        OR sub.alert_launch <> 0 OR sub.alert_reserve <> 0 OR sub.alert_freeze <> 0
        OR sub.alert_dews_override <> 0 OR sub.alert_depeg_override <> 0
        OR sub.alert_safety_override <> 0 OR sub.alert_launch_override <> 0
        OR sub.alert_reserve_override <> 0 OR sub.alert_freeze_override <> 0
        OR sub.dews_min_band IS NOT NULL OR sub.safety_mode IS NOT NULL
        OR sub.depeg_worsening_bps_step IS NOT NULL OR sub.alert_snooze_until_ts IS NOT NULL)
  )
  AND NOT EXISTS (SELECT 1 FROM telegram_preset_subscriptions ps WHERE ps.chat_id = s.chat_id)
  AND NOT EXISTS (
    SELECT 1 FROM telegram_deliveries td
     WHERE td.chat_id = s.chat_id AND td.state IN ('pending', 'retry', 'sending')
  )
  AND s.global_alert_dews = 0 AND s.global_alert_depeg = 0 AND s.global_alert_safety = 0
  AND s.global_alert_launch = 0 AND s.global_alert_reserve = 0 AND s.global_alert_freeze = 0
`;

/** Unlike /forget, housekeeping may delete only a profile that is still empty and inactive. */
export async function purgeInactiveTelegramSubscriber(
  db: D1Database,
  chatId: string,
  cutoffSec: number,
): Promise<boolean> {
  const results = await executeAtomicBatch(
    db,
    prepareSubscriberPurge(db, chatId, {
      sql: `EXISTS (SELECT 1 FROM telegram_subscribers s
                     WHERE s.chat_id = ? AND ${INACTIVE_TELEGRAM_SUBSCRIBER_ELIGIBILITY_SQL})`,
      binds: [chatId, cutoffSec],
    }),
    { returnResults: true },
  );
  return Number(results[results.length - 1]?.meta?.changes ?? 0) === 1;
}

/**
 * Delete every row this subscriber owns across the Telegram tables. Retains
 * `telegram_processed_updates` so replay-ack idempotency survives a re-/start.
 * Anonymous Mini App admission is independent of the profile and expires at
 * its original <=30-second deadline; legacy raw-chat burst keys are erased.
 */
export async function forgetSubscriber(
  db: D1Database,
  chatId: string,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  await executeAtomicBatch(db, appendTelegramOperationStatements(prepareSubscriberPurge(db, chatId), options));
}

function prepareSubscriberPurge(
  db: D1Database,
  chatId: string,
  guard?: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  const prepare = (sql: string, ...binds: unknown[]) =>
    db.prepare(`${sql}${guard ? ` AND ${guard.sql}` : ""}`).bind(...binds, ...(guard?.binds ?? []));
  return [
    prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?", chatId),
    prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?", chatId),
    // Roll-up jobs are per chat. Delete them by delivery ownership first (this
    // also catches jobs created under a group's pre-migration chat id), then by
    // the `rollup:<date>:<chatId>` id for jobs whose rows are already gone.
    prepare(
      `DELETE FROM telegram_jobs
        WHERE kind = 'rollup'
          AND job_id IN (SELECT job_id FROM telegram_deliveries WHERE chat_id = ?)`,
      chatId,
    ),
    prepare("DELETE FROM telegram_deliveries WHERE chat_id = ?", chatId),
    prepare(
      "DELETE FROM telegram_jobs WHERE kind = 'rollup' AND substr(job_id, -length(?) - 1) = ':' || ?",
      chatId, chatId,
    ),
    // Fan-out cursors are the last chat id written. Rewind one that names this
    // chat to the previous subscriber: every chat up to it was already written
    // (replayed rows are ignored by the unique key), so resume stays correct.
    prepare(
      `UPDATE telegram_jobs
          SET cursor = COALESCE((SELECT MAX(chat_id) FROM telegram_subscribers WHERE chat_id < ?), '')
        WHERE state = 'planning' AND cursor = ?`,
      chatId, chatId,
    ),
    // A broadcast job remembers its canary chat; scrub it from the shared payload.
    prepare(
      `UPDATE telegram_jobs SET payload_json = json_remove(payload_json, '$.excludeChatId')
        WHERE kind = 'broadcast' AND json_extract(payload_json, '$.excludeChatId') = ?`,
      chatId,
    ),
    prepare("DELETE FROM telegram_change_log WHERE chat_id = ?", chatId),
    prepare("DELETE FROM telegram_rollup_state WHERE chat_id = ?", chatId),
    prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?", chatId),
    ...prepareDeleteTelegramChatCacheStatements(db, chatId, guard),
    // Keep the eligibility authority alive until all guarded child deletes finish.
    prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?", chatId),
  ];
}

const CHAT_CACHE_EXACT_KEY_BUILDERS = [
  (chatId: string) => `${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}${chatId}`,
  (chatId: string) => `telegram:command-flood:${chatId}`,
  (chatId: string) => `telegram:re-engagement-warned:${chatId}`,
  (chatId: string) => `telegram:chat-admins:${chatId}`,
  (chatId: string) => `telegram:group-welcome:${chatId}`,
  // Retired adoption and inline-mode writers; residue ages out via retention cleanup.
  (chatId: string) => `telegram:adoption-mini-app-session:${chatId}`,
  (chatId: string) => `telegram:command-flood:inline:${chatId}`,
  // Legacy raw-chat keys only; active admission now uses anonymous epoch keys.
  (chatId: string) => `telegram:mini-app-mutation-burst:${chatId}`,
] as const;

const CHAT_CACHE_PREFIX_BUILDERS = [
  (chatId: string) => `telegram:command-flood:${chatId}:`,
  // Includes the Mini App `mini-app:session` and `mini-app:stale:*` keys.
  (chatId: string) => `telegram:command-cooldown:${chatId}:`,
  (chatId: string) => `telegram:command-cooldown:inline:${chatId}:`,
  (chatId: string) => `telegram:chat-member:${chatId}:`,
] as const;

export function prepareDeleteTelegramChatCacheStatements(
  db: D1Database,
  chatId: string,
  guard?: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  return [
    ...CHAT_CACHE_EXACT_KEY_BUILDERS.map((buildKey) =>
      db.prepare(`DELETE FROM cache WHERE key = ?${guard ? ` AND ${guard.sql}` : ""}`)
        .bind(buildKey(chatId), ...(guard?.binds ?? [])),
    ),
    ...CHAT_CACHE_PREFIX_BUILDERS.map((buildPrefix) =>
      db.prepare(`DELETE FROM cache WHERE key LIKE ?${guard ? ` AND ${guard.sql}` : ""}`)
        .bind(`${buildPrefix(chatId)}%`, ...(guard?.binds ?? [])),
    ),
  ];
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
  return [
    db.prepare(`
      INSERT INTO cache (key, value, updated_at)
      SELECT ?, value, updated_at FROM cache WHERE key = ?
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT),
        updated_at = MAX(cache.updated_at, excluded.updated_at)
    `).bind(`${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}${newChatId}`, `${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}${oldChatId}`),
    db.prepare("DELETE FROM cache WHERE key = ?").bind(`${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}${oldChatId}`),
    ...CHAT_MIGRATION_CACHE_KEY_BUILDERS.flatMap((buildKey) => {
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
    }),
  ];
}

/** One ordered column list owns insert values and conflict assignments. */
type MergeStrategy =
  | "copy-only"
  | "max"
  | "min"
  | "coalesce-old-first"
  | "nullif-max-zero"
  | "null-safe-min"
  | { sql: string };

interface MigrationDescriptor {
  table: string;
  columns: ReadonlyArray<{ column: string; select?: string; strategy: MergeStrategy }>;
  /** Identity columns still declare copy-only. */
  conflictColumns: readonly string[];
}

const MIGRATION_TABLE_DESCRIPTORS: readonly MigrationDescriptor[] = [
  {
    table: "telegram_subscribers",
    conflictColumns: ["chat_id"],
    columns: [
      { column: "chat_id", select: "?", strategy: "copy-only" },
      { column: "username", strategy: "coalesce-old-first" },
      { column: "alert_dews", strategy: "max" },
      { column: "alert_depeg", strategy: "max" },
      { column: "alert_safety", strategy: "max" },
      { column: "alert_launch", strategy: "max" },
      { column: "alert_reserve", strategy: "max" },
      { column: "alert_freeze", strategy: "max" },
      { column: "watcher_active", strategy: "max" },
      { column: "watcher_ever_active", strategy: "max" },
      { column: "global_alert_dews", strategy: "max" },
      { column: "global_alert_depeg", strategy: "max" },
      { column: "global_alert_safety", strategy: "max" },
      { column: "global_alert_launch", strategy: "max" },
      { column: "global_alert_reserve", strategy: "max" },
      { column: "global_alert_freeze", strategy: "max" },
      { column: "quiet_hours_enabled", strategy: "max" },
      // Keep the enabled row's paired window; the destination wins if both enable it.
      { column: "quiet_hours_start_utc", strategy: { sql: `CASE
          WHEN telegram_subscribers.quiet_hours_enabled = 1 THEN telegram_subscribers.quiet_hours_start_utc
          WHEN excluded.quiet_hours_enabled = 1 THEN excluded.quiet_hours_start_utc
          ELSE COALESCE(telegram_subscribers.quiet_hours_start_utc, excluded.quiet_hours_start_utc)
        END` } },
      { column: "quiet_hours_end_utc", strategy: { sql: `CASE
          WHEN telegram_subscribers.quiet_hours_enabled = 1 THEN telegram_subscribers.quiet_hours_end_utc
          WHEN excluded.quiet_hours_enabled = 1 THEN excluded.quiet_hours_end_utc
          ELSE COALESCE(telegram_subscribers.quiet_hours_end_utc, excluded.quiet_hours_end_utc)
        END` } },
      { column: "global_depeg_worsening_bps_step", strategy: "coalesce-old-first" },
      { column: "timezone", strategy: "coalesce-old-first" },
      { column: "alert_snooze_until_ts", strategy: "nullif-max-zero" },
      { column: "consecutive_block_count", strategy: {
        sql: "MAX(COALESCE(telegram_subscribers.consecutive_block_count, 0), COALESCE(excluded.consecutive_block_count, 0))",
      } },
      { column: "consecutive_block_first_at", strategy: "null-safe-min" },
      { column: "created_at", strategy: "min" },
      { column: "last_active_at", strategy: "max" },
      // excluded already includes the SELECT increment; retain the second conflict increment.
      { column: "preference_generation", select: "preference_generation + 1", strategy: {
        sql: "MAX(telegram_subscribers.preference_generation, excluded.preference_generation) + 1",
      } },
      { column: "first_follow_at", strategy: "null-safe-min" },
      { column: "first_setup_completed_at", strategy: "null-safe-min" },
    ],
  },
  {
    table: "telegram_subscriptions",
    conflictColumns: ["chat_id", "stablecoin_id"],
    columns: [
      { column: "chat_id", select: "?", strategy: "copy-only" },
      { column: "stablecoin_id", strategy: "copy-only" },
      { column: "alert_dews", strategy: "max" },
      { column: "alert_depeg", strategy: "max" },
      { column: "alert_safety", strategy: "max" },
      { column: "alert_launch", strategy: "max" },
      { column: "alert_reserve", strategy: "max" },
      { column: "alert_freeze", strategy: "max" },
      // Preserve explicit intent from either row alongside the matching alert flags.
      { column: "alert_dews_override", strategy: "max" },
      { column: "alert_depeg_override", strategy: "max" },
      { column: "alert_safety_override", strategy: "max" },
      { column: "alert_launch_override", strategy: "max" },
      { column: "alert_reserve_override", strategy: "max" },
      { column: "alert_freeze_override", strategy: "max" },
      { column: "dews_min_band", strategy: "coalesce-old-first" },
      { column: "safety_mode", strategy: "coalesce-old-first" },
      { column: "depeg_worsening_bps_step", strategy: "coalesce-old-first" },
      { column: "alert_snooze_until_ts", strategy: "nullif-max-zero" },
    ],
  },
  {
    table: "telegram_preset_subscriptions",
    conflictColumns: ["chat_id", "preset_id"],
    columns: [
      { column: "chat_id", select: "?", strategy: "copy-only" },
      { column: "preset_id", strategy: "copy-only" },
      { column: "alert_dews", strategy: "max" },
      { column: "alert_depeg", strategy: "max" },
      { column: "alert_safety", strategy: "max" },
      { column: "depeg_worsening_bps_step", strategy: "coalesce-old-first" },
      { column: "created_at", strategy: "min" },
      { column: "updated_at", strategy: "max" },
    ],
  },
  {
    table: "telegram_chat_delivery_diagnostics",
    conflictColumns: ["chat_id"],
    columns: [
      { column: "chat_id", select: "?", strategy: "copy-only" },
      { column: "last_successful_delivery_at", strategy: "nullif-max-zero" },
      { column: "last_successful_reply_at", strategy: "nullif-max-zero" },
      { column: "last_delivery_attempt_at", strategy: "nullif-max-zero" },
      { column: "recent_failure_class", strategy: "coalesce-old-first" },
      { column: "updated_at", strategy: "max" },
    ],
  },
];

function renderMergeExpr(table: string, column: string, strategy: MergeStrategy): string {
  if (typeof strategy === "object") return strategy.sql;
  switch (strategy) {
    case "copy-only":
      throw new Error("Copy-only migration columns have no conflict assignment");
    case "max":
      return `MAX(${table}.${column}, excluded.${column})`;
    case "min":
      return `MIN(${table}.${column}, excluded.${column})`;
    case "coalesce-old-first":
      return `COALESCE(${table}.${column}, excluded.${column})`;
    case "nullif-max-zero":
      return `NULLIF(MAX(COALESCE(${table}.${column}, 0), COALESCE(excluded.${column}, 0)), 0)`;
    case "null-safe-min":
      return `CASE
          WHEN ${table}.${column} IS NULL THEN excluded.${column}
          WHEN excluded.${column} IS NULL THEN ${table}.${column}
          ELSE MIN(${table}.${column}, excluded.${column})
        END`;
  }
}

function buildMigrationStatement(
  db: D1Database,
  descriptor: MigrationDescriptor,
): D1PreparedStatement {
  const insertColumns = descriptor.columns.map(({ column }) => column).join(",\n        ");
  const selectColumns = descriptor.columns.map(({ column, select }) => select ?? column).join(",\n        ");
  const conflict = descriptor.conflictColumns.join(", ");
  const setClause = descriptor.columns
    .filter(({ strategy }) => strategy !== "copy-only")
    .map(({ column, strategy }) => `${column} = ${renderMergeExpr(descriptor.table, column, strategy)}`)
    .join(",\n        ");
  // SAFETY: All identifiers and expressions come from the closed-set local
  // MIGRATION_TABLE_DESCRIPTORS above. No runtime data flows into the SQL string.
  return db.prepare(
    `INSERT INTO ${descriptor.table} (\n        ${insertColumns}\n      )\n      SELECT\n        ${selectColumns}\n      FROM ${descriptor.table}\n      WHERE chat_id = ?`
      + `\n      ON CONFLICT(${conflict}) DO UPDATE SET\n        ${setClause}`,
  );
}

/**
 * Merge Telegram group state after Telegram upgrades a group to a supergroup.
 * Telegram emits both `migrate_to_chat_id` and `migrate_from_chat_id` service
 * messages; this helper is idempotent so either event can safely run first.
 */
export async function migrateTelegramChatId(
  db: D1Database,
  oldChatId: string,
  newChatId: string,
  options: { operationStatements?: D1PreparedStatement[] } = {},
): Promise<void> {
  if (!oldChatId || !newChatId || oldChatId === newChatId) return;

  const statements: D1PreparedStatement[] = [
    ...MIGRATION_TABLE_DESCRIPTORS.map((descriptor) =>
      buildMigrationStatement(db, descriptor).bind(newChatId, oldChatId),
    ),
    // Body hashes carry no chat id; a (job, seq) already held by the new chat wins.
    db.prepare("UPDATE OR IGNORE telegram_deliveries SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_deliveries WHERE chat_id = ?").bind(oldChatId),
    db.prepare("UPDATE telegram_change_log SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE OR IGNORE telegram_rollup_state SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_rollup_state WHERE chat_id = ?").bind(oldChatId),
    db.prepare("UPDATE telegram_processed_updates SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(oldChatId),
    ...prepareChatMigrationCacheStatements(db, oldChatId, newChatId),
    ...(options.operationStatements ?? []),
  ];

  await executeAtomicBatch(db, statements);
}

