import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db";
import { sendToChat } from "../lib/telegram";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  isDewsAlertable,
  isDewsDeescalation,
  formatConsolidatedMessage,
  splitMessage,
  type ConsolidatedAlerts,
  type DewsChange,
  type DepegEvent,
  type DepegResolved,
  type SafetyChange,
} from "../lib/telegram-alerts";

interface DispatchResult {
  eventsDetected: { dews: number; depeg: number; safety: number };
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
}

const MAX_MESSAGES_PER_RUN = 50;
const SNAPSHOT_MAX_AGE_SEC = 86400; // 24h

const SNAPSHOT_KEYS = {
  dews: "alert:dews-snapshot",
  depeg: "alert:depeg-snapshot",
  safety: "alert:safety-snapshot",
} as const;

const ALERT_COLUMN_BY_TYPE = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
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
type DepegSnapshot = Record<string, DepegEvent>;
type SafetySnapshot = Record<string, { grade: string; score: number | null }>;

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
}

interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
}

function emptyAlerts(): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    safety: [],
  };
}

function emptyResult(snapshotSeeded: boolean): DispatchResult {
  return {
    eventsDetected: { dews: 0, depeg: 0, safety: 0 },
    subscribersNotified: 0,
    messagesSent: 0,
    blockedUsersCleanedUp: 0,
    cappedAtLimit: false,
    snapshotSeeded,
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
  } catch {
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
  } catch {
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
    alerts.safety.some((change) => !isSafetyDeescalation(change.oldGrade, change.newGrade))
  );
}

async function writeSnapshots(
  db: D1Database,
  snapshots: {
    dews: DewsSnapshot;
    depeg: DepegSnapshot;
    safety: SafetySnapshot;
  },
): Promise<void> {
  await Promise.all([
    setCache(db, SNAPSHOT_KEYS.dews, JSON.stringify(snapshots.dews)),
    setCache(db, SNAPSHOT_KEYS.depeg, JSON.stringify(snapshots.depeg)),
    setCache(db, SNAPSHOT_KEYS.safety, JSON.stringify(snapshots.safety)),
  ]);
}

async function loadSubscriberRows(
  db: D1Database,
  stablecoinId: string,
  type: AlertType,
): Promise<SubscriberRow[]> {
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  const result = await db
    .prepare(
      `SELECT s.chat_id, u.last_active_at
         FROM telegram_subscriptions s
         JOIN telegram_subscribers u ON u.chat_id = s.chat_id
        WHERE s.stablecoin_id = ?
          AND u.${alertColumn} = 1`,
    )
    .bind(stablecoinId)
    .all<SubscriberRow>();
  return result.results ?? [];
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

    const [dewsRows, activeDepegRows, safetyRows, dewsCache, depegCache, safetyCache] = await Promise.all([
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
          `SELECT stablecoin_id, grade, score
             FROM safety_grade_history
            WHERE recorded_at = (SELECT MAX(recorded_at) FROM safety_grade_history)`,
        )
        .all<SafetyRow>()
        .then((result) => result.results ?? []),
      getCache(db, SNAPSHOT_KEYS.dews),
      getCache(db, SNAPSHOT_KEYS.depeg),
      getCache(db, SNAPSHOT_KEYS.safety),
    ]);

    throwIfAborted(signal);

    const nowSec = Math.floor(Date.now() / 1000);
    const currentSnapshots = {
      dews: buildDewsSnapshot(dewsRows),
      depeg: buildDepegSnapshot(activeDepegRows),
      safety: buildSafetySnapshot(safetyRows),
    };

    const previousDewsSnapshot = parseSnapshotMap<DewsSnapshot>(dewsCache);
    const previousDepegSnapshot = parseSnapshotMap<DepegSnapshot>(depegCache);
    const previousSafetySnapshot = parseSnapshotMap<SafetySnapshot>(safetyCache);

    const mustSeedSnapshots =
      isSnapshotMissingOrStale(dewsCache, nowSec) ||
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

    const dewsChanges: DewsChange[] = [];
    for (const row of dewsRows) {
      const oldBand = previousDewsSnapshot[row.stablecoin_id];
      if (oldBand === row.band || !isDewsAlertable(row.band)) continue;
      dewsChanges.push({
        stablecoinId: row.stablecoin_id,
        symbol: getSymbol(row.stablecoin_id),
        oldBand: typeof oldBand === "string" ? oldBand : "UNKNOWN",
        newBand: row.band,
        score: row.score,
        topSignals: extractTopSignals(row.signals_json),
      });
    }

    const previousActiveIds = new Set(Object.keys(previousDepegSnapshot));
    const currentActiveIds = new Set(Object.keys(currentSnapshots.depeg));

    const depegTriggered: DepegEvent[] = activeDepegRows
      .filter((row) => !previousActiveIds.has(row.stablecoin_id))
      .map((row) => ({
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        direction: row.direction,
        deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
        price: Number(row.start_price ?? 0),
        pegReference: Number(row.peg_reference ?? 1),
      }));

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
    for (const row of safetyRows) {
      const previous = previousSafetySnapshot[row.stablecoin_id];
      if (previous?.grade === row.grade) continue;
      safetyChanges.push({
        stablecoinId: row.stablecoin_id,
        symbol: getSymbol(row.stablecoin_id),
        oldGrade: previous?.grade ?? "UNKNOWN",
        newGrade: row.grade,
        oldScore: previous?.score ?? null,
        newScore: row.score ?? null,
      });
    }

    const alertsByChat = new Map<string, { lastActiveAt: number; alerts: ConsolidatedAlerts }>();
    const queueSubscribers = async <T>(
      stablecoinId: string,
      type: AlertType,
      append: (alerts: ConsolidatedAlerts) => T[],
      event: T,
    ): Promise<void> => {
      const subscribers = await loadSubscriberRows(db, stablecoinId, type);
      for (const subscriber of subscribers) {
        const existing = alertsByChat.get(subscriber.chat_id);
        if (existing) {
          existing.lastActiveAt = Math.max(existing.lastActiveAt, subscriber.last_active_at ?? 0);
          append(existing.alerts).push(event);
          continue;
        }
        const alerts = emptyAlerts();
        append(alerts).push(event);
        alertsByChat.set(subscriber.chat_id, {
          lastActiveAt: subscriber.last_active_at ?? 0,
          alerts,
        });
      }
    };

    for (const change of dewsChanges) {
      await queueSubscribers(change.stablecoinId, "dews", (alerts) => alerts.dews, change);
    }
    for (const event of depegTriggered) {
      await queueSubscribers(event.stablecoinId, "depeg", (alerts) => alerts.depegTriggered, event);
    }
    for (const event of depegResolved) {
      await queueSubscribers(event.stablecoinId, "depeg", (alerts) => alerts.depegResolved, event);
    }
    for (const change of safetyChanges) {
      await queueSubscribers(change.stablecoinId, "safety", (alerts) => alerts.safety, change);
    }

    const subscriberQueue = [...alertsByChat.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        lastActiveAt: entry.lastActiveAt,
        alerts: entry.alerts,
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    let subscribersNotified = 0;
    let messagesSent = 0;
    let blockedUsersCleanedUp = 0;

    for (const subscriber of subscriberQueue.slice(0, MAX_MESSAGES_PER_RUN)) {
      throwIfAborted(signal);

      const message = formatConsolidatedMessage(subscriber.alerts);
      const chunks = splitMessage(message);
      const disableNotification = !hasEscalation(subscriber.alerts);

      let deliveredAllChunks = true;
      for (const chunk of chunks) {
        const sendResult = await sendToChat(subscriber.chatId, chunk, botToken, {
          disableWebPagePreview: true,
          disableNotification,
        });

        if (sendResult.blocked) {
          await db
            .prepare("UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?")
            .bind(subscriber.chatId)
            .run();
          blockedUsersCleanedUp++;
          deliveredAllChunks = false;
          break;
        }

        messagesSent++;
      }

      if (deliveredAllChunks && chunks.length > 0) {
        subscribersNotified++;
      }
    }

    await writeSnapshots(db, currentSnapshots);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);

    const result: DispatchResult = {
      eventsDetected: {
        dews: dewsChanges.length,
        depeg: depegTriggered.length + depegResolved.length,
        safety: safetyChanges.length,
      },
      subscribersNotified,
      messagesSent,
      blockedUsersCleanedUp,
      cappedAtLimit: subscriberQueue.length > MAX_MESSAGES_PER_RUN,
      snapshotSeeded: false,
    };
    return { itemCount: messagesSent, metadata: JSON.stringify(result) };
  } catch (error) {
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    throw error;
  }
}
