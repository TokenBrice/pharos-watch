import type { TelegramAlertType } from "@shared/types/status";
import { batchExecute, buildInClause, executeAtomicBatch, prepareMultiRowInsertStatements } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
  type TelegramPresetResolveOptions,
} from "../lib/telegram-presets";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";
import type { PresetSubscriberLoadResult } from "./dispatch-telegram-alerts-fanout";
import type { TelegramDispatchEvents } from "./dispatch-telegram-events";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import {
  buildTelegramSnapshotCacheEntries,
  type TelegramAlertSnapshots,
} from "./telegram-alert-snapshots";

const SOURCE_EVENT_SCHEMA_VERSION = 1;
const PRESET_PAGE_SIZE = 100;
const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;
type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];

const PRESET_ALERT_COLUMN: Record<PresetAlertType, string> = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
};

interface TelegramAlertSourceEventRow {
  source_event_id: string;
  schema_version: number;
  status: TelegramAlertSourceEventStatus;
  detected_at: number;
  expires_at: number;
  event_payload: string;
  baseline_payload: string;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error_class: string | null;
  baseline_committed_at: number | null;
  completed_at: number | null;
}

type TelegramAlertSourceEventStatus =
  | "resolving"
  | "planned"
  | "baseline_committed"
  | "complete"
  | "expired";

export interface TelegramAlertSourceEvent {
  sourceEventId: string;
  schemaVersion: 1;
  status: TelegramAlertSourceEventStatus;
  detectedAt: number;
  expiresAt: number;
  events: TelegramDispatchEvents;
  baseline: TelegramAlertSnapshots;
  attemptCount: number;
  lastAttemptAt: number | null;
  lastErrorClass: string | null;
  baselineCommittedAt: number | null;
  completedAt: number | null;
}

interface ResolutionPageRow {
  source_event_id: string;
  page_key: string;
  alert_type: PresetAlertType;
  page_index: number;
  cursor_chat_id: string | null;
  cursor_preset_id: string | null;
  memberships_resolved: number;
  status: "pending" | "complete" | "expired";
  attempt_count: number;
}

interface ResolutionTargetRow {
  preset_id: TelegramPresetId;
  chat_id: string;
}

interface CurrentResolutionTargetRow extends ResolutionTargetRow {
  alert_type: PresetAlertType;
  last_active_at: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
  preference_generation: number;
}

interface ResolutionMembershipRow {
  alert_type: PresetAlertType;
  preset_id: TelegramPresetId;
  stablecoin_id: string;
}

export interface TelegramAlertSourceResolution {
  presetResults: Record<PresetAlertType, PresetSubscriberLoadResult>;
  allComplete: boolean;
  pendingPages: number;
  pagesCompletedThisRun: number;
  queryFailures: number;
  resolutionFailures: number;
}

function parseEvents(payload: string): TelegramDispatchEvents {
  const value = JSON.parse(payload) as Partial<Record<keyof TelegramDispatchEvents, unknown>> | null;
  if (!value || typeof value !== "object") throw new Error("Telegram source event payload is not an object");
  const arrayKeys: Array<keyof TelegramDispatchEvents> = [
    "dewsChanges",
    "depegTriggered",
    "depegResolved",
    "depegWorsening",
    "safetyChanges",
    "launchPromoted",
    "reservePromoted",
    "dewsIds",
    "depegIds",
    "safetyIds",
    "launchIds",
    "reserveIds",
  ];
  if (arrayKeys.some((key) => !Array.isArray(value[key]))) {
    throw new Error("Telegram source event payload has an invalid event array");
  }
  if (typeof value.suppressedMethodologyChanges !== "number") {
    throw new Error("Telegram source event payload has invalid methodology metadata");
  }
  return value as unknown as TelegramDispatchEvents;
}

function parseBaseline(payload: string): TelegramAlertSnapshots {
  const value = JSON.parse(payload) as TelegramAlertSnapshots | null;
  if (!value || typeof value !== "object") throw new Error("Telegram source event baseline is not an object");
  if (
    !value.dews ||
    !value.dewsAlertable ||
    !value.depeg ||
    !Array.isArray(value.launch) ||
    !(Array.isArray(value.reserveDispatched) || value.reserveDispatched === null)
  ) {
    throw new Error("Telegram source event baseline has an invalid snapshot shape");
  }
  return value;
}

function mapSourceEvent(row: TelegramAlertSourceEventRow): TelegramAlertSourceEvent {
  if (row.schema_version !== SOURCE_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Telegram source event schema version ${row.schema_version}`);
  }
  return {
    sourceEventId: row.source_event_id,
    schemaVersion: 1,
    status: row.status,
    detectedAt: Number(row.detected_at),
    expiresAt: Number(row.expires_at),
    events: parseEvents(row.event_payload),
    baseline: parseBaseline(row.baseline_payload),
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
    lastErrorClass: row.last_error_class ?? null,
    baselineCommittedAt: row.baseline_committed_at == null ? null : Number(row.baseline_committed_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

function idsForType(events: TelegramDispatchEvents, type: PresetAlertType): string[] {
  if (type === "dews") return events.dewsIds;
  if (type === "depeg") return events.depegIds;
  return events.safetyIds;
}

function relevantAlertTypes(events: TelegramDispatchEvents): TelegramAlertType[] {
  const types: TelegramAlertType[] = [];
  if (events.dewsIds.length > 0) types.push("dews");
  if (events.depegIds.length > 0) types.push("depeg");
  if (events.safetyIds.length > 0) types.push("safety");
  if (events.launchIds.length > 0) types.push("launch");
  if (events.reserveIds.length > 0) types.push("reserve");
  return types;
}

function sourceExpiry(events: TelegramDispatchEvents, detectedAt: number): number {
  const ttls = relevantAlertTypes(events).map((type) => TELEGRAM_ALERT_TTL_SEC[type]);
  return detectedAt + Math.min(...ttls, TELEGRAM_ALERT_TTL_SEC.dews);
}

export async function buildTelegramAlertSourceEvent(args: {
  events: TelegramDispatchEvents;
  baseline: TelegramAlertSnapshots;
  detectedAt: number;
}): Promise<TelegramAlertSourceEvent> {
  const eventPayload = JSON.stringify(args.events);
  const baselinePayload = JSON.stringify(args.baseline);
  const digest = await sha256Hex(JSON.stringify({
    schemaVersion: SOURCE_EVENT_SCHEMA_VERSION,
    detectedAt: args.detectedAt,
    eventPayload,
    baselinePayload,
  }));
  return {
    sourceEventId: `telegram-source:v1:${digest.slice(0, 32)}`,
    schemaVersion: 1,
    status: "resolving",
    detectedAt: args.detectedAt,
    expiresAt: sourceExpiry(args.events, args.detectedAt),
    events: args.events,
    baseline: args.baseline,
    attemptCount: 0,
    lastAttemptAt: null,
    lastErrorClass: null,
    baselineCommittedAt: null,
    completedAt: null,
  };
}

export async function persistTelegramAlertSourceEvent(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  signal?: AbortSignal,
): Promise<TelegramAlertSourceEvent> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO telegram_alert_source_events (
           source_event_id, schema_version, status, detected_at, expires_at,
           event_payload, baseline_payload
         ) VALUES (?, ?, 'resolving', ?, ?, ?, ?)
         ON CONFLICT(source_event_id) DO NOTHING`,
      )
      .bind(
        source.sourceEventId,
        source.schemaVersion,
        source.detectedAt,
        source.expiresAt,
        JSON.stringify(source.events),
        JSON.stringify(source.baseline),
      ),
  ];
  for (const type of PRESET_ALERT_TYPES) {
    if (idsForType(source.events, type).length === 0) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO telegram_alert_source_resolution_pages (
             source_event_id, page_key, alert_type, page_index, memberships_resolved,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, 0, 0, 'pending', ?, ?)
           ON CONFLICT(source_event_id, page_key) DO NOTHING`,
        )
        .bind(source.sourceEventId, `${type}:0`, type, source.detectedAt, source.detectedAt),
    );
  }
  await executeAtomicBatch(db, statements, { signal });
  return source;
}

export async function loadTelegramAlertSourceEvent(
  db: D1Database,
  sourceEventId: string,
): Promise<TelegramAlertSourceEvent | null> {
  const row = await db
    .prepare(
      `SELECT source_event_id, schema_version, status, detected_at, expires_at,
              event_payload, baseline_payload, attempt_count, last_attempt_at,
              last_error_class, baseline_committed_at, completed_at
         FROM telegram_alert_source_events
        WHERE source_event_id = ?`,
    )
    .bind(sourceEventId)
    .first<TelegramAlertSourceEventRow>();
  return row ? mapSourceEvent(row) : null;
}

export async function loadOldestIncompleteTelegramAlertSourceEvent(
  db: D1Database,
): Promise<TelegramAlertSourceEvent | null> {
  const row = await db
    .prepare(
      `SELECT source_event_id, schema_version, status, detected_at, expires_at,
              event_payload, baseline_payload, attempt_count, last_attempt_at,
              last_error_class, baseline_committed_at, completed_at
         FROM telegram_alert_source_events
        WHERE status IN ('resolving', 'planned', 'baseline_committed')
        ORDER BY detected_at ASC, source_event_id ASC
        LIMIT 1`,
    )
    .first<TelegramAlertSourceEventRow>();
  return row ? mapSourceEvent(row) : null;
}

function mergePresetSubscriber(existing: SubscriberRow, additional: SubscriberRow): SubscriberRow {
  const existingStep = existing.depeg_worsening_bps_step;
  const additionalStep = additional.depeg_worsening_bps_step;
  return {
    ...existing,
    last_active_at: Math.max(existing.last_active_at, additional.last_active_at),
    depeg_worsening_bps_step:
      existingStep == null
        ? additionalStep
        : additionalStep == null
          ? existingStep
          : Math.min(existingStep, additionalStep),
  };
}

function addPresetSubscriber(
  map: Map<string, SubscriberRow[]>,
  stablecoinId: string,
  subscriber: SubscriberRow,
): void {
  const rows = map.get(stablecoinId) ?? [];
  const existingIndex = rows.findIndex((row) => row.chat_id === subscriber.chat_id);
  if (existingIndex === -1) rows.push(subscriber);
  else rows[existingIndex] = mergePresetSubscriber(rows[existingIndex], subscriber);
  map.set(stablecoinId, rows);
}

async function recordPageFailure(
  db: D1Database,
  page: ResolutionPageRow,
  nowSec: number,
  errorClass: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE telegram_alert_source_resolution_pages
            SET attempt_count = attempt_count + 1,
                updated_at = ?,
                last_error_class = ?
          WHERE source_event_id = ? AND page_key = ? AND status = 'pending'`,
      )
      .bind(nowSec, errorClass, page.source_event_id, page.page_key)
      .run();
  } catch {
    // The source event remains resolving, so a failed diagnostic write cannot
    // turn an incomplete page into completed work.
  }
}

async function resolveMemberships(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  page: ResolutionPageRow,
  nowSec: number,
  options: TelegramPresetResolveOptions,
): Promise<"ok" | "query-failed" | "resolution-failed"> {
  const alertColumn = PRESET_ALERT_COLUMN[page.alert_type];
  const presetIds = listTelegramPresets().map((preset) => preset.id);
  const presetClause = buildInClause(presetIds);
  let hasCandidates = false;
  try {
    const candidate = await db
      .prepare(
        `SELECT 1 AS has_row
           FROM telegram_preset_subscriptions p
           JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND p.preset_id IN (${presetClause.sql})
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          LIMIT 1`,
      )
      .bind(...presetClause.binds, nowSec)
      .first<{ has_row: number }>();
    hasCandidates = candidate != null;
  } catch (error) {
    await recordPageFailure(db, page, nowSec, "query_failed");
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset source page query failed",
      action: "preset-query",
      module: "telegram-alert-source-events",
      alertType: page.alert_type,
      failureKind: "query-failed",
      requestedStablecoinCount: idsForType(source.events, page.alert_type).length,
    });
    return "query-failed";
  }

  if (!hasCandidates) {
    await executeAtomicBatch(db, [
      db
        .prepare(
          `UPDATE telegram_alert_source_resolution_pages
              SET memberships_resolved = 1,
                  status = 'complete',
                  attempt_count = attempt_count + 1,
                  updated_at = ?,
                  completed_at = ?,
                  last_error_class = NULL
            WHERE source_event_id = ? AND page_key = ? AND status = 'pending'`,
        )
        .bind(nowSec, nowSec, source.sourceEventId, page.page_key),
    ]);
    return "ok";
  }

  const resolved = await resolveTelegramPresetTargets(db, presetIds, options);
  if (resolved.kind !== "ok") {
    await recordPageFailure(db, page, nowSec, "resolution_failed");
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset source page resolution failed",
      action: "preset-resolution",
      module: "telegram-alert-source-events",
      alertType: page.alert_type,
      failureKind: "resolution-failed",
      reason: resolved.reason,
      presetCount: presetIds.length,
      subscriberRowCount: 1,
      requestedStablecoinCount: idsForType(source.events, page.alert_type).length,
    });
    return "resolution-failed";
  }

  const wanted = new Set(idsForType(source.events, page.alert_type));
  const memberships = resolved.presets.flatMap((preset) =>
    preset.stablecoinIds
      .filter((stablecoinId) => wanted.has(stablecoinId))
      .map((stablecoinId) => [
        source.sourceEventId,
        page.alert_type,
        preset.definition.id,
        stablecoinId,
        nowSec,
      ] as const),
  );
  try {
    await batchExecute(db, [
      db
        .prepare(
          `DELETE FROM telegram_alert_source_resolution_memberships
            WHERE source_event_id = ? AND alert_type = ?`,
        )
        .bind(source.sourceEventId, page.alert_type),
      ...prepareMultiRowInsertStatements(
        db,
        `INSERT INTO telegram_alert_source_resolution_memberships (
           source_event_id, alert_type, preset_id, stablecoin_id, created_at
         )`,
        memberships,
      ),
    ]);
    await db
      .prepare(
        `UPDATE telegram_alert_source_resolution_pages
            SET memberships_resolved = 1,
                updated_at = ?,
                last_error_class = NULL
          WHERE source_event_id = ? AND page_key = ? AND status = 'pending'`,
      )
      .bind(nowSec, source.sourceEventId, page.page_key)
      .run();
    return "ok";
  } catch (error) {
    await recordPageFailure(db, page, nowSec, "persistence_failed");
    logTelegramEvent({
      level: "warn",
      message: "failed to persist normalized preset memberships",
      action: "preset-resolution-persist",
      module: "telegram-alert-source-events",
      alertType: page.alert_type,
    });
    return "query-failed";
  }
}

async function resolveFollowerPage(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  page: ResolutionPageRow,
  nowSec: number,
): Promise<"ok" | "query-failed"> {
  const membershipRows = await db
    .prepare(
      `SELECT DISTINCT preset_id
         FROM telegram_alert_source_resolution_memberships
        WHERE source_event_id = ? AND alert_type = ?
        ORDER BY preset_id ASC`,
    )
    .bind(source.sourceEventId, page.alert_type)
    .all<{ preset_id: TelegramPresetId }>();
  const presetIds = (membershipRows.results ?? []).map((row) => row.preset_id);
  if (presetIds.length === 0) {
    await db
      .prepare(
        `UPDATE telegram_alert_source_resolution_pages
            SET status = 'complete',
                attempt_count = attempt_count + 1,
                updated_at = ?,
                completed_at = ?,
                last_error_class = NULL
          WHERE source_event_id = ? AND page_key = ? AND status = 'pending'`,
      )
      .bind(nowSec, nowSec, source.sourceEventId, page.page_key)
      .run();
    return "ok";
  }

  const presetClause = buildInClause(presetIds);
  const cursorPredicate = page.cursor_chat_id == null || page.cursor_preset_id == null
    ? ""
    : `AND (
         preset.chat_id > ?
         OR (preset.chat_id = ? AND preset.preset_id > ?)
       )`;
  const cursorBinds = page.cursor_chat_id == null || page.cursor_preset_id == null
    ? []
    : [page.cursor_chat_id, page.cursor_chat_id, page.cursor_preset_id];
  const alertColumn = PRESET_ALERT_COLUMN[page.alert_type];
  let rows: ResolutionTargetRow[];
  try {
    const result = await db
      .prepare(
        `SELECT preset.chat_id,
                preset.preset_id,
                subscriber.last_active_at,
                preset.depeg_worsening_bps_step,
                subscriber.quiet_hours_enabled,
                subscriber.quiet_hours_start_utc,
                subscriber.quiet_hours_end_utc,
                subscriber.timezone
           FROM telegram_preset_subscriptions preset
           JOIN telegram_subscribers subscriber ON subscriber.chat_id = preset.chat_id
          WHERE preset.${alertColumn} = 1
            AND preset.preset_id IN (${presetClause.sql})
            AND (subscriber.alert_snooze_until_ts IS NULL OR subscriber.alert_snooze_until_ts <= ?)
            ${cursorPredicate}
          ORDER BY preset.chat_id ASC, preset.preset_id ASC
          LIMIT ?`,
      )
      .bind(...presetClause.binds, nowSec, ...cursorBinds, PRESET_PAGE_SIZE + 1)
      .all<ResolutionTargetRow>();
    rows = result.results ?? [];
  } catch (error) {
    await recordPageFailure(db, page, nowSec, "query_failed");
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset follower page query failed",
      action: "preset-query",
      module: "telegram-alert-source-events",
      alertType: page.alert_type,
    });
    return "query-failed";
  }

  const pageRows = rows.slice(0, PRESET_PAGE_SIZE);
  const hasMore = rows.length > PRESET_PAGE_SIZE;
  const last = pageRows[pageRows.length - 1];
  const targetValues = pageRows.map((row) => [
    source.sourceEventId,
    page.page_key,
    row.preset_id,
    row.chat_id,
    nowSec,
  ] as const);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM telegram_alert_source_resolution_targets
          WHERE source_event_id = ? AND page_key = ?`,
      )
      .bind(source.sourceEventId, page.page_key),
    ...prepareMultiRowInsertStatements(
      db,
      `INSERT INTO telegram_alert_source_resolution_targets (
         source_event_id, page_key, preset_id, chat_id, created_at
       )`,
      targetValues,
    ),
    db
      .prepare(
        `UPDATE telegram_alert_source_resolution_pages
            SET status = 'complete',
                attempt_count = attempt_count + 1,
                updated_at = ?,
                completed_at = ?,
                last_error_class = NULL
          WHERE source_event_id = ? AND page_key = ? AND status = 'pending'`,
      )
      .bind(nowSec, nowSec, source.sourceEventId, page.page_key),
  ];
  if (hasMore && last) {
    const nextIndex = page.page_index + 1;
    statements.push(
      db
        .prepare(
          `INSERT INTO telegram_alert_source_resolution_pages (
             source_event_id, page_key, alert_type, page_index,
             cursor_chat_id, cursor_preset_id, memberships_resolved,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)
           ON CONFLICT(source_event_id, page_key) DO NOTHING`,
        )
        .bind(
          source.sourceEventId,
          `${page.alert_type}:${nextIndex}`,
          page.alert_type,
          nextIndex,
          last.chat_id,
          last.preset_id,
          nowSec,
          nowSec,
        ),
    );
  }

  try {
    await executeAtomicBatch(db, statements);
    return "ok";
  } catch (error) {
    await recordPageFailure(db, page, nowSec, "persistence_failed");
    logTelegramEvent({
      level: "warn",
      message: "failed to persist normalized preset follower page",
      action: "preset-page-persist",
      module: "telegram-alert-source-events",
      alertType: page.alert_type,
    });
    return "query-failed";
  }
}

async function loadResolutionMaps(
  db: D1Database,
  sourceEventId: string,
  nowSec: number,
): Promise<Record<PresetAlertType, Map<string, SubscriberRow[]>>> {
  const [membershipResult, ...targetResults] = await Promise.all([
    db
      .prepare(
        `SELECT alert_type, preset_id, stablecoin_id
           FROM telegram_alert_source_resolution_memberships
          WHERE source_event_id = ?`,
      )
      .bind(sourceEventId)
      .all<ResolutionMembershipRow>(),
    ...PRESET_ALERT_TYPES.map((type) => {
      const alertColumn = PRESET_ALERT_COLUMN[type];
      return db
        .prepare(
          `SELECT page.alert_type,
                  target.preset_id,
                  target.chat_id,
                  subscriber.last_active_at,
                  NULL AS dews_min_band,
                  NULL AS safety_mode,
                  preset.depeg_worsening_bps_step,
                  subscriber.quiet_hours_enabled,
                  subscriber.quiet_hours_start_utc,
                  subscriber.quiet_hours_end_utc,
                  subscriber.timezone,
                  subscriber.preference_generation
             FROM telegram_alert_source_resolution_targets target
             JOIN telegram_alert_source_resolution_pages page
               ON page.source_event_id = target.source_event_id
              AND page.page_key = target.page_key
             JOIN telegram_preset_subscriptions preset
               ON preset.chat_id = target.chat_id
              AND preset.preset_id = target.preset_id
             JOIN telegram_subscribers subscriber
               ON subscriber.chat_id = target.chat_id
            WHERE target.source_event_id = ?
              AND page.status = 'complete'
              AND page.alert_type = ?
              AND preset.${alertColumn} = 1
              AND (subscriber.alert_snooze_until_ts IS NULL OR subscriber.alert_snooze_until_ts <= ?)`,
        )
        .bind(sourceEventId, type, nowSec)
        .all<CurrentResolutionTargetRow>();
    }),
  ]);

  const idsByPreset = new Map<string, string[]>();
  for (const row of membershipResult.results ?? []) {
    const key = `${row.alert_type}\0${row.preset_id}`;
    const ids = idsByPreset.get(key) ?? [];
    ids.push(row.stablecoin_id);
    idsByPreset.set(key, ids);
  }
  const maps: Record<PresetAlertType, Map<string, SubscriberRow[]>> = {
    dews: new Map(),
    depeg: new Map(),
    safety: new Map(),
  };
  for (const row of targetResults.flatMap((result) => result.results ?? [])) {
    const subscriber: SubscriberRow = {
      chat_id: row.chat_id,
      last_active_at: Number(row.last_active_at),
      dews_min_band: row.dews_min_band ?? null,
      safety_mode: row.safety_mode ?? null,
      depeg_worsening_bps_step: row.depeg_worsening_bps_step ?? null,
      quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
      quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
      quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
      timezone: row.timezone ?? null,
      preference_generation: row.preference_generation ?? 0,
      isGlobal: false,
      hasLocalOverride: false,
    };
    for (const stablecoinId of idsByPreset.get(`${row.alert_type}\0${row.preset_id}`) ?? []) {
      addPresetSubscriber(maps[row.alert_type], stablecoinId, subscriber);
    }
  }
  return maps;
}

export async function resolveTelegramAlertSourcePresetPages(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  nowSec: number,
  options: TelegramPresetResolveOptions = {},
): Promise<TelegramAlertSourceResolution> {
  const pendingResult = await db
    .prepare(
      `SELECT source_event_id, page_key, alert_type, page_index,
              cursor_chat_id, cursor_preset_id, memberships_resolved,
              status, attempt_count
         FROM telegram_alert_source_resolution_pages
        WHERE source_event_id = ? AND status = 'pending'
        ORDER BY alert_type ASC, page_index ASC`,
    )
    .bind(source.sourceEventId)
    .all<ResolutionPageRow>();

  let pagesCompletedThisRun = 0;
  let queryFailures = 0;
  let resolutionFailures = 0;
  const queryFailuresByType: Record<PresetAlertType, number> = { dews: 0, depeg: 0, safety: 0 };
  const resolutionFailuresByType: Record<PresetAlertType, number> = { dews: 0, depeg: 0, safety: 0 };
  for (const page of pendingResult.results ?? []) {
    let membershipOutcome: "ok" | "query-failed" | "resolution-failed" = "ok";
    if (page.memberships_resolved !== 1) {
      membershipOutcome = await resolveMemberships(db, source, page, nowSec, options);
    }
    if (membershipOutcome === "query-failed") {
      queryFailures += 1;
      queryFailuresByType[page.alert_type] += 1;
      continue;
    }
    if (membershipOutcome === "resolution-failed") {
      resolutionFailures += 1;
      resolutionFailuresByType[page.alert_type] += 1;
      continue;
    }
    const followerOutcome = await resolveFollowerPage(db, source, page, nowSec);
    if (followerOutcome === "query-failed") {
      queryFailures += 1;
      queryFailuresByType[page.alert_type] += 1;
    } else {
      pagesCompletedThisRun += 1;
    }
  }

  const pendingRow = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM telegram_alert_source_resolution_pages
        WHERE source_event_id = ? AND status = 'pending'`,
    )
    .bind(source.sourceEventId)
    .first<{ count: number }>();
  const pendingPages = Number(pendingRow?.count ?? 0);
  const maps = await loadResolutionMaps(db, source.sourceEventId, nowSec);
  const familyHasPending = new Set<PresetAlertType>();
  if (pendingPages > 0) {
    const pendingFamilies = await db
      .prepare(
        `SELECT DISTINCT alert_type
           FROM telegram_alert_source_resolution_pages
          WHERE source_event_id = ? AND status = 'pending'`,
      )
      .bind(source.sourceEventId)
      .all<{ alert_type: PresetAlertType }>();
    for (const row of pendingFamilies.results ?? []) familyHasPending.add(row.alert_type);
  }
  const resultFor = (type: PresetAlertType): PresetSubscriberLoadResult =>
    familyHasPending.has(type)
      ? {
          kind: "partial",
          rows: maps[type],
          queryFailures: queryFailuresByType[type],
          resolutionFailures: resolutionFailuresByType[type],
        }
      : { kind: "ok", rows: maps[type] };

  const lastErrorClass = resolutionFailures > 0
    ? "preset_resolution_failed"
    : queryFailures > 0
      ? "preset_query_failed"
      : pendingPages > 0
        ? "preset_pages_pending"
        : null;
  await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET attempt_count = attempt_count + 1,
              last_attempt_at = ?,
              last_error_class = ?
        WHERE source_event_id = ? AND status IN ('resolving', 'planned', 'baseline_committed')`,
    )
    .bind(nowSec, lastErrorClass, source.sourceEventId)
    .run();

  return {
    presetResults: {
      dews: resultFor("dews"),
      depeg: resultFor("depeg"),
      safety: resultFor("safety"),
    },
    allComplete: pendingPages === 0,
    pendingPages,
    pagesCompletedThisRun,
    queryFailures,
    resolutionFailures,
  };
}

export async function markTelegramAlertSourceEventPlanned(
  db: D1Database,
  sourceEventId: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET status = 'planned',
              last_attempt_at = ?,
              last_error_class = NULL
        WHERE source_event_id = ? AND status = 'resolving'`,
    )
    .bind(nowSec, sourceEventId)
    .run();
}

export async function commitTelegramAlertSourceBaseline(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (source.status === "baseline_committed") return;
  const cacheStatement = db.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const statements = buildTelegramSnapshotCacheEntries(source.baseline).map((entry) =>
    cacheStatement.bind(entry.key, entry.value, nowSec),
  );
  statements.push(
    db
      .prepare(
        `UPDATE telegram_alert_source_events
            SET status = 'baseline_committed',
                baseline_committed_at = ?,
                last_error_class = NULL
          WHERE source_event_id = ? AND status IN ('resolving', 'planned')`,
      )
      .bind(nowSec, source.sourceEventId),
  );
  await executeAtomicBatch(db, statements, { signal });
}

/**
 * Expiry is a terminal, visible decision: advance the exact stored baseline so
 * newer producer diffs can proceed, expire untouched target/page work, and
 * retain all normalized rows for the normal audit-retention window.
 */
export async function expireTelegramAlertSourceEvent(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const cacheStatement = db.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const statements = buildTelegramSnapshotCacheEntries(source.baseline).map((entry) =>
    cacheStatement.bind(entry.key, entry.value, nowSec),
  );
  statements.push(
    db
      .prepare(
        `UPDATE telegram_alert_source_resolution_pages
            SET status = 'expired',
                updated_at = ?,
                last_error_class = COALESCE(last_error_class, 'source_event_expired')
          WHERE source_event_id = ? AND status = 'pending'`,
      )
      .bind(nowSec, source.sourceEventId),
    db
      .prepare(
        `UPDATE telegram_alert_job_targets
            SET status = 'expired',
                failed_at = COALESCE(failed_at, ?),
                error_class = COALESCE(error_class, 'source_event_expired')
          WHERE job_id IN (
            SELECT job_id FROM telegram_alert_jobs WHERE source_event_id = ?
          )
            AND status = 'planned'
            AND effect_state IN ('unstarted', 'claimed')`,
      )
      .bind(nowSec, source.sourceEventId),
    db
      .prepare(
        `UPDATE telegram_alert_jobs
            SET status = 'expired'
          WHERE source_event_id = ?
            AND status IN ('discovered', 'queued', 'degraded')`,
      )
      .bind(source.sourceEventId),
    db
      .prepare(
        `UPDATE telegram_alert_source_events
            SET status = 'expired',
                baseline_committed_at = COALESCE(baseline_committed_at, ?),
                completed_at = ?,
                last_attempt_at = ?,
                last_error_class = 'source_event_expired'
          WHERE source_event_id = ? AND status IN ('resolving', 'planned')`,
      )
      .bind(nowSec, nowSec, nowSec, source.sourceEventId),
  );
  await executeAtomicBatch(db, statements, { signal });
}

export async function completeTelegramAlertSourceEvent(
  db: D1Database,
  sourceEventId: string,
  nowSec: number,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET status = 'complete',
              completed_at = ?,
              last_error_class = NULL
        WHERE source_event_id = ? AND status = 'baseline_committed'`,
    )
    .bind(nowSec, sourceEventId)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    const row = await db
      .prepare("SELECT status FROM telegram_alert_source_events WHERE source_event_id = ?")
      .bind(sourceEventId)
      .first<{ status: TelegramAlertSourceEventStatus }>();
    if (row?.status !== "complete") {
      throw new Error("Telegram source event completed before its baseline was committed");
    }
  }
}
