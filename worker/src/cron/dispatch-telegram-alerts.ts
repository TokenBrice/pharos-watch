import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db";
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
  pendingDrained: number;
  pendingEnqueued: number;
  pendingExpired: number;
}

const MAX_MESSAGES_PER_RUN = 200;
const SNAPSHOT_MAX_AGE_SEC = 86400; // 24h
const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
const SEND_BATCH_SIZE = 5; // Parallel sends per batch (stay under Workers 6-conn limit)

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
  prev_grade: string | null;
  prev_score: number | null;
  recorded_at: number;
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
    pendingDrained: 0,
    pendingEnqueued: 0,
    pendingExpired: 0,
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
      `SELECT s.stablecoin_id, s.chat_id, u.last_active_at
         FROM telegram_subscriptions s
         JOIN telegram_subscribers u ON u.chat_id = s.chat_id
        WHERE s.stablecoin_id IN (${placeholders})
          AND u.${alertColumn} = 1`,
    )
    .bind(...stablecoinIds)
    .all<{ stablecoin_id: string; chat_id: string; last_active_at: number }>();

  const map = new Map<string, SubscriberRow[]>();
  for (const row of result.results ?? []) {
    const existing = map.get(row.stablecoin_id) ?? [];
    existing.push({ chat_id: row.chat_id, last_active_at: row.last_active_at });
    map.set(row.stablecoin_id, existing);
  }
  return map;
}

interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
}

/** Drain pending alerts, oldest first, up to `limit`. Returns count sent + blocked. */
async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ sent: number; blocked: number; failed: number }> {
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
  if (pending.length === 0) return { sent: 0, blocked: 0, failed: 0 };

  let sent = 0;
  let blocked = 0;
  let failed = 0;
  const idsToDelete: number[] = [];
  const idsToRetry: number[] = [];

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          const result = await sendToChat(row.chat_id, row.message_html, botToken, {
            disableWebPagePreview: true,
            disableNotification: row.disable_notification === 1,
          });
          return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
        } catch {
          // Transient failure (500, timeout, etc.) — don't crash the batch
          return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ok: false, blocked: false };
        }
      }),
    );

    for (const result of results) {
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        // Disable alerts for blocked user (best-effort)
        await db
          .prepare(
            "UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?",
          )
          .bind(result.chatId)
          .run()
          .catch(() => {});
      } else {
        // Transient failure — retry up to 2 more times (3 attempts total)
        if (result.attempts >= 2) {
          failed++;
          idsToDelete.push(result.id);
        } else {
          idsToRetry.push(result.id);
        }
      }
    }
  }

  // Delete delivered/expired/failed rows
  if (idsToDelete.length > 0) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${placeholders})`)
      .bind(...idsToDelete)
      .run();
  }

  // Increment attempts for retryable rows
  if (idsToRetry.length > 0) {
    const placeholders = idsToRetry.map(() => "?").join(",");
    await db
      .prepare(
        `UPDATE telegram_pending_alerts SET attempts = attempts + 1 WHERE id IN (${placeholders})`,
      )
      .bind(...idsToRetry)
      .run();
  }

  return { sent, blocked, failed };
}

/** Enqueue pre-split message chunks for delivery in subsequent runs. */
async function enqueuePendingAlerts(
  db: D1Database,
  messages: Array<{ chatId: string; html: string; disableNotification: boolean }>,
  nowSec: number,
): Promise<void> {
  if (messages.length === 0) return;

  // D1 batch — all-or-nothing
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

/** Remove pending alerts older than TTL. */
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
          `SELECT h.stablecoin_id, h.grade, h.score, h.prev_grade, h.prev_score, h.recorded_at
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

    // --- Phase 1: Drain pending queue ---
    const pendingBudget = Math.floor(MAX_MESSAGES_PER_RUN / 4); // Reserve 75% for fresh events
    const drainResult = await drainPendingQueue(db, botToken, pendingBudget, signal);

    throwIfAborted(signal);

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

      if (!previous) {
        // Older dispatcher builds cached only the latest change-day rows, not the latest row per coin.
        // Skip historical rows missing from that partial cache, but still alert if this coin changed since
        // the snapshot was written and the history row carries its previous grade.
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

    // --- Phase 3: Batched subscriber lookups ---
    const dewsIds = dewsChanges.map((c) => c.stablecoinId);
    const depegIds = [
      ...depegTriggered.map((e) => e.stablecoinId),
      ...depegResolved.map((e) => e.stablecoinId),
    ];
    const safetyIds = safetyChanges.map((c) => c.stablecoinId);

    const [dewsSubs, depegSubs, safetySubs] = await Promise.all([
      loadSubscriberRowsBatch(db, dewsIds, "dews"),
      loadSubscriberRowsBatch(db, depegIds, "depeg"),
      loadSubscriberRowsBatch(db, safetyIds, "safety"),
    ]);

    throwIfAborted(signal);

    // --- Phase 4: Build per-chat consolidated alerts ---
    const alertsByChat = new Map<string, { lastActiveAt: number; alerts: ConsolidatedAlerts }>();

    const addToChat = (
      chatId: string,
      lastActiveAt: number,
      append: (alerts: ConsolidatedAlerts) => unknown[],
      event: unknown,
    ): void => {
      const existing = alertsByChat.get(chatId);
      if (existing) {
        existing.lastActiveAt = Math.max(existing.lastActiveAt, lastActiveAt);
        append(existing.alerts).push(event);
        return;
      }
      const alerts = emptyAlerts();
      append(alerts).push(event);
      alertsByChat.set(chatId, { lastActiveAt, alerts });
    };

    for (const change of dewsChanges) {
      for (const sub of dewsSubs.get(change.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.dews, change);
      }
    }
    for (const event of depegTriggered) {
      for (const sub of depegSubs.get(event.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.depegTriggered, event);
      }
    }
    for (const event of depegResolved) {
      for (const sub of depegSubs.get(event.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.depegResolved, event);
      }
    }
    for (const change of safetyChanges) {
      for (const sub of safetySubs.get(change.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.safety, change);
      }
    }

    // --- Phase 5: Format, split, send up to budget, enqueue overflow ---
    // Pre-split ALL messages once (avoid calling splitMessage twice)
    const subscriberQueue = [...alertsByChat.entries()]
      .map(([chatId, entry]) => {
        const message = formatConsolidatedMessage(entry.alerts);
        return {
          chatId,
          lastActiveAt: entry.lastActiveAt,
          alerts: entry.alerts,
          chunks: splitMessage(message),
          disableNotification: !hasEscalation(entry.alerts),
        };
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const freshBudget = MAX_MESSAGES_PER_RUN - drainResult.sent;
    const toSend = subscriberQueue.slice(0, freshBudget);
    const toEnqueue = subscriberQueue.slice(freshBudget);

    // Build flat message list from pre-split chunks
    const sendList: Array<{
      chatId: string;
      html: string;
      disableNotification: boolean;
    }> = [];
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
    let messagesSent = 0;
    let blockedUsersCleanedUp = drainResult.blocked;

    // Track which chats were blocked so we skip counting them
    const blockedChats = new Set<string>();
    for (const result of sendResults) {
      if (result.blocked) {
        if (!blockedChats.has(result.chatId)) {
          blockedChats.add(result.chatId);
          blockedUsersCleanedUp++;
          await db
            .prepare(
              "UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?",
            )
            .bind(result.chatId)
            .run();
        }
      } else if (result.ok) {
        messagesSent++;
      }
    }

    // Count subscribers where at least one chunk succeeded and none blocked
    for (const sub of toSend) {
      if (blockedChats.has(sub.chatId)) continue;
      if (sub.chunks.length > 0) subscribersNotified++;
    }

    // Enqueue overflow — store pre-split chunks so drain path can send directly.
    // Don't enqueue for blocked chats.
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

    if (overflowMessages.length > 0) {
      await enqueuePendingAlerts(db, overflowMessages, nowSec);
    }

    // --- Phase 6: Always write snapshots, then cleanup ---
    await writeSnapshots(db, currentSnapshots);
    const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);

    const result: DispatchResult = {
      eventsDetected: {
        dews: dewsChanges.length,
        depeg: depegTriggered.length + depegResolved.length,
        safety: safetyChanges.length,
      },
      subscribersNotified,
      messagesSent: messagesSent + drainResult.sent,
      blockedUsersCleanedUp,
      cappedAtLimit: toEnqueue.length > 0,
      snapshotSeeded: false,
      pendingDrained: drainResult.sent,
      pendingEnqueued: overflowMessages.length,
      pendingExpired: expiredCount,
    };
    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
  } catch (error) {
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    throw error;
  }
}
