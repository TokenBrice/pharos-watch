import { D1_BATCH_SIZE } from "../../lib/constants";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { isSubscribableCoin } from "../../lib/telegram/subscription-eligibility";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  packWatchlistDirectState,
  packWatchlistPresetState,
  unpackWatchlistDirectState,
  unpackWatchlistPresetState,
  type WatchlistTokenDirectState,
  type WatchlistTokenPresetState,
  type WatchlistTokenV2State,
} from "../../lib/telegram/watchlist-token";
import type { PresetSubscriptionRow, SubscriptionRow } from "../telegram-webhook-shared";
import { loadPresetSubscriptions } from "./presets";
import { loadSubscriberByChat, unixNow } from "./subscribers";

export interface WatchlistImportPreview {
  directAdds: string[];
  directRemoves: string[];
  directChanges: string[];
  directChangeBefore: string[];
  presetAdds: string[];
  presetRemoves: string[];
  presetChanges: string[];
  presetChangeBefore: string[];
}

interface PortableSubscriptionRow extends SubscriptionRow {
  alert_dews_override: number;
  alert_depeg_override: number;
  alert_safety_override: number;
  alert_launch_override: number;
  alert_reserve_override: number;
  alert_freeze: number;
  alert_freeze_override: number;
}

function directFromRow(row: PortableSubscriptionRow): WatchlistTokenDirectState {
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

function presetFromRow(row: PresetSubscriptionRow): WatchlistTokenPresetState {
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
): Promise<{
  state: WatchlistTokenV2State;
  preferenceGeneration: number | null;
}> {
  const [directResult, presets, subscriber] = await Promise.all([
    db.prepare(`
      SELECT stablecoin_id,
             alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
             alert_dews_override, alert_depeg_override, alert_safety_override,
             alert_launch_override, alert_reserve_override,
             alert_freeze, alert_freeze_override,
             dews_min_band, safety_mode, depeg_worsening_bps_step,
             alert_snooze_until_ts
        FROM telegram_subscriptions
       WHERE chat_id = ?
       ORDER BY stablecoin_id
    `).bind(chatId).all<PortableSubscriptionRow>(),
    loadPresetSubscriptions(db, chatId),
    loadSubscriberByChat(db, chatId),
  ]);
  return {
    state: {
      registryVersion,
      direct: (directResult.results ?? [])
        .filter((row) => TELEGRAM_ALERT_TYPES.some((alertType) => Boolean(
          row[TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn]
          || row[TELEGRAM_ALERT_PERSISTENCE[alertType].overrideColumn],
        )) || Boolean(row.dews_min_band || row.safety_mode || row.depeg_worsening_bps_step))
        .map(directFromRow),
      presets: presets.map(presetFromRow),
    },
    preferenceGeneration: subscriber?.preference_generation ?? null,
  };
}

function diffPacked(
  current: readonly string[],
  desired: readonly string[],
  idFromEntry: (entry: string) => string,
): { adds: string[]; removes: string[]; changes: string[]; changeBefore: string[] } {
  const currentById = new Map(current.map((entry) => [idFromEntry(entry), entry]));
  const desiredById = new Map(desired.map((entry) => [idFromEntry(entry), entry]));
  const adds: string[] = [];
  const removes: string[] = [];
  const changes: string[] = [];
  const changeBeforeById = new Map<string, string>();
  for (const [id, entry] of desiredById) {
    const previous = currentById.get(id);
    if (previous == null) adds.push(id);
    else if (previous !== entry) {
      changes.push(id);
      changeBeforeById.set(id, previous);
    }
  }
  for (const id of currentById.keys()) {
    if (!desiredById.has(id)) removes.push(id);
  }
  changes.sort();
  return {
    adds: adds.sort(),
    removes: removes.sort(),
    changes,
    changeBefore: changes.map((id) => changeBeforeById.get(id)!),
  };
}

export function buildWatchlistImportPreview(
  current: WatchlistTokenV2State,
  desired: WatchlistTokenV2State,
): WatchlistImportPreview {
  const currentDirect = current.direct.map(packWatchlistDirectState);
  const desiredDirect = desired.direct.map(packWatchlistDirectState);
  const currentPresets = current.presets.map(packWatchlistPresetState);
  const desiredPresets = desired.presets.map(packWatchlistPresetState);
  const direct = diffPacked(currentDirect, desiredDirect, (entry) => unpackWatchlistDirectState(entry)!.stablecoinId);
  const presets = diffPacked(currentPresets, desiredPresets, (entry) => unpackWatchlistPresetState(entry)!.presetId);
  return {
    directAdds: direct.adds,
    directRemoves: direct.removes,
    directChanges: direct.changes,
    directChangeBefore: direct.changeBefore,
    presetAdds: presets.adds,
    presetRemoves: presets.removes,
    presetChanges: presets.changes,
    presetChangeBefore: presets.changeBefore,
  };
}

export async function isWatchlistImportPreviewCurrent(
  db: D1Database,
  chatId: string,
  input: {
    expectedPreferenceGeneration: number;
    registryVersion: string;
    directEntries: readonly string[];
    presetEntries: readonly string[];
    preview: WatchlistImportPreview;
  },
): Promise<boolean> {
  const direct = input.directEntries.map(unpackWatchlistDirectState);
  const presets = input.presetEntries.map(unpackWatchlistPresetState);
  if (direct.some((row) => row == null) || presets.some((row) => row == null)) return false;
  const current = await loadWatchlistPortableState(db, chatId, input.registryVersion);
  if (current.preferenceGeneration !== input.expectedPreferenceGeneration) return false;
  const recomputed = buildWatchlistImportPreview(current.state, {
    registryVersion: input.registryVersion,
    direct: direct as WatchlistTokenDirectState[],
    presets: presets as WatchlistTokenPresetState[],
  });
  return JSON.stringify(recomputed) === JSON.stringify(input.preview);
}

function prepareWatchlistDirectInsertStatements(
  db: D1Database,
  chatId: string,
  generationLease: number,
  rows: readonly WatchlistTokenDirectState[],
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

function preparePresetInsertStatements(
  db: D1Database,
  chatId: string,
  generationLease: number,
  rows: readonly WatchlistTokenPresetState[],
  nowSec: number,
): D1PreparedStatement[] {
  const columnsPerRow = 8;
  const rowsPerStatement = Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / columnsPerRow);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    const chunk = rows.slice(index, index + rowsPerStatement);
    const placeholders = chunk.map(() => `(${new Array(columnsPerRow).fill("?").join(", ")})`).join(", ");
    const binds = chunk.flatMap((row) => [
      chatId,
      row.presetId,
      row.alertDews ? 1 : 0,
      row.alertDepeg ? 1 : 0,
      row.alertSafety ? 1 : 0,
      row.depegWorseningBpsStep,
      nowSec,
      nowSec,
    ]);
    statements.push(db.prepare(`
      WITH import_guard AS (
        SELECT 1 FROM telegram_subscribers WHERE chat_id = ? AND preference_generation = ?
      ), incoming (
        chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
        depeg_worsening_bps_step, created_at, updated_at
      ) AS (VALUES ${placeholders})
      INSERT INTO telegram_preset_subscriptions (
        chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
        depeg_worsening_bps_step, created_at, updated_at
      ) SELECT incoming.* FROM incoming, import_guard WHERE true
      ON CONFLICT(chat_id, preset_id) DO UPDATE SET
        alert_dews = excluded.alert_dews,
        alert_depeg = excluded.alert_depeg,
        alert_safety = excluded.alert_safety,
        depeg_worsening_bps_step = excluded.depeg_worsening_bps_step,
        updated_at = excluded.updated_at
    `).bind(chatId, generationLease, ...binds));
  }
  return statements;
}

export async function applyWatchlistImportV2(
  db: D1Database,
  input: {
    chatId: string;
    /**
     * A Mini App preview is intentionally read-only. When its confirmation is
     * the first write for a chat, create the subscriber in this same atomic
     * batch before the preference-generation guard.
     */
    ensureSubscriber?: { username: string | null };
    expectedPreferenceGeneration: number;
    generationLease: number;
    directEntries: readonly string[];
    presetEntries: readonly string[];
    directRemoveIds: readonly string[];
    presetRemoveIds: readonly string[];
    pendingExpiresAt: number;
    pendingActionPayload: string;
    operationStatements?: D1PreparedStatement[];
  },
): Promise<"applied" | "stale"> {
  const direct = input.directEntries.map(unpackWatchlistDirectState);
  const presets = input.presetEntries.map(unpackWatchlistPresetState);
  if (direct.some((row) => row == null) || presets.some((row) => row == null)) {
    throw new Error("Stored watchlist import payload is malformed");
  }
  const directRows = direct as WatchlistTokenDirectState[];
  const presetRows = presets as WatchlistTokenPresetState[];
  const directIds = directRows.map((row) => row.stablecoinId);
  const presetIds = presetRows.map((row) => row.presetId);
  const knownPresets = new Set<string>(TELEGRAM_PRESET_IDS);
  if (
    new Set(directIds).size !== directIds.length
    || new Set(presetIds).size !== presetIds.length
    || directIds.some((id) => !isSubscribableCoin(id))
    || presetIds.some((id) => !knownPresets.has(id))
    || new Set(input.directRemoveIds).size !== input.directRemoveIds.length
    || new Set(input.presetRemoveIds).size !== input.presetRemoveIds.length
    || input.directRemoveIds.some((id) => directIds.includes(id))
    || input.presetRemoveIds.some((id) => presetIds.includes(id))
  ) {
    throw new Error("Stored watchlist import payload failed confirmation validation");
  }
  const nowSec = unixNow();
  const prepareGuardedDeletes = (table: "telegram_subscriptions" | "telegram_preset_subscriptions", column: string, ids: readonly string[]) => {
    const statements: D1PreparedStatement[] = [];
    const chunkSize = D1_MAX_BOUND_PARAMETERS - 3;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      statements.push(db.prepare(`
        DELETE FROM ${table}
         WHERE chat_id = ? AND ${column} IN (${placeholders})
           AND EXISTS (
             SELECT 1 FROM telegram_subscribers
              WHERE chat_id = ? AND preference_generation = ?
           )
      `).bind(input.chatId, ...chunk, input.chatId, input.generationLease));
    }
    return statements;
  };
  const guard = db.prepare(`
    UPDATE telegram_subscribers
       SET preference_generation = ?, last_active_at = ?
     WHERE chat_id = ? AND preference_generation = ?
  `).bind(input.generationLease, nowSec, input.chatId, input.expectedPreferenceGeneration);
  const statements: D1PreparedStatement[] = [
    ...(input.ensureSubscriber
      ? [db.prepare(`
          INSERT OR IGNORE INTO telegram_subscribers (
            chat_id, username, created_at, last_active_at
          ) VALUES (?, ?, ?, ?)
        `).bind(input.chatId, input.ensureSubscriber.username, nowSec, nowSec)]
      : []),
    guard,
    ...prepareGuardedDeletes("telegram_subscriptions", "stablecoin_id", input.directRemoveIds),
    ...prepareGuardedDeletes("telegram_preset_subscriptions", "preset_id", input.presetRemoveIds),
    db.prepare(`
      DELETE FROM telegram_subscriptions
       WHERE chat_id = ?
         AND alert_dews = 0 AND alert_depeg = 0 AND alert_safety = 0
         AND alert_launch = 0 AND alert_reserve = 0
         AND alert_freeze = 0
         AND alert_dews_override = 0 AND alert_depeg_override = 0
         AND alert_safety_override = 0 AND alert_launch_override = 0
         AND alert_reserve_override = 0 AND alert_freeze_override = 0
         AND dews_min_band IS NULL AND safety_mode IS NULL
         AND depeg_worsening_bps_step IS NULL
         AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)
         AND EXISTS (
           SELECT 1 FROM telegram_subscribers
            WHERE chat_id = ? AND preference_generation = ?
         )
    `).bind(input.chatId, nowSec, input.chatId, input.generationLease),
    ...prepareWatchlistDirectInsertStatements(db, input.chatId, input.generationLease, directRows),
    ...preparePresetInsertStatements(db, input.chatId, input.generationLease, presetRows, nowSec),
    // Consume this exact preview even when the generation guard is stale. The
    // operation marker commits in the same batch, making stale rejection a
    // terminal, retry-safe outcome while every preference statement remains a no-op.
    db.prepare(`
      DELETE FROM telegram_pending_disambiguation
       WHERE chat_id = ? AND action_type = 'confirm-bulk'
         AND action_payload = ? AND expires_at = ?
    `).bind(input.chatId, input.pendingActionPayload, input.pendingExpiresAt),
    db.prepare(`
      UPDATE telegram_subscribers
         SET preference_generation = ?
       WHERE chat_id = ? AND preference_generation = ?
    `).bind(input.expectedPreferenceGeneration + 1, input.chatId, input.generationLease),
    ...(input.operationStatements ?? []),
  ];
  if (statements.length > D1_BATCH_SIZE) {
    throw new RangeError(`Watchlist import requires too many atomic statements (${statements.length})`);
  }
  const results = await runWithOverloadRetry(() => db.batch(statements), 3);
  const guardResultIndex = input.ensureSubscriber ? 1 : 0;
  return Number(results[guardResultIndex]?.meta?.changes ?? 0) > 0 ? "applied" : "stale";
}

/**
 * Applies a bounded direct-row patch under the same preference-generation
 * lease used by the portability importer. Presets are intentionally absent:
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
  const directRows = rows as WatchlistTokenDirectState[];
  const snoozeValues = input.directSnoozeValues ?? [];
  if (
    snoozeValues.length > directRows.length
    || new Set(snoozeValues.map((row) => row.stablecoinId)).size !== snoozeValues.length
    || snoozeValues.some((row) => !ids.includes(row.stablecoinId))
  ) {
    throw new Error("Bulk direct watchlist snooze restoration failed validation");
  }
  const nowSec = unixNow();
  const guard = db.prepare(`
    UPDATE telegram_subscribers
       SET preference_generation = ?, last_active_at = ?
     WHERE chat_id = ? AND preference_generation = ?
  `).bind(input.generationLease, nowSec, input.chatId, input.expectedPreferenceGeneration);
  const deletes = input.directRemoveIds.length === 0
    ? []
    : [db.prepare(`
        DELETE FROM telegram_subscriptions
         WHERE chat_id = ? AND stablecoin_id IN (${input.directRemoveIds.map(() => "?").join(", ")})
           AND EXISTS (
             SELECT 1 FROM telegram_subscribers
              WHERE chat_id = ? AND preference_generation = ?
           )
      `).bind(input.chatId, ...input.directRemoveIds, input.chatId, input.generationLease)];
  const statements: D1PreparedStatement[] = [
    ...(input.ensureSubscriber
      ? [db.prepare(`
          INSERT OR IGNORE INTO telegram_subscribers (
            chat_id, username, created_at, last_active_at
          ) VALUES (?, ?, ?, ?)
        `).bind(input.chatId, input.ensureSubscriber.username, nowSec, nowSec)]
      : []),
    guard,
    ...deletes,
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
    db.prepare(`
      UPDATE telegram_subscribers
         SET preference_generation = ?
       WHERE chat_id = ? AND preference_generation = ?
    `).bind(input.expectedPreferenceGeneration + 1, input.chatId, input.generationLease),
  ];
  if (statements.length > D1_BATCH_SIZE) {
    throw new RangeError(`Bulk watchlist patch requires too many atomic statements (${statements.length})`);
  }
  const results = await runWithOverloadRetry(() => db.batch(statements), 3);
  const guardResultIndex = input.ensureSubscriber ? 1 : 0;
  return Number(results[guardResultIndex]?.meta?.changes ?? 0) > 0 ? "applied" : "stale";
}

export async function watchlistPortableStateMatches(
  db: D1Database,
  chatId: string,
  directEntries: readonly string[],
  presetEntries: readonly string[],
): Promise<boolean> {
  const { state } = await loadWatchlistPortableState(db, chatId, "comparison");
  const currentDirect = state.direct.map(packWatchlistDirectState).sort();
  const currentPresets = state.presets.map(packWatchlistPresetState).sort();
  return JSON.stringify(currentDirect) === JSON.stringify([...directEntries].sort())
    && JSON.stringify(currentPresets) === JSON.stringify([...presetEntries].sort());
}
