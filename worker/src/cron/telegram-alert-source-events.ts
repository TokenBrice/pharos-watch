import type { TelegramAlertType } from "@shared/types/status";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { executeAtomicBatch } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram/constants";
import { parseJson } from "../lib/json-parse";
import type { TelegramDispatchEvents } from "./dispatch-telegram-events";
import { PRESET_ALERT_TYPES, type PresetAlertType } from "./telegram-preset-subscriber-store";
import {
  buildTelegramSnapshotCacheEntries,
  type TelegramAlertSnapshots,
} from "./telegram-alert-snapshots";
import { alertSafetyIdentitiesAreComparable } from "../lib/alert-safety-source-cache";

const SOURCE_EVENT_SCHEMA_VERSION = 1;

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

function parseEvents(
  payload: string,
  fallbackSafetyIdentity: SafetyScorePublicationIdentity | null,
): TelegramDispatchEvents {
  const parsed = parseJson(payload);
  if (!parsed.ok) throw new Error("Telegram source event payload is invalid JSON");
  const value = parsed.value as Partial<Record<keyof TelegramDispatchEvents, unknown>> | null;
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
  const parsedIdentity = value.safetyScoreIdentity == null
    ? null
    : SafetyScorePublicationIdentitySchema.safeParse(value.safetyScoreIdentity);
  if (parsedIdentity && !parsedIdentity.success) {
    throw new Error("Telegram source event payload has invalid safety identity");
  }
  return {
    ...(value as unknown as TelegramDispatchEvents),
    safetyScoreIdentity: parsedIdentity?.data ?? fallbackSafetyIdentity,
  };
}

function parseBaseline(payload: string): TelegramAlertSnapshots {
  const parsed = parseJson(payload);
  if (!parsed.ok) throw new Error("Telegram source event baseline is invalid JSON");
  const value = parsed.value as TelegramAlertSnapshots | null;
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
  const baseline = parseBaseline(row.baseline_payload);
  return {
    sourceEventId: row.source_event_id,
    schemaVersion: 1,
    status: row.status,
    detectedAt: Number(row.detected_at),
    expiresAt: Number(row.expires_at),
    events: parseEvents(
      row.event_payload,
      baseline.safety?.safetyScoreIdentity ?? null,
    ),
    baseline,
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
    lastErrorClass: row.last_error_class ?? null,
    baselineCommittedAt: row.baseline_committed_at == null ? null : Number(row.baseline_committed_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

export function idsForType(events: TelegramDispatchEvents, type: PresetAlertType): string[] {
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
  if (args.events.safetyIds.length > 0 && args.events.safetyScoreIdentity == null) {
    throw new Error("Telegram safety source event requires an exact Safety Score identity");
  }
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

/**
 * Removes stale safety work from an in-flight durable source event at a model,
 * policy, methodology, or build boundary. Other alert families and their
 * immutable membership resolution continue from the same source event.
 */
export function suppressIncomparableTelegramSafetySourceEvent(
  source: TelegramAlertSourceEvent,
  currentSafety: TelegramAlertSnapshots["safety"],
): TelegramAlertSourceEvent {
  if (source.events.safetyIds.length === 0) return source;
  const sourceIdentity = source.events.safetyScoreIdentity ?? null;
  const currentIdentity = currentSafety?.safetyScoreIdentity ?? null;
  if (
    sourceIdentity &&
    currentIdentity &&
    alertSafetyIdentitiesAreComparable(sourceIdentity, currentIdentity)
  ) {
    return source;
  }
  return {
    ...source,
    events: {
      ...source.events,
      safetyChanges: [],
      safetyIds: [],
      safetyScoreIdentity: null,
    },
    baseline: {
      ...source.baseline,
      safety: currentSafety ?? null,
    },
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

function buildBaselineAdvanceStatements(
  db: D1Database,
  baseline: TelegramAlertSnapshots,
  nowSec: number,
): D1PreparedStatement[] {
  const cacheStatement = db.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  return buildTelegramSnapshotCacheEntries(baseline).map((entry) =>
    cacheStatement.bind(entry.key, entry.value, nowSec)
  );
}

export async function commitTelegramAlertSourceBaseline(
  db: D1Database,
  source: TelegramAlertSourceEvent,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (source.status === "baseline_committed") return;
  const statements = buildBaselineAdvanceStatements(db, source.baseline, nowSec);
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
  const statements = buildBaselineAdvanceStatements(db, source.baseline, nowSec);
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
          WHERE source_event_id = ? AND status IN ('resolving', 'planned', 'baseline_committed')`,
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
