import { deleteCache, getCache } from "../lib/db-cache";
import { executeAtomicBatch } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import {
  OVERFLOW_PLAN_CACHE_KEY,
  parseLegacyOverflowPlanBacklog,
  type OverflowPlannedSubscriberAlert,
} from "./dispatch-telegram-overflow";
import { formatPlannedSubscribers } from "./dispatch-telegram-routing";
import { hasEscalation } from "./dispatch-telegram-predicates";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import { listTelegramAlertItemKeys } from "./telegram-alert-event-lineage";
import {
  enqueueTelegramAuthoritativeTargets,
  finalizeTelegramTargetPlanning,
  materializeTelegramTargetPlanPage,
  openTelegramTargetPlanDelivery,
  type TelegramPlanningDecision,
  type TelegramTargetPlanningClaim,
} from "./telegram-alert-target-plans";

export const LEGACY_OVERFLOW_MAX_BYTES = 1_048_576;
export const LEGACY_OVERFLOW_IMPORT_PAGE_SIZE = 90;

export interface TelegramLegacyOverflowImportStatus {
  state: "absent" | "importing" | "imported" | "corrupt" | "oversized" | "degraded";
  digest: string | null;
  sourceEventId: string | null;
  observedBytes: number;
  observedPlanCount: number | null;
  importCursor: number;
  importedTargetCount: number;
  errorClass: string | null;
}

interface LegacyOverflowStateRow {
  state: TelegramLegacyOverflowImportStatus["state"];
  blob_digest: string | null;
  synthetic_source_event_id: string | null;
  observed_bytes: number;
  observed_plan_count: number | null;
  import_cursor: number;
  imported_target_count: number;
  last_error_class: string | null;
}

function mapStatus(row: LegacyOverflowStateRow): TelegramLegacyOverflowImportStatus {
  return {
    state: row.state,
    digest: row.blob_digest,
    sourceEventId: row.synthetic_source_event_id,
    observedBytes: Number(row.observed_bytes),
    observedPlanCount: row.observed_plan_count == null ? null : Number(row.observed_plan_count),
    importCursor: Number(row.import_cursor),
    importedTargetCount: Number(row.imported_target_count),
    errorClass: row.last_error_class,
  };
}

export async function loadTelegramLegacyOverflowImportStatus(
  db: D1Database,
): Promise<TelegramLegacyOverflowImportStatus | null> {
  const row = await db
    .prepare(
      `SELECT state, blob_digest, synthetic_source_event_id, observed_bytes,
              observed_plan_count, import_cursor, imported_target_count,
              last_error_class
         FROM telegram_legacy_overflow_state WHERE singleton = 1`,
    )
    .first<LegacyOverflowStateRow>();
  return row ? mapStatus(row) : null;
}

async function writeInvalidState(
  db: D1Database,
  state: "corrupt" | "oversized",
  digest: string,
  observedBytes: number,
  errorClass: string,
  nowSec: number,
): Promise<TelegramLegacyOverflowImportStatus> {
  await db
    .prepare(
      `INSERT INTO telegram_legacy_overflow_state (
         singleton, state, blob_digest, observed_bytes, last_error_class,
         observed_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         state = excluded.state, blob_digest = excluded.blob_digest,
         observed_bytes = excluded.observed_bytes,
         observed_plan_count = NULL, expected_item_count = NULL,
         synthetic_source_event_id = NULL, import_cursor = 0,
         imported_target_count = 0, last_error_class = excluded.last_error_class,
         observed_at = excluded.observed_at, updated_at = excluded.updated_at,
         imported_at = NULL`,
    )
    .bind(state, digest, observedBytes, errorClass.slice(0, 80), nowSec, nowSec)
    .run();
  return (await loadTelegramLegacyOverflowImportStatus(db))!;
}

function uniqueEvents<T extends { stablecoinId: string }>(events: readonly T[]): T[] {
  const byPayload = new Map<string, T>();
  for (const event of events) byPayload.set(JSON.stringify(event), event);
  return [...byPayload.values()];
}

function buildSyntheticEventPayload(plans: readonly OverflowPlannedSubscriberAlert[]): string {
  const alerts = plans.map((plan) => plan.entry.alerts);
  const dewsChanges = uniqueEvents(alerts.flatMap((entry) => entry.dews));
  const depegTriggered = uniqueEvents(alerts.flatMap((entry) => entry.depegTriggered));
  const depegResolved = uniqueEvents(alerts.flatMap((entry) => entry.depegResolved));
  const depegWorsening = uniqueEvents(alerts.flatMap((entry) => entry.depegWorsening));
  const safetyChanges = uniqueEvents(alerts.flatMap((entry) => entry.safety));
  const launchPromoted = uniqueEvents(alerts.flatMap((entry) => entry.launch));
  const reservePromoted = uniqueEvents(alerts.flatMap((entry) => entry.reserve));
  const ids = (events: readonly { stablecoinId: string }[]) =>
    [...new Set(events.map((event) => event.stablecoinId))].sort();
  return JSON.stringify({
    dewsChanges,
    depegTriggered,
    depegResolved,
    depegWorsening,
    safetyChanges,
    launchPromoted,
    reservePromoted,
    suppressedMethodologyChanges: 0,
    dewsIds: ids(dewsChanges),
    depegIds: ids([...depegTriggered, ...depegResolved, ...depegWorsening]),
    safetyIds: ids(safetyChanges),
    launchIds: ids(launchPromoted),
    reserveIds: ids(reservePromoted),
    legacySourceEventIds: [...new Set(plans.flatMap((plan) => plan.sourceEventId ? [plan.sourceEventId] : []))].sort(),
  });
}

const SYNTHETIC_BASELINE_JSON = JSON.stringify({
  dews: {},
  dewsAlertable: {},
  depeg: {},
  safety: {},
  launch: [],
  reserveDispatched: [],
});

async function initializeImport(args: {
  db: D1Database;
  digest: string;
  observedBytes: number;
  cacheUpdatedAt: number;
  plans: readonly OverflowPlannedSubscriberAlert[];
  nowSec: number;
}): Promise<{ sourceEventId: string; cursor: number }> {
  const sourceEventId = `telegram-source:legacy-overflow:v1:${args.digest.slice(0, 32)}`;
  const expectedItems = args.plans.reduce(
    (sum, plan) => sum + listTelegramAlertItemKeys(plan.entry.alerts).length,
    0,
  );
  await args.db
    .prepare(
      `INSERT INTO telegram_legacy_overflow_state (
         singleton, state, blob_digest, observed_bytes, observed_plan_count,
         expected_item_count, synthetic_source_event_id, import_cursor,
         imported_target_count, observed_at, updated_at
       ) VALUES (1, 'importing', ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         state = CASE WHEN blob_digest = excluded.blob_digest THEN state ELSE 'importing' END,
         blob_digest = excluded.blob_digest,
         observed_bytes = excluded.observed_bytes,
         observed_plan_count = excluded.observed_plan_count,
         expected_item_count = excluded.expected_item_count,
         synthetic_source_event_id = excluded.synthetic_source_event_id,
         import_cursor = CASE WHEN blob_digest = excluded.blob_digest THEN import_cursor ELSE 0 END,
         imported_target_count = CASE WHEN blob_digest = excluded.blob_digest THEN imported_target_count ELSE 0 END,
         last_error_class = CASE WHEN blob_digest = excluded.blob_digest THEN last_error_class ELSE NULL END,
         observed_at = excluded.observed_at, updated_at = excluded.updated_at,
         imported_at = CASE WHEN blob_digest = excluded.blob_digest THEN imported_at ELSE NULL END`,
    )
    .bind(
      args.digest,
      args.observedBytes,
      args.plans.length,
      expectedItems,
      sourceEventId,
      args.nowSec,
      args.nowSec,
    )
    .run();
  const state = await loadTelegramLegacyOverflowImportStatus(args.db);
  if (!state || state.digest !== args.digest) throw new Error("Telegram legacy overflow import state was not initialized");
  if (state.state !== "imported") {
    const detectedAt = Math.max(1, Math.min(args.cacheUpdatedAt, args.nowSec));
    const sourceExpiresAt = Math.max(
      args.nowSec + 1,
      ...args.plans.map((plan) => plan.expiresAt),
    );
    const lastChatId = args.plans.length > 0 ? args.plans[args.plans.length - 1].chatId : null;
    await args.db
      .prepare(
        `INSERT INTO telegram_alert_source_events (
           source_event_id, schema_version, status, detected_at, expires_at,
           event_payload, baseline_payload, target_plan_state,
           target_plan_generation, target_plan_owner, target_plan_started_at,
           subscriber_horizon_at, subscriber_high_water_chat_id,
           subscriber_cursor_chat_id, planning_cursor_chat_id
         ) VALUES (?, 1, 'planned', ?, ?, ?, ?, 'planning', 1, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(source_event_id) DO NOTHING`,
      )
      .bind(
        sourceEventId,
        detectedAt,
        sourceExpiresAt,
        buildSyntheticEventPayload(args.plans),
        SYNTHETIC_BASELINE_JSON,
        `legacy-import:${args.digest.slice(0, 32)}`,
        args.nowSec,
        detectedAt,
        lastChatId,
        lastChatId,
      )
      .run();
  }
  return { sourceEventId, cursor: state.importCursor };
}

function importClaim(
  sourceEventId: string,
  digest: string,
  plans: readonly OverflowPlannedSubscriberAlert[],
  nowSec: number,
): TelegramTargetPlanningClaim {
  const maximumTtl = plans.reduce(
    (maximum, plan) => Math.max(maximum, TELEGRAM_ALERT_TTL_SEC[plan.alertType]),
    1,
  );
  const lastChatId = plans.length > 0 ? plans[plans.length - 1].chatId : null;
  return {
    sourceEventId,
    owner: `legacy-import:${digest.slice(0, 32)}`,
    generation: 1,
    state: "planning",
    detectedAt: Math.max(1, nowSec - maximumTtl),
    expiresAt: Math.max(nowSec + 1, ...plans.map((plan) => plan.expiresAt)),
    horizonAt: nowSec,
    highWaterChatId: lastChatId,
    subscriberCursorChatId: lastChatId,
    planningCursorChatId: null,
  };
}

async function materializeImportPage(args: {
  db: D1Database;
  sourceEventId: string;
  digest: string;
  plans: readonly OverflowPlannedSubscriberAlert[];
  cursor: number;
  nowSec: number;
}): Promise<number> {
  const page = args.plans.slice(args.cursor, args.cursor + LEGACY_OVERFLOW_IMPORT_PAGE_SIZE);
  if (page.length === 0) return args.cursor;
  const resolveDisableNotification = (entry: (typeof page)[number]["entry"]): boolean =>
    !hasEscalation(entry.alerts) || isQuietHoursActive(
      args.nowSec,
      entry.quietHoursEnabled,
      entry.quietHoursStartUtc,
      entry.quietHoursEndUtc,
      entry.timezone,
    );
  const routed = formatPlannedSubscribers(
    page.map((plan) => ({ ...plan, sourceEventId: args.sourceEventId })),
    resolveDisableNotification,
  );
  const decisions: TelegramPlanningDecision[] = routed.map((target, index) => ({
    subscriber: {
      chatId: target.chatId,
      preferenceGeneration: target.preferenceGeneration ?? 0,
      lastActiveAt: target.lastActiveAt,
      initiallyEligible: true,
    },
    currentPreferenceGeneration: target.preferenceGeneration ?? 0,
    currentEligible: true,
    routed: [target],
    targetExpiresAt: page[index].expiresAt,
  }));
  await materializeTelegramTargetPlanPage(
    args.db,
    importClaim(args.sourceEventId, args.digest, args.plans, args.nowSec),
    Math.floor(args.cursor / LEGACY_OVERFLOW_IMPORT_PAGE_SIZE),
    decisions,
    args.nowSec,
  );
  const nextCursor = args.cursor + page.length;
  await args.db
    .prepare(
      `UPDATE telegram_legacy_overflow_state
          SET import_cursor = ?, updated_at = ?
        WHERE singleton = 1 AND state = 'importing' AND blob_digest = ? AND import_cursor = ?`,
    )
    .bind(nextCursor, args.nowSec, args.digest, args.cursor)
    .run();
  return nextCursor;
}

async function reconcileImportedBlob(args: {
  db: D1Database;
  sourceEventId: string;
  expectedPlans: number;
  expectedItems: number;
}): Promise<{ ok: boolean; targets: number }> {
  const counts = await args.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM telegram_alert_target_plans WHERE source_event_id = ?) AS plans,
         (SELECT COALESCE(SUM(expected_target_count), 0) FROM telegram_alert_target_plans
           WHERE source_event_id = ?) AS expected_targets,
         (SELECT COUNT(*) FROM telegram_alert_job_targets WHERE source_event_id = ?) AS targets,
         (SELECT COUNT(*) FROM telegram_alert_target_plan_items WHERE source_event_id = ?) AS items`,
    )
    .bind(args.sourceEventId, args.sourceEventId, args.sourceEventId, args.sourceEventId)
    .first<{ plans: number; expected_targets: number; targets: number; items: number }>();
  const targets = Number(counts?.targets ?? -1);
  return {
    ok: Number(counts?.plans ?? -1) === args.expectedPlans &&
      Number(counts?.expected_targets ?? -1) === targets &&
      Number(counts?.items ?? -1) === args.expectedItems,
    targets,
  };
}

export async function inspectAndImportLegacyOverflowBacklog(
  db: D1Database,
  nowSec: number,
): Promise<TelegramLegacyOverflowImportStatus> {
  const cached = await getCache(db, OVERFLOW_PLAN_CACHE_KEY);
  if (!cached) {
    const existing = await loadTelegramLegacyOverflowImportStatus(db);
    if (existing) return existing;
    await db
      .prepare(
        `INSERT INTO telegram_legacy_overflow_state (
           singleton, state, observed_at, updated_at
         ) VALUES (1, 'absent', ?, ?)`,
      )
      .bind(nowSec, nowSec)
      .run();
    return (await loadTelegramLegacyOverflowImportStatus(db))!;
  }

  const observedBytes = new TextEncoder().encode(cached.value).byteLength;
  const digest = await sha256Hex(cached.value);
  if (observedBytes > LEGACY_OVERFLOW_MAX_BYTES) {
    return writeInvalidState(db, "oversized", digest, observedBytes, "legacy_overflow_blob_oversized", nowSec);
  }
  const parsed = parseLegacyOverflowPlanBacklog(cached.value);
  if (parsed.kind === "invalid") {
    return writeInvalidState(db, "corrupt", digest, observedBytes, parsed.reason, nowSec);
  }
  try {
  const expectedItems = parsed.plans.reduce(
    (sum, plan) => sum + listTelegramAlertItemKeys(plan.entry.alerts).length,
    0,
  );
  const initialized = await initializeImport({
    db,
    digest,
    observedBytes,
    cacheUpdatedAt: cached.updatedAt,
    plans: parsed.plans,
    nowSec,
  });
  let state = (await loadTelegramLegacyOverflowImportStatus(db))!;
  if (state.state === "imported") {
    const reconciled = await reconcileImportedBlob({
      db,
      sourceEventId: initialized.sourceEventId,
      expectedPlans: parsed.plans.length,
      expectedItems,
    });
    if (!reconciled.ok) {
      return writeInvalidState(db, "corrupt", digest, observedBytes, "legacy_overflow_reappeared_mismatch", nowSec);
    }
    await deleteCache(db, OVERFLOW_PLAN_CACHE_KEY);
    return state;
  }

  let cursor = state.importCursor;
  if (cursor < parsed.plans.length) {
    cursor = await materializeImportPage({
      db,
      sourceEventId: initialized.sourceEventId,
      digest,
      plans: parsed.plans,
      cursor,
      nowSec,
    });
  }
  if (cursor >= parsed.plans.length) {
    const claim = importClaim(initialized.sourceEventId, digest, parsed.plans, nowSec);
    const source = await db
      .prepare("SELECT target_plan_state FROM telegram_alert_source_events WHERE source_event_id = ?")
      .bind(initialized.sourceEventId)
      .first<{ target_plan_state: string }>();
    if (source?.target_plan_state === "planning") await finalizeTelegramTargetPlanning(db, claim, nowSec);
    if (source?.target_plan_state === "ready" || (
      await db.prepare("SELECT target_plan_state FROM telegram_alert_source_events WHERE source_event_id = ?")
        .bind(initialized.sourceEventId).first<{ target_plan_state: string }>()
    )?.target_plan_state === "ready") {
      await openTelegramTargetPlanDelivery(db, claim, nowSec);
    }
    const current = await db
      .prepare("SELECT target_plan_state FROM telegram_alert_source_events WHERE source_event_id = ?")
      .bind(initialized.sourceEventId)
      .first<{ target_plan_state: string }>();
    if (current?.target_plan_state === "delivery_open") {
      await enqueueTelegramAuthoritativeTargets(db, initialized.sourceEventId, 1, nowSec);
    }
    const remaining = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM telegram_alert_job_targets
          WHERE source_event_id = ? AND status = 'planned'`,
      )
      .bind(initialized.sourceEventId)
      .first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      const reconciled = await reconcileImportedBlob({
        db,
        sourceEventId: initialized.sourceEventId,
        expectedPlans: parsed.plans.length,
        expectedItems,
      });
      if (!reconciled.ok) {
        return writeInvalidState(db, "corrupt", digest, observedBytes, "legacy_overflow_reconcile_failed", nowSec);
      }
      await executeAtomicBatch(db, [
        db
          .prepare(
            `UPDATE telegram_legacy_overflow_state
                SET state = 'imported', imported_target_count = ?,
                    last_error_class = NULL, updated_at = ?, imported_at = ?
              WHERE singleton = 1 AND blob_digest = ? AND import_cursor = ?`,
          )
          .bind(reconciled.targets, nowSec, nowSec, digest, parsed.plans.length),
        db
          .prepare(
            `UPDATE telegram_alert_source_events
                SET status = 'complete', baseline_committed_at = COALESCE(baseline_committed_at, ?),
                    completed_at = ?, last_error_class = NULL
              WHERE source_event_id = ? AND status = 'planned'`,
          )
          .bind(nowSec, nowSec, initialized.sourceEventId),
      ]);
      await deleteCache(db, OVERFLOW_PLAN_CACHE_KEY);
    }
  }
  state = (await loadTelegramLegacyOverflowImportStatus(db))!;
  return state;
  } catch {
    const current = await loadTelegramLegacyOverflowImportStatus(db);
    await db
      .prepare(
        `UPDATE telegram_legacy_overflow_state
            SET state = 'degraded',
                last_error_class = 'legacy_overflow_import_failed',
                updated_at = ?
          WHERE singleton = 1 AND blob_digest = ?`,
      )
      .bind(nowSec, digest)
      .run();
    if (current?.sourceEventId) {
      await db
        .prepare(
          `UPDATE telegram_alert_source_events
              SET target_plan_state = 'degraded',
                  last_error_class = 'legacy_overflow_import_failed',
                  last_attempt_at = ?
            WHERE source_event_id = ?`,
        )
        .bind(nowSec, current.sourceEventId)
        .run();
    }
    return (await loadTelegramLegacyOverflowImportStatus(db))!;
  }
}
