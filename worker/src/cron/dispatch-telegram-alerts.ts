import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import { sendToChat, sendBatch } from "../lib/telegram";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  isDewsAlertable,
  isDewsDeescalation,
  formatConsolidatedMessage,
  splitMessage,
  type ConsolidatedAlerts,
  type DewsChange,
  type DepegAlertPayload,
  type DepegResolved,
  type DepegWorsening,
  type SafetyChange,
} from "../lib/telegram-alerts";

interface DispatchResult {
  eventsDetected: {
    dews: number;
    depeg: number;
    depegTriggered: number;
    depegResolved: number;
    depegWorsening: number;
    safety: number;
    suppressedMethodologyChanges: number;
  };
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
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
const SNAPSHOT_MAX_AGE_SEC = 86400; // 24h
const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
const SEND_BATCH_SIZE = 5; // Parallel sends per batch (stay under Workers 6-conn limit)

const SNAPSHOT_KEYS = {
  dews: "alert:dews-snapshot",
  dewsAlertable: "alert:dews-alertable-snapshot",
  depeg: "alert:depeg-snapshot",
  safety: "alert:safety-snapshot",
} as const;

const ALERT_COLUMN_BY_TYPE = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
} as const;

const GLOBAL_ALERT_COLUMN_BY_TYPE = {
  dews: "global_alert_dews",
  depeg: "global_alert_depeg",
  safety: "global_alert_safety",
} as const;

const SAFETY_GRADE_RANK: Record<string, number> = {
  NR: 0,
  F: 1,
  D: 2,
  "C-": 3,
  C: 4,
  "C+": 5,
  "B-": 6,
  B: 7,
  "B+": 8,
  "A-": 9,
  A: 10,
  "A+": 11,
};

type AlertType = keyof typeof ALERT_COLUMN_BY_TYPE;
type DewsSnapshot = Record<string, string>;
type DepegSnapshot = Record<string, DepegAlertPayload>;
type SafetySnapshot = Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;

interface DewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string | null;
}

interface ActiveDepegRow {
  stablecoin_id: string;
  symbol: string;
  direction: "above" | "below";
  peak_deviation_bps: number;
  start_price: number;
  peg_reference: number;
}

interface ClosedDepegRow {
  stablecoin_id: string;
  symbol: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number;
  recovery_price: number | null;
}

interface SafetyRow {
  stablecoin_id: string;
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  recorded_at: number;
  methodology_version: string | null;
}

interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
}

interface AlertsByChatEntry {
  lastActiveAt: number;
  alerts: ConsolidatedAlerts;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
}

interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
}

interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  retryQueued: number;
  dropped: number;
}

function emptyAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
  };
}

function emptyResult(snapshotSeeded: boolean): DispatchResult {
  return {
    eventsDetected: {
      dews: 0,
      depeg: 0,
      depegTriggered: 0,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 0,
      suppressedMethodologyChanges: 0,
    },
    subscribersNotified: 0,
    messagesSent: 0,
    blockedUsersCleanedUp: 0,
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

function parseSnapshotMap<T extends Record<string, unknown>>(
  cached: { value: string; updatedAt: number } | null,
): T | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch { /* expected: corrupted or legacy cache format */
    return null;
  }
}

function isSnapshotMissingOrStale(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): boolean {
  return !cached || nowSec - cached.updatedAt > SNAPSHOT_MAX_AGE_SEC;
}

function getSymbol(stablecoinId: string, fallback?: string): string {
  return TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? fallback ?? stablecoinId;
}

function buildDewsSnapshot(rows: DewsRow[]): DewsSnapshot {
  const snapshot: DewsSnapshot = {};
  for (const row of rows) {
    snapshot[row.stablecoin_id] = row.band;
  }
  return snapshot;
}

function buildDewsAlertableSnapshot(
  rows: DewsRow[],
  previous: DewsSnapshot | null = null,
): DewsSnapshot {
  const snapshot: DewsSnapshot = previous ? { ...previous } : {};
  for (const row of rows) {
    if (!isDewsAlertable(row.band)) continue;
    snapshot[row.stablecoin_id] = row.band;
  }
  return snapshot;
}

function filterAlertableBands(snapshot: DewsSnapshot | null): DewsSnapshot {
  if (!snapshot) return {};
  const filtered: DewsSnapshot = {};
  for (const [stablecoinId, band] of Object.entries(snapshot)) {
    if (!isDewsAlertable(band)) continue;
    filtered[stablecoinId] = band;
  }
  return filtered;
}

function buildDepegSnapshot(rows: ActiveDepegRow[]): DepegSnapshot {
  const snapshot: DepegSnapshot = {};
  for (const row of rows) {
    snapshot[row.stablecoin_id] = {
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      direction: row.direction,
      deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
      price: Number(row.start_price ?? 0),
      pegReference: Number(row.peg_reference ?? 1),
    };
  }
  return snapshot;
}

function buildSafetySnapshot(rows: SafetyRow[]): SafetySnapshot {
  const snapshot: SafetySnapshot = {};
  for (const row of rows) {
    snapshot[row.stablecoin_id] = {
      grade: row.grade,
      score: row.score ?? null,
      methodologyVersion: row.methodology_version ?? null,
    };
  }
  return snapshot;
}

function extractTopSignals(signalsJson: string | null): Array<{ name: string; value: number }> {
  if (!signalsJson) return [];
  try {
    const parsed = JSON.parse(signalsJson) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

    return Object.entries(parsed)
      .flatMap(([name, raw]) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const entry = raw as { value?: unknown; available?: unknown };
        if (typeof entry.value !== "number" || entry.available === false) return [];
        return [{ name, value: entry.value }];
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, 2);
  } catch { /* expected: malformed signals_json from upstream */
    return [];
  }
}

function isSafetyDeescalation(oldGrade: string, newGrade: string): boolean {
  const oldRank = SAFETY_GRADE_RANK[oldGrade];
  const newRank = SAFETY_GRADE_RANK[newGrade];
  if (oldRank == null || newRank == null) return false;
  return newRank > oldRank;
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

async function writeSnapshots(
  db: D1Database,
  snapshots: {
    dews: DewsSnapshot;
    dewsAlertable: DewsSnapshot;
    depeg: DepegSnapshot;
    safety: SafetySnapshot;
  },
): Promise<void> {
  await Promise.all([
    setCache(db, SNAPSHOT_KEYS.dews, JSON.stringify(snapshots.dews)),
    setCache(db, SNAPSHOT_KEYS.dewsAlertable, JSON.stringify(snapshots.dewsAlertable)),
    setCache(db, SNAPSHOT_KEYS.depeg, JSON.stringify(snapshots.depeg)),
    setCache(db, SNAPSHOT_KEYS.safety, JSON.stringify(snapshots.safety)),
  ]);
}

async function loadSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: AlertType,
): Promise<Map<string, SubscriberRow[]>> {
  if (stablecoinIds.length === 0) return new Map();
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  const placeholders = stablecoinIds.map(() => "?").join(",");
  const result = await db
    .prepare(
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
  const result = await db
    .prepare(
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

async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<void> {
  await db
    .batch([
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
    ])
    .catch(() => {});
}

async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PendingDrainResult> {
  const rows = await db
    .prepare(
      `SELECT id, chat_id, message_html, disable_notification, created_at, attempts
         FROM telegram_pending_alerts
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<PendingAlertRow>();

  const pending = rows.results ?? [];
  if (pending.length === 0) {
    return { attempted: 0, sent: 0, blocked: 0, retryQueued: 0, dropped: 0 };
  }

  let attempted = 0;
  let sent = 0;
  let blocked = 0;
  let retryQueued = 0;
  let dropped = 0;
  const idsToDelete: number[] = [];
  const idsToRetry: number[] = [];

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const result = await sendToChat(row.chat_id, row.message_html, botToken, {
          disableWebPagePreview: true,
          disableNotification: row.disable_notification === 1,
        });
        return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
      }),
    );

    for (const result of results) {
      attempted++;
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        await disableBlockedSubscriber(db, result.chatId);
      } else if (result.retryable && result.attempts < 2) {
        retryQueued++;
        idsToRetry.push(result.id);
      } else {
        dropped++;
        idsToDelete.push(result.id);
      }
    }
  }

  if (idsToDelete.length > 0) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${placeholders})`)
      .bind(...idsToDelete)
      .run();
  }

  if (idsToRetry.length > 0) {
    const placeholders = idsToRetry.map(() => "?").join(",");
    await db
      .prepare(`UPDATE telegram_pending_alerts SET attempts = attempts + 1 WHERE id IN (${placeholders})`)
      .bind(...idsToRetry)
      .run();
  }

  return { attempted, sent, blocked, retryQueued, dropped };
}

async function enqueuePendingAlerts(
  db: D1Database,
  messages: Array<{ chatId: string; html: string; disableNotification: boolean }>,
  nowSec: number,
): Promise<void> {
  if (messages.length === 0) return;

  const stmts = messages.map((msg) =>
    db
      .prepare(
        `INSERT INTO telegram_pending_alerts (chat_id, message_html, disable_notification, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(msg.chatId, msg.html, msg.disableNotification ? 1 : 0, nowSec),
  );
  await db.batch(stmts);
}

async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const result = await db
    .prepare("DELETE FROM telegram_pending_alerts WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
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

    const pendingBudget = Math.floor(MAX_MESSAGES_PER_RUN / 4);
    const drainResult = await drainPendingQueue(db, botToken, pendingBudget, signal);

    throwIfAborted(signal);

    const dewsChanges: DewsChange[] = [];
    for (const row of dewsRows) {
      const oldBand = previousDewsAlertableSnapshot[row.stablecoin_id];
      if (oldBand === row.band || !isDewsAlertable(row.band)) continue;
      const previousRawBand = previousDewsSnapshot[row.stablecoin_id];
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

    const previousActiveIds = new Set(Object.keys(previousDepegSnapshot));
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
        const previous = previousDepegSnapshot[row.stablecoin_id];
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
        .first<ClosedDepegRow>();

      if (!resolved || resolved.ended_at == null || resolved.started_at == null) continue;

      const durationSeconds = Math.max(0, resolved.ended_at - resolved.started_at);
      const previous = previousDepegSnapshot[stablecoinId];
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
      const previous = previousSafetySnapshot[row.stablecoin_id];
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

    const dewsIds = dewsChanges.map((c) => c.stablecoinId);
    const depegIds = [
      ...depegTriggered.map((e) => e.stablecoinId),
      ...depegResolved.map((e) => e.stablecoinId),
      ...depegWorsening.map((e) => e.stablecoinId),
    ];
    const safetyIds = safetyChanges.map((c) => c.stablecoinId);

    const [dewsSubs, depegSubs, safetySubs, globalDewsSubs, globalDepegSubs, globalSafetySubs] = await Promise.all([
      loadSubscriberRowsBatch(db, dewsIds, "dews"),
      loadSubscriberRowsBatch(db, depegIds, "depeg"),
      loadSubscriberRowsBatch(db, safetyIds, "safety"),
      loadGlobalSubscriberRows(db, "dews"),
      loadGlobalSubscriberRows(db, "depeg"),
      loadGlobalSubscriberRows(db, "safety"),
    ]);

    throwIfAborted(signal);

    const alertsByChat = new Map<string, AlertsByChatEntry>();

    const addToChat = (
      sub: SubscriberRow,
      append: (alerts: ConsolidatedAlerts) => unknown[],
      event: unknown,
    ): void => {
      const existing = alertsByChat.get(sub.chat_id);
      if (existing) {
        existing.lastActiveAt = Math.max(existing.lastActiveAt, sub.last_active_at);
        append(existing.alerts).push(event);
        return;
      }
      const alerts = emptyAlerts();
      append(alerts).push(event);
      alertsByChat.set(sub.chat_id, {
        lastActiveAt: sub.last_active_at,
        alerts,
        quietHoursEnabled: Boolean(sub.quiet_hours_enabled),
        quietHoursStartUtc: sub.quiet_hours_start_utc ?? null,
        quietHoursEndUtc: sub.quiet_hours_end_utc ?? null,
      });
    };

    for (const change of dewsChanges) {
      const specificSubscribers = dewsSubs.get(change.stablecoinId) ?? [];
      const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
      for (const sub of specificSubscribers) {
        if (!meetsDewsThreshold(change.newBand, sub.dews_min_band)) continue;
        addToChat(sub, (alerts) => alerts.dews, change);
      }
      for (const sub of globalDewsSubs) {
        if (specificChatIds.has(sub.chat_id)) continue;
        addToChat(sub, (alerts) => alerts.dews, change);
      }
    }
    for (const event of depegTriggered) {
      const specificSubscribers = depegSubs.get(event.stablecoinId) ?? [];
      const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
      for (const sub of specificSubscribers) {
        addToChat(sub, (alerts) => alerts.depegTriggered, event);
      }
      for (const sub of globalDepegSubs) {
        if (specificChatIds.has(sub.chat_id)) continue;
        addToChat(sub, (alerts) => alerts.depegTriggered, event);
      }
    }
    for (const event of depegResolved) {
      const specificSubscribers = depegSubs.get(event.stablecoinId) ?? [];
      const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
      for (const sub of specificSubscribers) {
        addToChat(sub, (alerts) => alerts.depegResolved, event);
      }
      for (const sub of globalDepegSubs) {
        if (specificChatIds.has(sub.chat_id)) continue;
        addToChat(sub, (alerts) => alerts.depegResolved, event);
      }
    }
    for (const event of depegWorsening) {
      const specificSubscribers = depegSubs.get(event.stablecoinId) ?? [];
      const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
      for (const sub of specificSubscribers) {
        if (!crossesDepegWorseningStep(
          event.previousDeviationBps,
          event.currentDeviationBps,
          sub.depeg_worsening_bps_step,
        )) {
          continue;
        }
        addToChat(sub, (alerts) => alerts.depegWorsening, event);
      }
      for (const sub of globalDepegSubs) {
        if (specificChatIds.has(sub.chat_id)) continue;
        if (!crossesDepegWorseningStep(
          event.previousDeviationBps,
          event.currentDeviationBps,
          sub.depeg_worsening_bps_step,
        )) {
          continue;
        }
        addToChat(sub, (alerts) => alerts.depegWorsening, event);
      }
    }
    for (const change of safetyChanges) {
      const specificSubscribers = safetySubs.get(change.stablecoinId) ?? [];
      const specificChatIds = new Set(specificSubscribers.map((sub) => sub.chat_id));
      for (const sub of specificSubscribers) {
        if (!shouldIncludeSafetyChange(change, sub.safety_mode)) continue;
        addToChat(sub, (alerts) => alerts.safety, change);
      }
      for (const sub of globalSafetySubs) {
        if (specificChatIds.has(sub.chat_id)) continue;
        if (!shouldIncludeSafetyChange(change, sub.safety_mode)) continue;
        addToChat(sub, (alerts) => alerts.safety, change);
      }
    }

    const subscriberQueue = [...alertsByChat.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        lastActiveAt: entry.lastActiveAt,
        alerts: entry.alerts,
        chunks: splitMessage(formatConsolidatedMessage(entry.alerts)),
        disableNotification:
          !hasEscalation(entry.alerts) ||
          isQuietHoursActive(
            nowSec,
            entry.quietHoursEnabled,
            entry.quietHoursStartUtc,
            entry.quietHoursEndUtc,
          ),
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const freshBudget = Math.max(0, MAX_MESSAGES_PER_RUN - drainResult.attempted);
    const toSend: typeof subscriberQueue = [];
    const toEnqueue: typeof subscriberQueue = [];
    let allocatedFreshChunks = 0;
    for (const sub of subscriberQueue) {
      if (allocatedFreshChunks + sub.chunks.length <= freshBudget) {
        toSend.push(sub);
        allocatedFreshChunks += sub.chunks.length;
      } else {
        toEnqueue.push(sub);
      }
    }

    const sendList: Array<{ chatId: string; html: string; disableNotification: boolean }> = [];
    for (const sub of toSend) {
      for (const chunk of sub.chunks) {
        sendList.push({
          chatId: sub.chatId,
          html: chunk,
          disableNotification: sub.disableNotification,
        });
      }
    }

    const sendResults = await sendBatch(sendList, botToken, SEND_BATCH_SIZE);

    let subscribersNotified = 0;
    let freshSent = 0;
    let freshPermanentFailures = 0;
    let blockedUsersCleanedUp = drainResult.blocked;
    const blockedChats = new Set<string>();
    const retryableFreshMessages: Array<{ chatId: string; html: string; disableNotification: boolean }> = [];
    const resultsByChat = new Map<string, typeof sendResults>();

    for (let index = 0; index < sendResults.length; index += 1) {
      const result = sendResults[index];
      const sendPlan = sendList[index];
      if (!result || !sendPlan) continue;

      const existing = resultsByChat.get(result.chatId) ?? [];
      existing.push(result);
      resultsByChat.set(result.chatId, existing);

      if (result.ok) {
        freshSent++;
        continue;
      }

      if (result.blocked) {
        if (!blockedChats.has(result.chatId)) {
          blockedChats.add(result.chatId);
          blockedUsersCleanedUp++;
          await disableBlockedSubscriber(db, result.chatId);
        }
        continue;
      }

      if (result.retryable) {
        retryableFreshMessages.push(sendPlan);
      } else {
        freshPermanentFailures++;
      }
    }

    for (const sub of toSend) {
      if (blockedChats.has(sub.chatId)) continue;
      const subResults = resultsByChat.get(sub.chatId) ?? [];
      if (subResults.length === sub.chunks.length && subResults.every((result) => result.ok)) {
        subscribersNotified++;
      }
    }

    const overflowMessages: Array<{ chatId: string; html: string; disableNotification: boolean }> = [];
    for (const sub of toEnqueue) {
      if (blockedChats.has(sub.chatId)) continue;
      for (const chunk of sub.chunks) {
        overflowMessages.push({
          chatId: sub.chatId,
          html: chunk,
          disableNotification: sub.disableNotification,
        });
      }
    }

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
        suppressedMethodologyChanges,
      },
      subscribersNotified,
      messagesSent: freshSent + drainResult.sent,
      blockedUsersCleanedUp,
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
