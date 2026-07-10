import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { pruneOverflowPlanBacklogForChat } from "../../cron/dispatch-telegram-overflow";
import { deleteCache, getCache, setCache } from "../../lib/db-cache";
import { unixNow } from "./subscribers";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "./_internals";

/**
 * Atomically wipe every subscription, preset follow, and global-alert flag
 * for the chat. Mirrors the inline SQL the bulk-confirm `unsubscribeAll` path
 * (`telegram-webhook-callbacks.ts:1082-1106`) writes today.
 */
export async function unsubscribeAll(
  db: D1Database,
  chatId: string,
  options: { clearPending?: boolean; operationStatements?: D1PreparedStatement[] } = {},
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
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                global_alert_launch = 0,
                global_alert_reserve = 0,
                global_depeg_worsening_bps_step = NULL,
                alert_snooze_until_ts = NULL,
                preference_generation = preference_generation + 1,
                last_active_at = ?
          WHERE chat_id = ?`,
      )
      .bind(now, chatId),
  ];
  if (options.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  await executeAtomicBatch(db, appendTelegramOperationStatements(statements, options));
}

/**
 * Delete every row this subscriber owns across the Telegram tables. Retains
 * `telegram_processed_updates` so replay-ack idempotency survives a re-/start.
 */
export async function forgetSubscriber(
  db: D1Database,
  chatId: string,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const now = unixNow();
  await executeAtomicBatch(db, appendTelegramOperationStatements([
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_alerts WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_alert_source_resolution_targets WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_alert_job_targets WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_alert_dead_letters WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(chatId),
    ...prepareDeleteTelegramChatCacheStatements(db, chatId),
  ], options));
  await pruneOverflowPlanBacklogForChat(db, chatId, now);
  await removeChatFromBurstMarkers(db, chatId);
}

const BURST_MARKERS_CACHE_KEY = "telegram:burst-markers";

async function removeChatFromBurstMarkers(db: D1Database, chatId: string): Promise<void> {
  const cached = await getCache(db, BURST_MARKERS_CACHE_KEY);
  if (!cached) return;

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(cached.value) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    parsed = value as Record<string, unknown>;
  } catch {
    return;
  }

  if (!(chatId in parsed)) return;
  delete parsed[chatId];

  if (Object.keys(parsed).length === 0) {
    await deleteCache(db, BURST_MARKERS_CACHE_KEY);
    return;
  }

  await setCache(db, BURST_MARKERS_CACHE_KEY, JSON.stringify(parsed));
}

const CHAT_CACHE_EXACT_KEY_BUILDERS = [
  (chatId: string) => `telegram:command-flood:${chatId}`,
  (chatId: string) => `telegram:re-engagement-warned:${chatId}`,
  (chatId: string) => `telegram:chat-admins:${chatId}`,
  (chatId: string) => `telegram:group-welcome:${chatId}`,
  (chatId: string) => `telegram:mini-app-mutation-burst:${chatId}`,
] as const;

const CHAT_CACHE_PREFIX_BUILDERS = [
  (chatId: string) => `telegram:command-flood:${chatId}:`,
  (chatId: string) => `telegram:command-cooldown:${chatId}:`,
  (chatId: string) => `telegram:chat-member:${chatId}:`,
] as const;

export function prepareDeleteTelegramChatCacheStatements(
  db: D1Database,
  chatId: string,
): D1PreparedStatement[] {
  return [
    ...CHAT_CACHE_EXACT_KEY_BUILDERS.map((buildKey) =>
      db.prepare("DELETE FROM cache WHERE key = ?").bind(buildKey(chatId)),
    ),
    ...CHAT_CACHE_PREFIX_BUILDERS.map((buildPrefix) =>
      db.prepare("DELETE FROM cache WHERE key LIKE ?").bind(`${buildPrefix(chatId)}%`),
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
      "alert_reserve",
      "alert_dews_override",
      "alert_depeg_override",
      "alert_safety_override",
      "alert_launch_override",
      "alert_reserve_override",
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
        { column: "alert_reserve", strategy: "max" },
        // Override markers preserve explicit user intent from either row. Alert
        // values already merge with MAX, so the matching boolean markers do too.
        { column: "alert_dews_override", strategy: "max" },
        { column: "alert_depeg_override", strategy: "max" },
        { column: "alert_safety_override", strategy: "max" },
        { column: "alert_launch_override", strategy: "max" },
        { column: "alert_reserve_override", strategy: "max" },
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

function dedupePrefixPredicate(column: string): string {
  return `${column} IS NOT NULL
        AND substr(${column}, 1, length(?)) = ?
        AND substr(${column}, length(?) + 1, 1) = ':'`;
}

function bindDedupePrefixRewrite(
  statement: D1PreparedStatement,
  oldChatId: string,
  newChatId: string,
): D1PreparedStatement {
  return statement.bind(
    newChatId,
    oldChatId,
    newChatId,
    oldChatId,
    oldChatId,
    oldChatId,
  );
}

function bindDedupePrefixCleanup(
  statement: D1PreparedStatement,
  oldChatId: string,
  newChatId: string,
): D1PreparedStatement {
  return statement.bind(newChatId, oldChatId, oldChatId, oldChatId);
}

function preparePendingDedupeMigrationStatements(
  db: D1Database,
  oldChatId: string,
  newChatId: string,
): D1PreparedStatement[] {
  const pendingPredicate = dedupePrefixPredicate("dedupe_key");
  const targetDedupePredicate = dedupePrefixPredicate("pending_dedupe_key");
  const targetKeyPredicate = dedupePrefixPredicate("target_key");
  return [
    bindDedupePrefixRewrite(
      db.prepare(`
        UPDATE OR IGNORE telegram_pending_alerts
           SET dedupe_key = ? || substr(dedupe_key, length(?) + 1)
         WHERE chat_id = ?
           AND ${pendingPredicate}
      `),
      oldChatId,
      newChatId,
    ),
    bindDedupePrefixCleanup(
      db.prepare(`
        DELETE FROM telegram_pending_alerts
         WHERE chat_id = ?
           AND ${pendingPredicate}
      `),
      oldChatId,
      newChatId,
    ),
    bindDedupePrefixRewrite(
      db.prepare(`
        UPDATE telegram_alert_job_targets
           SET pending_dedupe_key = ? || substr(pending_dedupe_key, length(?) + 1)
         WHERE chat_id = ?
           AND ${targetDedupePredicate}
      `),
      oldChatId,
      newChatId,
    ),
    db.prepare(`
        UPDATE OR IGNORE telegram_alert_job_target_items
           SET target_key = ? || substr(target_key, length(?) + 1)
         WHERE ${targetKeyPredicate}
      `).bind(newChatId, oldChatId, oldChatId, oldChatId, oldChatId),
    bindDedupePrefixRewrite(
      db.prepare(`
        UPDATE OR IGNORE telegram_alert_job_targets
           SET target_key = ? || substr(target_key, length(?) + 1)
         WHERE chat_id = ?
           AND ${targetKeyPredicate}
      `),
      oldChatId,
      newChatId,
    ),
    db.prepare(`
        DELETE FROM telegram_alert_job_target_items
         WHERE ${targetKeyPredicate}
      `).bind(oldChatId, oldChatId, oldChatId),
  ];
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
  options: { operationStatements?: D1PreparedStatement[] } = {},
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
        alert_reserve,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        global_alert_launch,
        global_alert_reserve,
        quiet_hours_enabled,
        quiet_hours_start_utc,
        quiet_hours_end_utc,
        global_depeg_worsening_bps_step,
        timezone,
        alert_snooze_until_ts,
        consecutive_block_count,
        consecutive_block_first_at,
        created_at,
        last_active_at,
        preference_generation
      )
      SELECT
        ?,
        username,
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
        quiet_hours_enabled,
        quiet_hours_start_utc,
        quiet_hours_end_utc,
        global_depeg_worsening_bps_step,
        timezone,
        alert_snooze_until_ts,
        consecutive_block_count,
        consecutive_block_first_at,
        created_at,
        last_active_at,
        preference_generation + 1
      FROM telegram_subscribers
      WHERE chat_id = ?
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(telegram_subscribers.username, excluded.username),
        alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_subscribers.alert_safety, excluded.alert_safety),
        alert_launch = MAX(telegram_subscribers.alert_launch, excluded.alert_launch),
        alert_reserve = MAX(telegram_subscribers.alert_reserve, excluded.alert_reserve),
        global_alert_dews = MAX(telegram_subscribers.global_alert_dews, excluded.global_alert_dews),
        global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg),
        global_alert_safety = MAX(telegram_subscribers.global_alert_safety, excluded.global_alert_safety),
        global_alert_launch = MAX(telegram_subscribers.global_alert_launch, excluded.global_alert_launch),
        global_alert_reserve = MAX(telegram_subscribers.global_alert_reserve, excluded.global_alert_reserve),
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
        last_active_at = MAX(telegram_subscribers.last_active_at, excluded.last_active_at),
        preference_generation = MAX(
          telegram_subscribers.preference_generation,
          excluded.preference_generation
        ) + 1
    `).bind(newChatId, oldChatId),
    ...MIGRATION_TABLE_DESCRIPTORS.map((descriptor) =>
      buildMigrationStatement(db, descriptor).bind(newChatId, oldChatId),
    ),
    db.prepare("UPDATE telegram_pending_alerts SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE OR IGNORE telegram_alert_source_resolution_targets SET chat_id = ? WHERE chat_id = ?")
      .bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_alert_source_resolution_targets WHERE chat_id = ?").bind(oldChatId),
    db.prepare("UPDATE telegram_alert_job_targets SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    ...preparePendingDedupeMigrationStatements(db, oldChatId, newChatId),
    db.prepare("UPDATE telegram_alert_dead_letters SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("UPDATE telegram_processed_updates SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(oldChatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(oldChatId),
    ...prepareChatMigrationCacheStatements(db, oldChatId, newChatId),
    ...(options.operationStatements ?? []),
  ];

  await executeAtomicBatch(db, statements);
}
