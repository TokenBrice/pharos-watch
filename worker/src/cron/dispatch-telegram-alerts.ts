import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TRACKED_META_BY_ID, ACTIVE_IDS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import { throwIfAborted } from "../lib/abort";
import { readCachedJson } from "../lib/api-utils";
import { getCache } from "../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  isDewsAlertable,
  isDewsDeescalation,
  type ConsolidatedAlerts,
  type DewsChange,
  type DepegAlertPayload,
  type DepegResolved,
  type DepegWorsening,
  type SafetyChange,
  type LaunchAlert,
} from "../lib/telegram-alerts";
import {
  SNAPSHOT_KEYS,
  type DewsSnapshot,
  type DepegSnapshot,
  type SafetySnapshot,
  type DewsRow,
  type ActiveDepegRow,
  type SafetyRow,
  parseSnapshotMap,
  isSnapshotMissingOrStale,
  buildDewsSnapshot,
  buildDewsAlertableSnapshot,
  filterAlertableBands,
  buildDepegSnapshot,
  buildSafetySnapshot,
  extractTopSignals,
  isSafetyDeescalation,
  writeSnapshots,
} from "./telegram-alert-snapshots";
import {
  drainPendingQueue,
  enqueuePendingAlerts,
  cleanupExpiredPendingAlerts,
} from "./telegram-pending-queue";
import {
  buildSubscriberQueue,
  deliverFreshAlerts,
  expandSubscriberChunks,
  routeAlertEvents,
  splitFreshQueue,
  type AlertsByChatEntry,
  type SubscriberRow,
} from "./dispatch-telegram-routing";

interface DispatchResult {
  eventsDetected: {
    dews: number;
    depeg: number;
    depegTriggered: number;
    depegResolved: number;
    depegWorsening: number;
    safety: number;
    launch: number;
    suppressedMethodologyChanges: number;
  };
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  pendingAttempted: number;
  pendingDrained: number;
  pendingRetryQueued: number;
  pendingDropped: number;
  pendingEnqueued: number;
  pendingExpired: number;
  freshAttempted: number;
  freshSent: number;
  freshRetryQueued: number;
  freshPermanentFailures: number;
}

const MAX_MESSAGES_PER_RUN = 200;

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

function emptyResult(snapshotSeeded: boolean): DispatchResult {
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
    pendingEnqueued: 0,
    pendingExpired: 0,
    freshAttempted: 0,
    freshSent: 0,
    freshRetryQueued: 0,
    freshPermanentFailures: 0,
  };
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

function isQuietHoursActive(
  nowSec: number,
  quietHoursEnabled: boolean,
  quietHoursStartUtc: number | null,
  quietHoursEndUtc: number | null,
): boolean {
  if (!quietHoursEnabled || quietHoursStartUtc == null || quietHoursEndUtc == null) return false;
  if (
    quietHoursStartUtc < 0 ||
    quietHoursStartUtc > 23 ||
    quietHoursEndUtc < 0 ||
    quietHoursEndUtc > 23 ||
    quietHoursStartUtc === quietHoursEndUtc
  ) {
    return false;
  }

  const hourUtc = Math.floor((nowSec % 86_400) / 3600);
  if (quietHoursStartUtc < quietHoursEndUtc) {
    return hourUtc >= quietHoursStartUtc && hourUtc < quietHoursEndUtc;
  }
  return hourUtc >= quietHoursStartUtc || hourUtc < quietHoursEndUtc;
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

function crossesDepegWorseningStep(
  previousDeviationBps: number,
  currentDeviationBps: number,
  step: number | null,
): boolean {
  if (step == null || step <= 0 || currentDeviationBps <= previousDeviationBps) return false;
  return Math.floor(previousDeviationBps / step) < Math.floor(currentDeviationBps / step);
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
              u.quiet_hours_end_utc
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (${placeholders})
          AND sub.${alertColumn} = 1`,
    )
    .bind(...stablecoinIds)
    .all<SubscriberRow & { stablecoin_id: string }>();

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
  const result = await db
    .prepare(
      // SAFETY: alertColumn comes from GLOBAL_ALERT_COLUMN_BY_TYPE and is
      // validated against the hardcoded allowlist above before interpolation.
      `SELECT chat_id,
              last_active_at,
              quiet_hours_enabled,
              quiet_hours_start_utc,
              quiet_hours_end_utc
         FROM telegram_subscribers
        WHERE ${alertColumn} = 1`,
    )
    .all<SubscriberRow>();

  return (result.results ?? []).map((row) => ({
    chat_id: row.chat_id,
    last_active_at: row.last_active_at,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
    quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
    quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
  }));
}

export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
  if (!allowed) {
    return { itemCount: 0, metadata: JSON.stringify({ skipped: "circuit-open" }) };
  }

  try {
    throwIfAborted(signal);

    const [dewsRows, activeDepegRows, safetyRows, dewsCache, dewsAlertableCache, depegCache, safetyCache] = await Promise.all([
      db
        .prepare(
          `SELECT s.stablecoin_id, s.score, s.band, s.signals_json
             FROM stress_signals s
             INNER JOIN (
               SELECT stablecoin_id, MAX(computed_at) AS max_at
                 FROM stress_signals GROUP BY stablecoin_id
             ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
        )
        .all<DewsRow>()
        .then((result) => result.results ?? []),
      db
        .prepare(
          "SELECT stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference FROM depeg_events WHERE ended_at IS NULL",
        )
        .all<ActiveDepegRow>()
        .then((result) => result.results ?? []),
      db
        .prepare(
          `SELECT h.stablecoin_id,
                  h.grade,
                  h.score,
                  h.prev_grade,
                  h.prev_score,
                  h.recorded_at,
                  h.methodology_version
             FROM safety_grade_history h
             INNER JOIN (
               SELECT stablecoin_id, MAX(recorded_at) AS max_recorded_at
                 FROM safety_grade_history
                GROUP BY stablecoin_id
             ) latest
               ON latest.stablecoin_id = h.stablecoin_id
              AND latest.max_recorded_at = h.recorded_at`,
        )
        .all<SafetyRow>()
        .then((result) => result.results ?? []),
      getCache(db, SNAPSHOT_KEYS.dews),
      getCache(db, SNAPSHOT_KEYS.dewsAlertable),
      getCache(db, SNAPSHOT_KEYS.depeg),
      getCache(db, SNAPSHOT_KEYS.safety),
    ]);

    throwIfAborted(signal);

    const nowSec = Math.floor(Date.now() / 1000);
    const previousDewsSnapshot = parseSnapshotMap<DewsSnapshot>(dewsCache);
    const previousDewsAlertableSnapshot =
      parseSnapshotMap<DewsSnapshot>(dewsAlertableCache) ??
      filterAlertableBands(previousDewsSnapshot);
    const currentSnapshots = {
      dews: buildDewsSnapshot(dewsRows),
      dewsAlertable: buildDewsAlertableSnapshot(dewsRows, previousDewsAlertableSnapshot),
      depeg: buildDepegSnapshot(activeDepegRows),
      safety: buildSafetySnapshot(safetyRows),
      launch: PRE_LAUNCH_STABLECOINS.map((c) => c.id),
    };

    const previousDepegSnapshot = parseSnapshotMap<DepegSnapshot>(depegCache);
    const previousSafetySnapshot = parseSnapshotMap<SafetySnapshot>(safetyCache);

    const mustSeedSnapshots =
      isSnapshotMissingOrStale(dewsCache, nowSec) ||
      (dewsAlertableCache != null && isSnapshotMissingOrStale(dewsAlertableCache, nowSec)) ||
      isSnapshotMissingOrStale(depegCache, nowSec) ||
      isSnapshotMissingOrStale(safetyCache, nowSec) ||
      previousDewsSnapshot == null ||
      previousDepegSnapshot == null ||
      previousSafetySnapshot == null;

    if (mustSeedSnapshots) {
      await writeSnapshots(db, currentSnapshots);
      await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
      const result = emptyResult(true);
      return { itemCount: 0, metadata: JSON.stringify(result) };
    }

    // Defense-in-depth null guards: mustSeedSnapshots above catches null snapshots,
    // but protect downstream indexing in case guard logic drifts.
    const safeDewsSnapshot = previousDewsSnapshot ?? {};
    const safeDewsAlertable = previousDewsAlertableSnapshot ?? {};
    const safeDepegSnapshot = previousDepegSnapshot ?? {};
    const safeSafetySnapshot = previousSafetySnapshot ?? {};

    const pendingBudget = Math.floor(MAX_MESSAGES_PER_RUN / 4);
    const drainResult = await drainPendingQueue(db, botToken, pendingBudget, signal);

    throwIfAborted(signal);

    const dewsChanges: DewsChange[] = [];
    for (const row of dewsRows) {
      const oldBand = safeDewsAlertable[row.stablecoin_id];
      if (oldBand === row.band || !isDewsAlertable(row.band)) continue;
      const previousRawBand = safeDewsSnapshot[row.stablecoin_id];
      dewsChanges.push({
        stablecoinId: row.stablecoin_id,
        symbol: getSymbol(row.stablecoin_id),
        oldBand:
          typeof oldBand === "string"
            ? oldBand
            : typeof previousRawBand === "string"
              ? previousRawBand
              : "UNKNOWN",
        newBand: row.band,
        score: row.score,
        topSignals: extractTopSignals(row.signals_json),
      });
    }

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
    for (const stablecoinId of previousActiveIds) {
      if (currentActiveIds.has(stablecoinId)) continue;
      throwIfAborted(signal);

      const resolved = await db
        .prepare(
          `SELECT stablecoin_id, symbol, peak_deviation_bps, started_at, ended_at, recovery_price
             FROM depeg_events
            WHERE stablecoin_id = ? AND ended_at IS NOT NULL
            ORDER BY ended_at DESC LIMIT 1`,
        )
        .bind(stablecoinId)
        .first<{
          stablecoin_id: string;
          symbol: string;
          peak_deviation_bps: number;
          started_at: number;
          ended_at: number;
          recovery_price: number | null;
        }>();

      if (!resolved || resolved.ended_at == null || resolved.started_at == null) continue;

      const durationSeconds = Math.max(0, resolved.ended_at - resolved.started_at);
      const previous = safeDepegSnapshot[stablecoinId];
      depegResolved.push({
        stablecoinId,
        symbol: resolved.symbol ?? previous?.symbol ?? getSymbol(stablecoinId),
        durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
        peakDeviationBps: Math.abs(Number(resolved.peak_deviation_bps ?? 0)),
        recoveryPrice:
          resolved.recovery_price ??
          previous?.price ??
          previous?.pegReference ??
          1,
      });
    }

    const safetyChanges: SafetyChange[] = [];
    let suppressedMethodologyChanges = 0;
    for (const row of safetyRows) {
      const previous = safeSafetySnapshot[row.stablecoin_id];
      if (previous?.grade === row.grade) continue;

      if (previous?.methodologyVersion && row.methodology_version && previous.methodologyVersion !== row.methodology_version) {
        suppressedMethodologyChanges++;
        continue;
      }

      if (!previous) {
        if (row.recorded_at <= (safetyCache?.updatedAt ?? 0) || row.prev_grade == null) {
          continue;
        }
      }

      safetyChanges.push({
        stablecoinId: row.stablecoin_id,
        symbol: getSymbol(row.stablecoin_id),
        oldGrade: previous?.grade ?? row.prev_grade ?? "UNKNOWN",
        newGrade: row.grade,
        oldScore: previous?.score ?? row.prev_score ?? null,
        newScore: row.score ?? null,
      });
    }

    // -- Detect launch promotions (pre-launch coins that moved to active) -----
    const previousLaunchSnapshot = readCachedJson<string[]>(
      "dispatch-telegram-alerts",
      SNAPSHOT_KEYS.launch,
      await getCache(db, SNAPSHOT_KEYS.launch),
    );
    const prevLaunchIds = previousLaunchSnapshot.status === "ok" && Array.isArray(previousLaunchSnapshot.data)
      ? new Set(previousLaunchSnapshot.data)
      : new Set<string>();
    const currentLaunchIds = new Set(PRE_LAUNCH_STABLECOINS.map((c) => c.id));

    const launchPromoted: LaunchAlert[] = [];
    // An ID that was previously pre-launch but is no longer, AND exists in ACTIVE_IDS = promoted
    for (const id of prevLaunchIds) {
      if (!currentLaunchIds.has(id) && ACTIVE_IDS.has(id)) {
        const coin = TRACKED_META_BY_ID.get(id);
        if (coin) {
          launchPromoted.push({
            stablecoinId: id,
            symbol: coin.symbol,
            name: coin.name,
          });
        }
      }
    }

    const dewsIds = dewsChanges.map((c) => c.stablecoinId);
    const depegIds = [
      ...depegTriggered.map((e) => e.stablecoinId),
      ...depegResolved.map((e) => e.stablecoinId),
      ...depegWorsening.map((e) => e.stablecoinId),
    ];
    const safetyIds = safetyChanges.map((c) => c.stablecoinId);
    const launchIds = launchPromoted.map((e) => e.stablecoinId);

    const [dewsSubs, depegSubs, safetySubs, launchSubs, globalDewsSubs, globalDepegSubs, globalSafetySubs, globalLaunchSubs] = await Promise.all([
      loadSubscriberRowsBatch(db, dewsIds, "dews"),
      loadSubscriberRowsBatch(db, depegIds, "depeg"),
      loadSubscriberRowsBatch(db, safetyIds, "safety"),
      loadSubscriberRowsBatch(db, launchIds, "launch"),
      loadGlobalSubscriberRows(db, "dews"),
      loadGlobalSubscriberRows(db, "depeg"),
      loadGlobalSubscriberRows(db, "safety"),
      loadGlobalSubscriberRows(db, "launch"),
    ]);

    throwIfAborted(signal);

    const alertsByChat = new Map<string, AlertsByChatEntry>();
    routeAlertEvents(
      dewsChanges,
      dewsSubs,
      globalDewsSubs,
      alertsByChat,
      (alerts) => alerts.dews,
      (sub, change) => meetsDewsThreshold(change.newBand, sub.dews_min_band),
    );
    routeAlertEvents(
      depegTriggered,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegTriggered,
    );
    routeAlertEvents(
      depegResolved,
      depegSubs,
      globalDepegSubs,
      alertsByChat,
      (alerts) => alerts.depegResolved,
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
    );
    routeAlertEvents(
      safetyChanges,
      safetySubs,
      globalSafetySubs,
      alertsByChat,
      (alerts) => alerts.safety,
      (sub, change) => shouldIncludeSafetyChange(change, sub.safety_mode),
    );
    routeAlertEvents(
      launchPromoted,
      launchSubs,
      globalLaunchSubs,
      alertsByChat,
      (alerts) => alerts.launch,
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
        ),
    );

    const freshBudget = Math.max(0, MAX_MESSAGES_PER_RUN - drainResult.attempted);
    const { toSend, toEnqueue } = splitFreshQueue(subscriberQueue, freshBudget);
    const sendList = expandSubscriberChunks(toSend);
    const {
      subscribersNotified,
      freshSent,
      freshPermanentFailures,
      blockedUsersCleanedUp,
      blockedUsersCleanupFailed,
      blockedChats,
      retryableFreshMessages,
    } = await deliverFreshAlerts(
      db,
      sendList,
      toSend,
      botToken,
      drainResult.blocked - drainResult.blockedCleanupFailed,
      drainResult.blockedCleanupFailed,
    );
    const overflowMessages = expandSubscriberChunks(toEnqueue, blockedChats);

    const freshRetryQueued = retryableFreshMessages.length;
    const pendingEnqueued = overflowMessages.length + retryableFreshMessages.length;
    if (pendingEnqueued > 0) {
      await enqueuePendingAlerts(db, [...overflowMessages, ...retryableFreshMessages], nowSec);
    }

    await writeSnapshots(db, currentSnapshots);
    const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);

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
      cappedAtLimit: toEnqueue.length > 0,
      snapshotSeeded: false,
      pendingAttempted: drainResult.attempted,
      pendingDrained: drainResult.sent,
      pendingRetryQueued: drainResult.retryQueued,
      pendingDropped: drainResult.dropped,
      pendingEnqueued,
      pendingExpired: expiredCount,
      freshAttempted: sendList.length,
      freshSent,
      freshRetryQueued,
      freshPermanentFailures,
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
