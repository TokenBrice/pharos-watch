import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TRACKED_META_BY_ID, ACTIVE_IDS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import type { TelegramDispatchCronResult } from "@shared/types";
import { throwIfAborted } from "../lib/abort";
import { readCachedJson } from "../lib/api-utils";
import { getCache, setCache } from "../lib/db-cache";
import { buildInClause } from "../lib/db";

import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  isDewsAlertable,
  isDewsDeescalation,
  type ConsolidatedAlerts,
  type DepegAlertPayload,
  type DepegResolved,
  type DepegWorsening,
  type SafetyChange,
} from "../lib/telegram-alerts";
import { resolveTelegramPresetTargets, type TelegramPresetId } from "../lib/telegram-presets";
import { buildAlertContextLines } from "../api/telegram-webhook-insights";
import {
  SNAPSHOT_KEYS,
  isSafetyDeescalation,
  writeSnapshots,
} from "./telegram-alert-snapshots";
import {
  buildDewsChanges,
  buildLaunchPromotions,
  buildSafetyChanges,
} from "./telegram-alert-changes";
import {
  buildDispatchSnapshotState,
  loadDispatchSourceData,
} from "./dispatch-telegram-state";
import {
  drainPendingQueue,
  cleanupExpiredPendingAlerts,
  loadChatsInBackoff,
  readPendingCapacitySnapshot,
  readTelegramGlobalBackoff,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "./telegram-pending-queue";
import {
  buildSubscriberQueue,
  emptyPerAlertTypeDelivery,
  routeAlertEvents,
  type AlertsByChatEntry,
  type SubscriberRow,
} from "./dispatch-telegram-routing";
import { deliverTelegramSubscriberQueue } from "./dispatch-telegram-delivery";
import {
  finalizeTelegramAlertJobManifests,
  persistTelegramAlertJobManifests,
} from "./telegram-alert-jobs";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import { logTelegramEvent } from "../lib/telegram-log";
import { TELEGRAM_MAX_MESSAGES_PER_RUN } from "../lib/telegram-constants";

type PerAlertTypeTargets = Record<AlertType, { chats: number; chunks: number }>;

interface DispatchCapacityMetadata {
  freshCandidateChats: number;
  freshCandidateCount: number;
  freshOverflow: number;
  pendingSent: number;
  pendingTotal: number;
  pendingDue: number;
  pendingDeferredCount: number;
  pendingExpiredCount: number;
  pendingNearTtlCount: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  pendingDrainBudgetPerRun: number;
  pendingCapacityBefore: Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
  pendingCapacityAfter: Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
  perAlertTypeTargets: PerAlertTypeTargets;
  fanoutQueryMs: number;
  fanoutBuildMs: number;
  fanoutTotalMs: number;
}

type DispatchResult = TelegramDispatchCronResult & DispatchCapacityMetadata;

const MAX_MESSAGES_PER_RUN = TELEGRAM_MAX_MESSAGES_PER_RUN;
const GLOBAL_SAFETY_MIN_SCORE_DROP = 3;
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

const ALERT_COLUMN_BY_TYPE = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
  launch: "alert_launch",
} as const;

const GLOBAL_ALERT_COLUMN_BY_TYPE = {
  dews: "global_alert_dews",
  depeg: "global_alert_depeg",
  safety: "global_alert_safety",
  launch: "global_alert_launch",
} as const;
const VALID_ALERT_COLUMNS = new Set(Object.values(ALERT_COLUMN_BY_TYPE));
const VALID_GLOBAL_ALERT_COLUMNS = new Set(Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE));

type AlertType = keyof typeof ALERT_COLUMN_BY_TYPE;
type LoadedSubscriberRow = Omit<SubscriberRow, "isGlobal"> & { stablecoin_id: string };

function emptyPerAlertTypeTargets(): PerAlertTypeTargets {
  return {
    dews: { chats: 0, chunks: 0 },
    depeg: { chats: 0, chunks: 0 },
    safety: { chats: 0, chunks: 0 },
    launch: { chats: 0, chunks: 0 },
  };
}

function buildPerAlertTypeTargets(
  subscriberQueue: Array<{ alertType: AlertType; chunks: string[] }>,
): PerAlertTypeTargets {
  const targets = emptyPerAlertTypeTargets();
  for (const sub of subscriberQueue) {
    targets[sub.alertType].chats += 1;
    targets[sub.alertType].chunks += sub.chunks.length;
  }
  return targets;
}

function emptyPendingCapacity() {
  return {
    total: 0,
    active: 0,
    due: 0,
    deferred: 0,
    expired: 0,
    nearTtl: 0,
    oldestPendingAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    dispatchIntervalSec: 5 * 60,
  } satisfies Awaited<ReturnType<typeof readPendingCapacitySnapshot>>;
}

function emptyResult(snapshotSeeded: boolean, chatsWithActiveSnooze = 0): DispatchResult {
  return {
    eventsDetected: {
      dews: 0,
      depeg: 0,
      depegTriggered: 0,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 0,
      launch: 0,
      suppressedMethodologyChanges: 0,
    },
    subscribersNotified: 0,
    messagesSent: 0,
    blockedUsersCleanedUp: 0,
    blockedUsersCleanupFailed: 0,
    cappedAtLimit: false,
    snapshotSeeded,
    pendingAttempted: 0,
    pendingDrained: 0,
    pendingRetryQueued: 0,
    pendingDropped: 0,
    pendingDroppedTtlExpired: 0,
    pendingDroppedPermanentFailure: 0,
    pendingDroppedMaxAttemptsFallback: 0,
    pendingDeferred: 0,
    pendingRateLimited: false,
    pendingRetryAfterSec: null,
    pendingEnqueued: 0,
    pendingExpired: 0,
    pendingSent: 0,
    pendingTotal: 0,
    pendingDue: 0,
    pendingDeferredCount: 0,
    pendingExpiredCount: 0,
    pendingNearTtlCount: 0,
    oldestPendingAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    pendingDrainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    pendingCapacityBefore: emptyPendingCapacity(),
    pendingCapacityAfter: emptyPendingCapacity(),
    freshAttempted: 0,
    freshSent: 0,
    freshRetryQueued: 0,
    freshPermanentFailures: 0,
    freshDeferredPerChat: 0,
    freshCandidateChats: 0,
    freshCandidateCount: 0,
    freshOverflow: 0,
    chatsWithActiveSnooze,
    safetyAlertSourceState: "missing",
    safetyAlertSourceAgeSeconds: null,
    safetyAlertsSuppressed: true,
    safetyAlertSourceGeneration: null,
    presetQueryFailures: 0,
    presetResolutionFailures: 0,
    presetFailure: false,
    perAlertType: emptyPerAlertTypeDelivery(),
    perAlertTypeTargets: emptyPerAlertTypeTargets(),
    fanoutQueryMs: 0,
    fanoutBuildMs: 0,
    fanoutTotalMs: 0,
    suppressedSafetyChangesAtSeed: 0,
  };
}

async function readPresetFailureCount(db: D1Database): Promise<number> {
  try {
    const cached = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
    if (!cached) return 0;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

async function writePresetFailureCount(db: D1Database, value: number): Promise<void> {
  try {
    await setCache(db, PRESET_QUERY_FAILURE_CACHE_KEY, String(Math.max(0, Math.floor(value))));
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "failed to persist preset failure count",
      action: "write-preset-failure-count",
      module: "dispatch-telegram-alerts",
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function getSymbol(stablecoinId: string, fallback?: string): string {
  return TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? fallback ?? stablecoinId;
}

function hasEscalation(alerts: ConsolidatedAlerts): boolean {
  return (
    alerts.dews.some((change) => !isDewsDeescalation(change.oldBand, change.newBand)) ||
    alerts.depegTriggered.length > 0 ||
    alerts.depegWorsening.length > 0 ||
    alerts.safety.some((change) => !isSafetyDeescalation(change.oldGrade, change.newGrade))
  );
}

function meetsDewsThreshold(newBand: string, minBand: string | null): boolean {
  if (!isDewsAlertable(newBand)) return false;
  if (!minBand || !isThreatBand(minBand) || !isThreatBand(newBand)) return true;
  return THREAT_BAND_ORDER[newBand] >= THREAT_BAND_ORDER[minBand];
}

function shouldIncludeSafetyChange(change: SafetyChange, mode: string | null): boolean {
  if (!mode || mode === "all") return true;
  if (mode === "downgrade-only") return !isSafetyDeescalation(change.oldGrade, change.newGrade);
  if (mode === "upgrade-only") return isSafetyDeescalation(change.oldGrade, change.newGrade);
  return true;
}

function isMaterialSafetyDowngrade(change: SafetyChange): boolean {
  if (isSafetyDeescalation(change.oldGrade, change.newGrade)) return false;
  if (change.oldScore != null && change.newScore != null) {
    return change.oldScore - change.newScore >= GLOBAL_SAFETY_MIN_SCORE_DROP;
  }
  return true;
}

function crossesDepegWorseningStep(
  previousDeviationBps: number,
  currentDeviationBps: number,
  step: number | null,
): boolean {
  if (step == null || step <= 0 || currentDeviationBps <= previousDeviationBps) return false;
  return Math.floor(previousDeviationBps / step) < Math.floor(currentDeviationBps / step);
}

function meetsDepegStepThreshold(deviationBps: number, step: number | null): boolean {
  if (step == null || step <= 0) return true;
  return deviationBps >= step;
}

async function loadSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: AlertType,
): Promise<Map<string, SubscriberRow[]>> {
  if (stablecoinIds.length === 0) return new Map();
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid alert subscription column for ${type}`);
  }
  const placeholders = stablecoinIds.map(() => "?").join(",");
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
      // against the hardcoded allowlist above before interpolation.
      `SELECT sub.stablecoin_id,
              sub.chat_id,
              u.last_active_at,
              sub.dews_min_band,
              sub.safety_mode,
              sub.depeg_worsening_bps_step,
              u.quiet_hours_enabled,
              u.quiet_hours_start_utc,
              u.quiet_hours_end_utc,
              u.timezone
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (${placeholders})
          AND sub.${alertColumn} = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
    )
    .bind(...stablecoinIds, nowSec, nowSec)
    .all<LoadedSubscriberRow>();

  const map = new Map<string, SubscriberRow[]>();
  for (const row of result.results ?? []) {
    const existing = map.get(row.stablecoin_id) ?? [];
    existing.push({
      chat_id: row.chat_id,
      last_active_at: row.last_active_at,
      dews_min_band: row.dews_min_band ?? null,
      safety_mode: row.safety_mode ?? null,
      depeg_worsening_bps_step: row.depeg_worsening_bps_step ?? null,
      quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
      quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
      quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
      timezone: row.timezone ?? null,
      isGlobal: false,
    });
    map.set(row.stablecoin_id, existing);
  }
  return map;
}

async function loadGlobalSubscriberRows(
  db: D1Database,
  type: AlertType,
): Promise<SubscriberRow[]> {
  const alertColumn = GLOBAL_ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_GLOBAL_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid global alert subscription column for ${type}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      // SAFETY: alertColumn comes from GLOBAL_ALERT_COLUMN_BY_TYPE and is
      // validated against the hardcoded allowlist above before interpolation.
      `SELECT chat_id,
              last_active_at,
              quiet_hours_enabled,
              quiet_hours_start_utc,
              quiet_hours_end_utc,
              timezone,
              global_depeg_worsening_bps_step
         FROM telegram_subscribers
        WHERE ${alertColumn} = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
    )
    .bind(nowSec)
    .all<SubscriberRow>();

  return (result.results ?? []).map((row) => ({
    chat_id: row.chat_id,
    last_active_at: row.last_active_at,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: row.global_depeg_worsening_bps_step ?? null,
    quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
    quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
    quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
    timezone: row.timezone ?? null,
    isGlobal: true,
  }));
}

/**
 * Load active per-coin snoozes for the supplied stablecoins. Returns
 * `Map<stablecoinId, Set<chatId>>` so the routing pass can suppress global
 * subscriptions for any coin a chat has already snoozed locally (P1-U10).
 * Specific subscription rows are already filtered out by the per-type
 * subscriber-row query.
 */
async function loadPerCoinSnoozeMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const unique = Array.from(new Set(stablecoinIds));
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(",");
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `SELECT stablecoin_id, chat_id
         FROM telegram_subscriptions
        WHERE stablecoin_id IN (${placeholders})
          AND alert_snooze_until_ts IS NOT NULL
          AND alert_snooze_until_ts > ?`,
    )
    .bind(...unique, nowSec)
    .all<{ stablecoin_id: string; chat_id: string }>();
  for (const row of result.results ?? []) {
    const existing = map.get(row.stablecoin_id) ?? new Set<string>();
    existing.add(row.chat_id);
    map.set(row.stablecoin_id, existing);
  }
  return map;
}

function mergeSubscriberMaps(
  base: Map<string, SubscriberRow[]>,
  additional: Map<string, SubscriberRow[]>,
): Map<string, SubscriberRow[]> {
  for (const [stablecoinId, rows] of additional) {
    const existing = base.get(stablecoinId) ?? [];
    const seenChats = new Set(existing.map((row) => row.chat_id));
    for (const row of rows) {
      if (seenChats.has(row.chat_id)) continue;
      seenChats.add(row.chat_id);
      existing.push(row);
    }
    base.set(stablecoinId, existing);
  }
  return base;
}

type PresetSubscriberLoadResult =
  | { kind: "ok"; rows: Map<string, SubscriberRow[]> }
  | { kind: "query-failed"; error: unknown }
  | { kind: "resolution-failed" };

async function loadPresetSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: AlertType,
): Promise<PresetSubscriberLoadResult> {
  if (stablecoinIds.length === 0 || type === "launch") return { kind: "ok", rows: new Map() };
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid preset alert subscription column for ${type}`);
  }
  let result: {
    results?: Array<{
      chat_id: string;
      preset_id: TelegramPresetId;
      last_active_at: number;
      depeg_worsening_bps_step: number | null;
      quiet_hours_enabled: number | null;
      quiet_hours_start_utc: number | null;
      quiet_hours_end_utc: number | null;
      timezone: string | null;
    }>;
  };
  try {
    result = await db
      .prepare(
        // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
        // against the hardcoded allowlist above before interpolation.
        `SELECT p.chat_id,
                p.preset_id,
                u.last_active_at,
                p.depeg_worsening_bps_step,
                u.quiet_hours_enabled,
                u.quiet_hours_start_utc,
                u.quiet_hours_end_utc,
                u.timezone
           FROM telegram_preset_subscriptions p
           JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`,
      )
      .bind(Math.floor(Date.now() / 1000))
      .all<{
        chat_id: string;
        preset_id: TelegramPresetId;
        last_active_at: number;
        depeg_worsening_bps_step: number | null;
        quiet_hours_enabled: number | null;
        quiet_hours_start_utc: number | null;
        quiet_hours_end_utc: number | null;
        timezone: string | null;
      }>();
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset query failed",
      action: "preset-query",
      module: "dispatch-telegram-alerts",
      err: err instanceof Error ? err.message : String(err),
    });
    return { kind: "query-failed", error: err };
  }

  const rows = result.results ?? [];
  if (rows.length === 0) return { kind: "ok", rows: new Map() };

  const presetIds = Array.from(new Set(rows.map((row) => row.preset_id)));
  const resolved = await resolveTelegramPresetTargets(db, presetIds);
  if (resolved.kind !== "ok") return { kind: "resolution-failed" };
  const idsByPreset = new Map(resolved.presets.map((preset) => [preset.definition.id, new Set(preset.stablecoinIds)]));
  const wantedIds = new Set(stablecoinIds);
  const map = new Map<string, SubscriberRow[]>();
  for (const row of rows) {
    const presetIdsForRow = idsByPreset.get(row.preset_id);
    if (!presetIdsForRow) continue;
    for (const stablecoinId of presetIdsForRow) {
      if (!wantedIds.has(stablecoinId)) continue;
      const existing = map.get(stablecoinId) ?? [];
      existing.push({
        chat_id: row.chat_id,
        last_active_at: row.last_active_at,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: row.depeg_worsening_bps_step ?? null,
        quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
        quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
        quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
        timezone: row.timezone ?? null,
        isGlobal: false,
      });
      map.set(stablecoinId, existing);
    }
  }
  return { kind: "ok", rows: map };
}

export async function dispatchTelegramAlerts(db: D1Database, botToken: string, signal?: AbortSignal): Promise<{ itemCount: number; metadata: string }> {
  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
  if (!allowed) {
    return { itemCount: 0, metadata: JSON.stringify({ skipped: "circuit-open" }) };
  }

  const dispatchStartedAtMs = Date.now();

  try {
    throwIfAborted(signal);

    const sourceData = await loadDispatchSourceData(db);
    const { chatsWithActiveSnooze, dewsRows, activeDepegRows } = sourceData;

    throwIfAborted(signal);

    const nowSec = Math.floor(Date.now() / 1000);
    const snapshotState = buildDispatchSnapshotState(sourceData, nowSec);
    const {
      currentSafetySnapshot,
      currentSnapshots,
      mustSeedSnapshots,
      previousSafetySnapshot,
      safeDepegSnapshot,
      safeDewsAlertable,
      safeDewsSnapshot,
      safeSafetySnapshot,
      safetySnapshotNeedsSeed,
      safetySourceAssessment,
    } = snapshotState;

    // When the Telegram lane has to reseed its safety snapshot (e.g. methodology
    // version flip changed the source generation), real downgrades against the
    // last seen snapshot would silently disappear. Count them against the prior
    // snapshot purely for operator visibility — they are not fanned out.
    const suppressedSafetyChangesAtSeed = safetySnapshotNeedsSeed
      ? buildSafetyChanges(currentSafetySnapshot, previousSafetySnapshot ?? {}, getSymbol).changes.length
      : 0;
    const pendingCapacityBefore = await readPendingCapacitySnapshot(db, nowSec);

    if (mustSeedSnapshots) {
      await writeSnapshots(db, currentSnapshots);
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
      const result = emptyResult(true, chatsWithActiveSnooze);
      result.pendingCapacityBefore = pendingCapacityBefore;
      result.pendingCapacityAfter = pendingCapacityBefore;
      result.pendingTotal = pendingCapacityBefore.active;
      result.pendingDue = pendingCapacityBefore.due;
      result.pendingDeferredCount = pendingCapacityBefore.deferred;
      result.pendingExpiredCount = pendingCapacityBefore.expired;
      result.pendingNearTtlCount = pendingCapacityBefore.nearTtl;
      result.oldestPendingAgeSec = pendingCapacityBefore.oldestPendingAgeSec;
      result.oldestDuePendingAgeSec = pendingCapacityBefore.oldestDuePendingAgeSec;
      result.estimatedDrainTimeSec = pendingCapacityBefore.estimatedDrainTimeSec;
      result.safetyAlertSourceState = safetySourceAssessment.state;
      result.safetyAlertSourceAgeSeconds = safetySourceAssessment.ageSeconds;
      result.safetyAlertSourceGeneration = safetySourceAssessment.generation;
      result.safetyAlertsSuppressed = safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed;
      result.suppressedSafetyChangesAtSeed = suppressedSafetyChangesAtSeed;
      return { itemCount: 0, metadata: JSON.stringify(result) };
    }
    const dewsChanges = buildDewsChanges(
      dewsRows.filter((row) => isDewsAlertable(row.band)),
      safeDewsAlertable,
      safeDewsSnapshot,
      getSymbol,
    );

    const previousActiveIds = new Set(Object.keys(safeDepegSnapshot));
    const currentActiveIds = new Set(Object.keys(currentSnapshots.depeg));

    const depegTriggered: DepegAlertPayload[] = activeDepegRows
      .filter((row) => !previousActiveIds.has(row.stablecoin_id))
      .map((row) => ({
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        direction: row.direction,
        deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
        price: Number(row.start_price ?? 0),
        pegReference: Number(row.peg_reference ?? 1),
      }));

    const depegWorsening: DepegWorsening[] = activeDepegRows
      .flatMap((row) => {
        const previous = safeDepegSnapshot[row.stablecoin_id];
        const currentDeviationBps = Math.abs(Number(row.peak_deviation_bps ?? 0));
        if (!previous || previous.direction !== row.direction || currentDeviationBps <= previous.deviationBps) {
          return [];
        }
        return [{
          stablecoinId: row.stablecoin_id,
          symbol: row.symbol,
          direction: row.direction,
          previousDeviationBps: previous.deviationBps,
          currentDeviationBps,
          price: Number(row.start_price ?? 0),
          pegReference: Number(row.peg_reference ?? 1),
        }];
      });

    const depegResolved: DepegResolved[] = [];
    const resolvedCandidateIds = [...previousActiveIds].filter((stablecoinId) => !currentActiveIds.has(stablecoinId));
    if (resolvedCandidateIds.length > 0) {
      throwIfAborted(signal);
      const inClause = buildInClause(resolvedCandidateIds);
      const resolvedRows = await db
        .prepare(
          `SELECT event.stablecoin_id, event.symbol, event.peak_deviation_bps, event.started_at, event.ended_at, event.recovery_price
             FROM depeg_events event
             JOIN (
               SELECT stablecoin_id, MAX(ended_at) as ended_at
                 FROM depeg_events
                WHERE ended_at IS NOT NULL
                  AND stablecoin_id IN (${inClause.sql})
                GROUP BY stablecoin_id
             ) latest
               ON latest.stablecoin_id = event.stablecoin_id
              AND latest.ended_at = event.ended_at`,
        )
        .bind(...inClause.binds)
        .all<{
          stablecoin_id: string;
          symbol: string;
          peak_deviation_bps: number;
          started_at: number;
          ended_at: number;
          recovery_price: number | null;
        }>();
      const resolvedByStablecoinId = new Map(
        (resolvedRows.results ?? []).map((row) => [row.stablecoin_id, row] as const),
      );

      for (const stablecoinId of resolvedCandidateIds) {
        throwIfAborted(signal);
        const resolved = resolvedByStablecoinId.get(stablecoinId);
        if (!resolved || resolved.ended_at == null || resolved.started_at == null) continue;

        const durationSeconds = Math.max(0, resolved.ended_at - resolved.started_at);
        const previous = safeDepegSnapshot[stablecoinId];
        depegResolved.push({
          stablecoinId,
          symbol: resolved.symbol ?? previous?.symbol ?? getSymbol(stablecoinId),
          durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
          peakDeviationBps: Math.abs(Number(resolved.peak_deviation_bps ?? 0)),
          recoveryPrice: resolved.recovery_price ?? previous?.price ?? previous?.pegReference ?? 1,
        });
      }
    }

    const { changes: safetyChanges, suppressedMethodologyChanges } = !safetySnapshotNeedsSeed
      ? buildSafetyChanges(currentSafetySnapshot, safeSafetySnapshot, getSymbol)
      : { changes: [], suppressedMethodologyChanges: 0 };

    const previousLaunchSnapshot = readCachedJson<string[]>(
      "dispatch-telegram-alerts",
      SNAPSHOT_KEYS.launch,
      await getCache(db, SNAPSHOT_KEYS.launch),
    );
    const prevLaunchIds = previousLaunchSnapshot.status === "ok" && Array.isArray(previousLaunchSnapshot.data)
      ? new Set<string>(previousLaunchSnapshot.data)
      : new Set<string>();
    const currentLaunchIds = new Set(PRE_LAUNCH_STABLECOINS.map((c) => c.id));

    const launchPromoted = buildLaunchPromotions(prevLaunchIds, currentLaunchIds, ACTIVE_IDS, TRACKED_META_BY_ID);

    const dewsIds = dewsChanges.map((c) => c.stablecoinId);
    const depegIds = [
      ...depegTriggered.map((e) => e.stablecoinId),
      ...depegResolved.map((e) => e.stablecoinId),
      ...depegWorsening.map((e) => e.stablecoinId),
    ];
    const safetyIds = safetyChanges.map((c) => c.stablecoinId);
    const launchIds = launchPromoted.map((e) => e.stablecoinId);

    const contextLines = await buildAlertContextLines(db, [...dewsIds, ...depegIds, ...safetyIds, ...launchIds]);
    for (const event of [
      ...dewsChanges,
      ...depegTriggered,
      ...depegResolved,
      ...depegWorsening,
      ...safetyChanges,
    ]) {
      const contextLine = contextLines.get(event.stablecoinId);
      if (contextLine) {
        event.contextLine = contextLine;
      }
    }

    const fanoutQueryStartedAtMs = Date.now();
    const [
      directDewsSubs,
      directDepegSubs,
      directSafetySubs,
      launchSubs,
      presetDewsResult,
      presetDepegResult,
      presetSafetyResult,
      globalDewsSubs,
      globalDepegSubs,
      globalSafetySubs,
      globalLaunchSubs,
      perCoinSnoozeMap,
    ] = await Promise.all([
      loadSubscriberRowsBatch(db, dewsIds, "dews"),
      loadSubscriberRowsBatch(db, depegIds, "depeg"),
      loadSubscriberRowsBatch(db, safetyIds, "safety"),
      loadSubscriberRowsBatch(db, launchIds, "launch"),
      loadPresetSubscriberRowsBatch(db, dewsIds, "dews"),
      loadPresetSubscriberRowsBatch(db, depegIds, "depeg"),
      loadPresetSubscriberRowsBatch(db, safetyIds, "safety"),
      loadGlobalSubscriberRows(db, "dews"),
      loadGlobalSubscriberRows(db, "depeg"),
      loadGlobalSubscriberRows(db, "safety"),
      loadGlobalSubscriberRows(db, "launch"),
      loadPerCoinSnoozeMap(db, [...dewsIds, ...depegIds, ...safetyIds, ...launchIds]),
    ]);
    const fanoutQueryMs = Math.max(0, Date.now() - fanoutQueryStartedAtMs);
    const fanoutBuildStartedAtMs = Date.now();

    const presetResults = [presetDewsResult, presetDepegResult, presetSafetyResult];
    const presetQueryFailures = presetResults.filter((r) => r.kind === "query-failed").length;
    const presetResolutionFailures = presetResults.filter((r) => r.kind === "resolution-failed").length;

    if (presetQueryFailures > 0 || presetResolutionFailures > 0) {
      const failureCount = (await readPresetFailureCount(db)) + 1;
      await writePresetFailureCount(db, failureCount);
    }

    const presetDewsSubs = presetDewsResult.kind === "ok" ? presetDewsResult.rows : new Map<string, SubscriberRow[]>();
    const presetDepegSubs = presetDepegResult.kind === "ok" ? presetDepegResult.rows : new Map<string, SubscriberRow[]>();
    const presetSafetySubs = presetSafetyResult.kind === "ok" ? presetSafetyResult.rows : new Map<string, SubscriberRow[]>();
    const dewsSubs = mergeSubscriberMaps(directDewsSubs, presetDewsSubs);
    const depegSubs = mergeSubscriberMaps(directDepegSubs, presetDepegSubs);
    const safetySubs = mergeSubscriberMaps(directSafetySubs, presetSafetySubs);

    throwIfAborted(signal);

    const alertsByChat = new Map<string, AlertsByChatEntry>();
    routeAlertEvents(
      dewsChanges,
      dewsSubs,
      globalDewsSubs,
      alertsByChat,
      (alerts) => alerts.dews,
      (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegTriggered,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegTriggered,
      (sub, event) => meetsDepegStepThreshold(event.deviationBps, sub.depeg_worsening_bps_step),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegResolved,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegResolved,
      (sub, event) => meetsDepegStepThreshold(event.peakDeviationBps, sub.depeg_worsening_bps_step),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      depegWorsening,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegWorsening,
      (sub, event) => crossesDepegWorseningStep(
        event.previousDeviationBps,
        event.currentDeviationBps,
        sub.depeg_worsening_bps_step,
      ),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      safetyChanges,
      safetySubs,
      globalSafetySubs,
      alertsByChat,
      (alerts) => alerts.safety,
      (sub, change) =>
        sub.isGlobal
          ? isMaterialSafetyDowngrade(change)
          : shouldIncludeSafetyChange(change, sub.safety_mode),
      perCoinSnoozeMap,
    );
    routeAlertEvents(
      launchPromoted,
      launchSubs,
      globalLaunchSubs,
      alertsByChat,
      (alerts) => alerts.launch,
      undefined,
      perCoinSnoozeMap,
    );

    const subscriberQueue = buildSubscriberQueue(
      alertsByChat,
      (entry) =>
        !hasEscalation(entry.alerts) ||
        isQuietHoursActive(
          nowSec,
          entry.quietHoursEnabled,
          entry.quietHoursStartUtc,
          entry.quietHoursEndUtc,
          entry.timezone,
        ),
    );
    const fanoutBuildMs = Math.max(0, Date.now() - fanoutBuildStartedAtMs);
    const perAlertTypeTargets = buildPerAlertTypeTargets(subscriberQueue);
    const freshCandidateChats = subscriberQueue.length;
    const freshCandidateCount = subscriberQueue.reduce((sum, sub) => sum + sub.chunks.length, 0);
    const alertJobManifests = await persistTelegramAlertJobManifests(db, subscriberQueue, nowSec);

    const drainOnlyRiskPriority = freshCandidateCount > 0 ? TELEGRAM_PENDING_PRIORITY.riskAlert : null;
    const drainResult = await drainPendingQueue(
      db,
      botToken,
      TELEGRAM_PENDING_DRAIN_BUDGET,
      signal,
      { maxPriority: drainOnlyRiskPriority },
    );

    const [chatsInBackoff, globalBackoffUntil] = await Promise.all([
      loadChatsInBackoff(db, nowSec),
      readTelegramGlobalBackoff(db, nowSec),
    ]);

    const {
      subscribersNotified,
      freshSent,
      freshPermanentFailures,
      blockedUsersCleanedUp,
      blockedUsersCleanupFailed,
      freshAttempted,
      freshRetryQueued,
      freshOverflow,
      freshDeferredPerChat,
      pendingEnqueued,
      cappedAtLimit,
      perAlertType,
    } = await deliverTelegramSubscriberQueue({
      db,
      botToken,
      subscriberQueue,
      drainResult,
      maxMessagesPerRun: MAX_MESSAGES_PER_RUN,
      nowSec,
      chatsInBackoff,
      globalBackoffUntil,
      dispatchStartedAtMs,
      signal,
    });
    await finalizeTelegramAlertJobManifests(db, alertJobManifests, perAlertType, nowSec);

    await writeSnapshots(db, currentSnapshots);
    const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);
    const pendingCapacityAfter = await readPendingCapacitySnapshot(db, nowSec);
    if (presetQueryFailures === 0 && presetResolutionFailures === 0) {
      await writePresetFailureCount(db, 0);
    }

    const result: DispatchResult = {
      eventsDetected: {
        dews: dewsChanges.length,
        depeg: depegTriggered.length + depegResolved.length + depegWorsening.length,
        depegTriggered: depegTriggered.length,
        depegResolved: depegResolved.length,
        depegWorsening: depegWorsening.length,
        safety: safetyChanges.length,
        launch: launchPromoted.length,
        suppressedMethodologyChanges,
      },
      subscribersNotified,
      messagesSent: freshSent + drainResult.sent,
      blockedUsersCleanedUp,
      blockedUsersCleanupFailed,
      cappedAtLimit,
      snapshotSeeded: false,
      pendingAttempted: drainResult.attempted,
      pendingDrained: drainResult.sent,
      pendingSent: drainResult.sent,
      pendingRetryQueued: drainResult.retryQueued,
      pendingDropped: drainResult.dropped,
      pendingDroppedTtlExpired: expiredCount,
      pendingDroppedPermanentFailure: drainResult.droppedPermanentFailure,
      pendingDroppedMaxAttemptsFallback: drainResult.droppedMaxAttemptsFallback,
      pendingDeferred: drainResult.deferred,
      pendingRateLimited: drainResult.rateLimited,
      pendingRetryAfterSec: drainResult.retryAfterSec,
      pendingEnqueued,
      pendingExpired: expiredCount,
      pendingTotal: pendingCapacityAfter.active,
      pendingDue: pendingCapacityAfter.due,
      pendingDeferredCount: pendingCapacityAfter.deferred,
      pendingExpiredCount: pendingCapacityAfter.expired,
      pendingNearTtlCount: pendingCapacityAfter.nearTtl,
      oldestPendingAgeSec: pendingCapacityAfter.oldestPendingAgeSec,
      oldestDuePendingAgeSec: pendingCapacityAfter.oldestDuePendingAgeSec,
      estimatedDrainTimeSec: pendingCapacityAfter.estimatedDrainTimeSec,
      pendingDrainBudgetPerRun: pendingCapacityAfter.drainBudgetPerRun,
      pendingCapacityBefore,
      pendingCapacityAfter,
      freshAttempted,
      freshSent,
      freshRetryQueued,
      freshPermanentFailures,
      freshDeferredPerChat,
      freshCandidateChats,
      freshCandidateCount,
      freshOverflow,
      chatsWithActiveSnooze,
      safetyAlertSourceState: safetySourceAssessment.state,
      safetyAlertSourceAgeSeconds: safetySourceAssessment.ageSeconds,
      safetyAlertsSuppressed: safetySourceAssessment.state !== "ok" || safetySnapshotNeedsSeed,
      safetyAlertSourceGeneration: safetySourceAssessment.generation,
      presetQueryFailures,
      presetResolutionFailures,
      presetFailure: presetQueryFailures > 0 || presetResolutionFailures > 0,
      perAlertType,
      perAlertTypeTargets,
      fanoutQueryMs,
      fanoutBuildMs,
      fanoutTotalMs: fanoutQueryMs + fanoutBuildMs,
      suppressedSafetyChangesAtSeed,
    };

    const attemptedMessages = result.pendingAttempted + result.freshAttempted;
    const hasSuccessfulEffect =
      result.messagesSent > 0 || result.blockedUsersCleanedUp > 0 || attemptedMessages === 0;
    const systemicFreshFailure =
      result.freshAttempted > 0 &&
      result.freshSent === 0 &&
      (result.freshRetryQueued > 0 || result.freshPermanentFailures > 0);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, hasSuccessfulEffect && !systemicFreshFailure);

    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
  } catch (error) {
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    throw error;
  }
}
