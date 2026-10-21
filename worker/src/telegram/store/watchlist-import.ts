import { D1_BATCH_SIZE } from "../../lib/constants";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  unpackWatchlistDirectState,
  type WatchlistDirectState,
  type WatchlistPresetState,
  type WatchlistState,
} from "../mini-app/watchlist-state";
import type { PresetSubscriptionRow, SubscriptionRow } from "../webhook/telegram-webhook-shared";
import { unixNow, prepareTelegramFirstFollowStatements } from "./subscribers";

interface PortableSubscriptionRow extends SubscriptionRow {
  alert_dews_override: number;
  alert_depeg_override: number;
  alert_safety_override: number;
  alert_launch_override: number;
  alert_reserve_override: number;
  alert_freeze: number;
  alert_freeze_override: number;
}

type PortableSnapshotRow = { preference_generation: number } & (
  | (PortableSubscriptionRow & { row_kind: "direct" })
  | (PresetSubscriptionRow & { row_kind: "preset" })
  | { row_kind: null }
);

function directFromRow(row: PortableSubscriptionRow): WatchlistDirectState {
  return {
    stablecoinId: row.stablecoin_id,
    alertDews: Boolean(row.alert_dews),
    alertDepeg: Boolean(row.alert_depeg),
    alertSafety: Boolean(row.alert_safety),
    alertLaunch: Boolean(row.alert_launch),
    alertReserve: Boolean(row.alert_reserve),
    alertFreeze: Boolean(row.alert_freeze),
    overrideDews: Boolean(row.alert_dews_override),
    overrideDepeg: Boolean(row.alert_depeg_override),
    overrideSafety: Boolean(row.alert_safety_override),
    overrideLaunch: Boolean(row.alert_launch_override),
    overrideReserve: Boolean(row.alert_reserve_override),
    overrideFreeze: Boolean(row.alert_freeze_override),
    dewsMinBand: row.dews_min_band === "ALERT" || row.dews_min_band === "WARNING" || row.dews_min_band === "DANGER"
      ? row.dews_min_band
      : null,
    safetyMode: row.safety_mode === "all" || row.safety_mode === "downgrade-only" || row.safety_mode === "upgrade-only"
      ? row.safety_mode
      : null,
    depegWorseningBpsStep: row.depeg_worsening_bps_step === 100
      || row.depeg_worsening_bps_step === 250
      || row.depeg_worsening_bps_step === 500
      ? row.depeg_worsening_bps_step
      : null,
  };
}

function presetFromRow(row: PresetSubscriptionRow): WatchlistPresetState {
  return {
    presetId: row.preset_id,
    alertDews: Boolean(row.alert_dews),
    alertDepeg: Boolean(row.alert_depeg),
    alertSafety: Boolean(row.alert_safety),
    depegWorseningBpsStep: row.depeg_worsening_bps_step === 100
      || row.depeg_worsening_bps_step === 250
      || row.depeg_worsening_bps_step === 500
      ? row.depeg_worsening_bps_step
      : null,
  };
}

export async function loadWatchlistPortableState(
  db: D1Database,
  chatId: string,
  registryVersion: string,
  includeSnoozeOnlyRows = false,
): Promise<{
  state: WatchlistState;
  preferenceGeneration: number | null;
  directSnoozes: Map<string, number | null>;
}> {
  // One statement captures generation, both intent sources and raw snoozes.
  // UNION ALL avoids multiplying direct rows by preset rows; the LEFT JOIN
  // retains an empty subscriber without treating an absent one as generation 0.
  const result = await db.prepare(`
    WITH subscriber AS (
      SELECT chat_id, preference_generation FROM telegram_subscribers WHERE chat_id = ?
    ), watchlist AS (
      SELECT 'direct' AS row_kind, stablecoin_id, NULL AS preset_id,
             alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
             alert_dews_override, alert_depeg_override, alert_safety_override,
             alert_launch_override, alert_reserve_override,
             alert_freeze, alert_freeze_override,
             dews_min_band, safety_mode, depeg_worsening_bps_step,
             alert_snooze_until_ts
        FROM telegram_subscriptions
       WHERE chat_id = ?
      UNION ALL
      SELECT 'preset', NULL, preset_id,
             alert_dews, alert_depeg, alert_safety, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, depeg_worsening_bps_step, NULL
        FROM telegram_preset_subscriptions
       WHERE chat_id = ?
    )
    SELECT subscriber.preference_generation, watchlist.*
      FROM subscriber LEFT JOIN watchlist ON 1 = 1
     ORDER BY row_kind, stablecoin_id, preset_id
  `).bind(chatId, chatId, chatId).all<PortableSnapshotRow>();
  const rows = result.results ?? [];
  const direct: WatchlistDirectState[] = [];
  const presets: WatchlistPresetState[] = [];
  const directSnoozes = new Map<string, number | null>();
  for (const row of rows) {
    if (row.row_kind === "preset") {
      presets.push(presetFromRow(row));
    } else if (row.row_kind === "direct") {
      directSnoozes.set(row.stablecoin_id, row.alert_snooze_until_ts ?? null);
      if (TELEGRAM_ALERT_TYPES.some((alertType) => Boolean(
        row[TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn]
        || row[TELEGRAM_ALERT_PERSISTENCE[alertType].overrideColumn],
      )) || Boolean(row.dews_min_band || row.safety_mode || row.depeg_worsening_bps_step)
        || (includeSnoozeOnlyRows && row.alert_snooze_until_ts != null)) {
        direct.push(directFromRow(row));
      }
    }
  }
  return {
    state: { registryVersion, direct, presets },
    preferenceGeneration: rows[0]?.preference_generation ?? null,
    directSnoozes,
  };
}

function prepareWatchlistDirectInsertStatements(
  db: D1Database,
  chatId: string,
  generationLease: number,
  rows: readonly WatchlistDirectState[],
): D1PreparedStatement[] {
  const columnsPerRow = 17;
  const rowsPerStatement = Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / columnsPerRow);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    const chunk = rows.slice(index, index + rowsPerStatement);
    const placeholders = chunk.map(() => `(${new Array(columnsPerRow).fill("?").join(", ")})`).join(", ");
    const binds = chunk.flatMap((row) => [
      chatId,
      row.stablecoinId,
      row.alertDews ? 1 : 0,
      row.alertDepeg ? 1 : 0,
      row.alertSafety ? 1 : 0,
      row.alertLaunch ? 1 : 0,
      row.alertReserve ? 1 : 0,
      row.alertFreeze ? 1 : 0,
      row.overrideDews ? 1 : 0,
      row.overrideDepeg ? 1 : 0,
      row.overrideSafety ? 1 : 0,
      row.overrideLaunch ? 1 : 0,
      row.overrideReserve ? 1 : 0,
      row.overrideFreeze ? 1 : 0,
      row.dewsMinBand,
      row.safetyMode,
      row.depegWorseningBpsStep,
    ]);
    statements.push(db.prepare(`
      WITH import_guard AS (
        SELECT 1 FROM telegram_subscribers WHERE chat_id = ? AND preference_generation = ?
      ), incoming (
        chat_id, stablecoin_id,
        alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze,
        alert_dews_override, alert_depeg_override, alert_safety_override,
        alert_launch_override, alert_reserve_override, alert_freeze_override,
        dews_min_band, safety_mode, depeg_worsening_bps_step
      ) AS (VALUES ${placeholders})
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id,
        alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze,
        alert_dews_override, alert_depeg_override, alert_safety_override,
        alert_launch_override, alert_reserve_override, alert_freeze_override,
        dews_min_band, safety_mode, depeg_worsening_bps_step
      ) SELECT incoming.* FROM incoming, import_guard WHERE true
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_dews = excluded.alert_dews,
        alert_depeg = excluded.alert_depeg,
        alert_safety = excluded.alert_safety,
        alert_launch = excluded.alert_launch,
        alert_reserve = excluded.alert_reserve,
        alert_freeze = excluded.alert_freeze,
        alert_dews_override = excluded.alert_dews_override,
        alert_depeg_override = excluded.alert_depeg_override,
        alert_safety_override = excluded.alert_safety_override,
        alert_launch_override = excluded.alert_launch_override,
        alert_reserve_override = excluded.alert_reserve_override,
        alert_freeze_override = excluded.alert_freeze_override,
        dews_min_band = excluded.dews_min_band,
        safety_mode = excluded.safety_mode,
        depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
    `).bind(chatId, generationLease, ...binds));
  }
  return statements;
}

function prepareGuardedDeletes(
  db: D1Database,
  chatId: string,
  generationLease: number,
  table: "telegram_subscriptions" | "telegram_preset_subscriptions",
  column: "stablecoin_id" | "preset_id",
  ids: readonly string[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const chunkSize = D1_MAX_BOUND_PARAMETERS - 3;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    // SAFETY: table and column are closed internal literal unions; values use D1 binds.
    statements.push(db.prepare(`
      DELETE FROM ${table}
       WHERE chat_id = ? AND ${column} IN (${placeholders})
         AND EXISTS (
           SELECT 1 FROM telegram_subscribers
            WHERE chat_id = ? AND preference_generation = ?
         )
    `).bind(chatId, ...chunk, chatId, generationLease));
  }
  return statements;
}

async function executeGenerationFencedWatchlistMutation(
  db: D1Database,
  input: {
    chatId: string;
    ensureSubscriber?: { username: string | null };
    expectedPreferenceGeneration: number;
    generationLease: number;
    firstFollowFeature?: "direct";
    prepareGuardedStatements: (nowSec: number) => D1PreparedStatement[];
    statementLimitLabel: string;
  },
): Promise<"applied" | "stale"> {
  const nowSec = unixNow();
  const statements: D1PreparedStatement[] = [
    ...(input.ensureSubscriber
      ? [db.prepare(`
          INSERT OR IGNORE INTO telegram_subscribers (
            chat_id, username, created_at, last_active_at
          ) VALUES (?, ?, ?, ?)
        `).bind(input.chatId, input.ensureSubscriber.username, nowSec, nowSec)]
      : []),
    db.prepare(`
      UPDATE telegram_subscribers
         SET preference_generation = ?, last_active_at = ?
       WHERE chat_id = ? AND preference_generation = ?
    `).bind(input.generationLease, nowSec, input.chatId, input.expectedPreferenceGeneration),
    ...(input.firstFollowFeature
      ? prepareTelegramFirstFollowStatements(db, {
          chatId: input.chatId, username: null, nowSec,
          ensureSubscriber: false, feature: input.firstFollowFeature,
          guard: { sql: "preference_generation = ?", binds: [input.generationLease] },
        })
      : []),
    ...input.prepareGuardedStatements(nowSec),
    db.prepare(`
      UPDATE telegram_subscribers
         SET preference_generation = ?
       WHERE chat_id = ? AND preference_generation = ?
    `).bind(input.expectedPreferenceGeneration + 1, input.chatId, input.generationLease),
  ];
  if (statements.length > D1_BATCH_SIZE) {
    throw new RangeError(`${input.statementLimitLabel} requires too many atomic statements (${statements.length})`);
  }
  const results = await runWithOverloadRetry(() => db.batch(statements), 3);
  const guardResultIndex = input.ensureSubscriber ? 1 : 0;
  return Number(results[guardResultIndex]?.meta?.changes ?? 0) > 0 ? "applied" : "stale";
}

/**
 * Applies a bounded direct-row patch under the same preference-generation
 * lease. Presets are intentionally absent:
 * bulk watchlist editing must never materialize, delete, or otherwise alter a
 * preset source.
 */
export async function applyWatchlistDirectPatch(
  db: D1Database,
  input: {
    chatId: string;
    ensureSubscriber?: { username: string | null };
    expectedPreferenceGeneration: number;
    generationLease: number;
    directEntriesToUpsert: readonly string[];
    /** Exact direct-row snooze restoration used only by bounded bulk undo. */
    directSnoozeValues?: readonly { stablecoinId: string; snoozeUntilTs: number | null }[];
    directRemoveIds: readonly string[];
  },
): Promise<"applied" | "stale"> {
  const rows = input.directEntriesToUpsert.map(unpackWatchlistDirectState);
  const ids = rows.map((row) => row?.stablecoinId ?? "");
  if (
    rows.some((row) => row == null)
    || rows.length + input.directRemoveIds.length === 0
    || rows.length + input.directRemoveIds.length > 20
    || new Set(ids).size !== ids.length
    || new Set(input.directRemoveIds).size !== input.directRemoveIds.length
    || ids.some((id) => !TRACKED_META_BY_ID.has(id))
    || input.directRemoveIds.some((id) => !TRACKED_META_BY_ID.has(id) || ids.includes(id))
  ) {
    throw new Error("Bulk direct watchlist patch failed validation");
  }
  const directRows = rows as WatchlistDirectState[];
  const snoozeValues = input.directSnoozeValues ?? [];
  if (
    snoozeValues.length > directRows.length
    || new Set(snoozeValues.map((row) => row.stablecoinId)).size !== snoozeValues.length
    || snoozeValues.some((row) => !ids.includes(row.stablecoinId))
  ) {
    throw new Error("Bulk direct watchlist snooze restoration failed validation");
  }
  return executeGenerationFencedWatchlistMutation(db, {
    ...input,
    statementLimitLabel: "Bulk watchlist patch",
    firstFollowFeature: directRows.some((row) => row.alertDews || row.alertDepeg || row.alertSafety || row.alertLaunch || row.alertReserve || row.alertFreeze)
      ? "direct" : undefined,
    prepareGuardedStatements: () => [
      ...prepareGuardedDeletes(db, input.chatId, input.generationLease, "telegram_subscriptions", "stablecoin_id", input.directRemoveIds),
      ...prepareWatchlistDirectInsertStatements(db, input.chatId, input.generationLease, directRows),
      ...(snoozeValues.length === 0 ? [] : [db.prepare(`
        WITH import_guard AS (
          SELECT 1 FROM telegram_subscribers WHERE chat_id = ? AND preference_generation = ?
        ), incoming (stablecoin_id, alert_snooze_until_ts) AS (
          VALUES ${snoozeValues.map(() => "(?, ?)").join(", ")}
        )
        UPDATE telegram_subscriptions
           SET alert_snooze_until_ts = (
             SELECT incoming.alert_snooze_until_ts
               FROM incoming
              WHERE incoming.stablecoin_id = telegram_subscriptions.stablecoin_id
           )
         WHERE chat_id = ?
           AND stablecoin_id IN (${snoozeValues.map(() => "?").join(", ")})
           AND EXISTS (SELECT 1 FROM import_guard)
      `).bind(
        input.chatId,
        input.generationLease,
        ...snoozeValues.flatMap((row) => [row.stablecoinId, row.snoozeUntilTs]),
        input.chatId,
        ...snoozeValues.map((row) => row.stablecoinId),
      )]),
    ],
  });
}
