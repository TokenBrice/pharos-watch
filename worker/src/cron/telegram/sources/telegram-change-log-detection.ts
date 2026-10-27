import { executeAtomicBatch } from "../../../lib/db";
import { getCache, prepareCacheUpsert } from "../../../lib/db-cache";
import { parseJsonObject } from "../../../lib/json-parse";
import type { DewsChange, ReserveAlert } from "../../../telegram/common/alerts-formatting";
import {
  buildTelegramChangeLogStatements,
  type TelegramChangeLogEntry,
} from "../rollup/change-log";
import type { DewsRow, SafetySnapshot } from "./telegram-alert-snapshots";

/**
 * The published grade per coin as last written to the change log. It is
 * separate from the live-alert baseline, which holds the last *alerted* grade
 * while a move is pending, so every published move is logged exactly once.
 */
const SAFETY_OBSERVED_CACHE_KEY = "telegram:rollup:safety-observed";

type ObservedSafety = Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;

function parseObservedSafety(raw: string | undefined): ObservedSafety | null {
  if (raw == null) return null;
  const parsed = parseJsonObject(raw, "telegram roll-up safety observed snapshot");
  return parsed ? (parsed as ObservedSafety) : null;
}

/**
 * Diff the current published grades against the observed snapshot. Gaps,
 * quarantine and operational holds keep the previous grade (unavailable is
 * not a change, R1); a methodology change re-baselines silently, as live
 * alerts do; the first run seeds without entries.
 */
export function diffObservedSafetyGrades(
  previous: ObservedSafety | null,
  current: SafetySnapshot,
  getSymbol: (stablecoinId: string) => string,
  nowSec: number,
): { entries: TelegramChangeLogEntry[]; next: ObservedSafety } {
  const entries: TelegramChangeLogEntry[] = [];
  const next: ObservedSafety = {};
  for (const [id, row] of Object.entries(current)) {
    const prior = previous?.[id];
    if (row.grade === null || row.ratingStatus === "pipeline-gap" || row.operationallyAffected === true) {
      if (prior) next[id] = prior;
      continue;
    }
    next[id] = { grade: row.grade, score: row.score ?? null, methodologyVersion: row.methodologyVersion ?? null };
    if (!prior || prior.grade === row.grade) continue;
    if (prior.methodologyVersion && row.methodologyVersion && prior.methodologyVersion !== row.methodologyVersion) continue;
    entries.push({
      kind: "safety",
      stablecoinId: id,
      sourceKey: `safety:${id}:${prior.grade}>${row.grade}:${nowSec}`,
      observedAt: nowSec,
      payload: { symbol: getSymbol(id), from: prior.grade, to: row.grade, fromScore: prior.score, toScore: row.score ?? null },
    });
  }
  return { entries, next };
}

function utcDate(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

/** DEWS moves for the roll-up: every escalation (for digest-only global opt-ins) and every unsent de-escalation. */
function buildDewsChangeLogEntries(
  changes: readonly DewsChange[],
  rows: readonly DewsRow[],
  nowSec: number,
): TelegramChangeLogEntry[] {
  const computedAtById = new Map(rows.map((row) => [row.stablecoin_id, row.computed_at ?? nowSec] as const));
  return changes.map((change) => {
    const computedAt = computedAtById.get(change.stablecoinId) ?? nowSec;
    return {
      kind: "dews",
      stablecoinId: change.stablecoinId,
      // Keyed by the DEWS computation, so a dispatch retry of the same move is a no-op.
      sourceKey: `dews:${change.stablecoinId}:${change.oldBand}>${change.newBand}:${computedAt}`,
      observedAt: nowSec,
      payload: { symbol: change.symbol, from: change.oldBand, to: change.newBand, score: change.score },
    };
  });
}

function buildReserveChangeLogEntries(alerts: readonly ReserveAlert[], nowSec: number): TelegramChangeLogEntry[] {
  return alerts.map((alert) => ({
    kind: "reserve",
    stablecoinId: alert.stablecoinId,
    // At most one drift entry per coin per UTC day, however often dispatch retries.
    sourceKey: `reserve:${alert.stablecoinId}:${utcDate(nowSec)}`,
    observedAt: nowSec,
    payload: { symbol: alert.symbol, name: alert.name },
  }));
}

/**
 * Persist this run's roll-up material. The observed safety snapshot advances
 * in the same batch as its entries; DEWS and reserve entries are idempotent
 * on their source keys, so a failed dispatch that re-detects them is harmless.
 */
export async function recordDispatchChangeLog(
  db: D1Database,
  input: {
    currentSafetySnapshot: SafetySnapshot | null;
    dewsChanges: readonly DewsChange[];
    dewsRows: readonly DewsRow[];
    reserveAlerts: readonly ReserveAlert[];
    getSymbol: (stablecoinId: string) => string;
    nowSec: number;
  },
): Promise<number> {
  const entries = [
    ...buildDewsChangeLogEntries(input.dewsChanges, input.dewsRows, input.nowSec),
    ...buildReserveChangeLogEntries(input.reserveAlerts, input.nowSec),
  ];
  let observedWrite: D1PreparedStatement | null = null;
  if (input.currentSafetySnapshot != null) {
    const cached = await getCache(db, SAFETY_OBSERVED_CACHE_KEY);
    const previousRaw = cached?.value;
    const safety = diffObservedSafetyGrades(
      parseObservedSafety(previousRaw),
      input.currentSafetySnapshot,
      input.getSymbol,
      input.nowSec,
    );
    entries.push(...safety.entries);
    const nextRaw = JSON.stringify(safety.next);
    if (nextRaw !== previousRaw) {
      observedWrite = prepareCacheUpsert(db, { key: SAFETY_OBSERVED_CACHE_KEY, value: nextRaw, updatedAt: input.nowSec });
    }
  }
  const statements = [
    ...buildTelegramChangeLogStatements(db, entries),
    ...(observedWrite ? [observedWrite] : []),
  ];
  if (statements.length > 0) await executeAtomicBatch(db, statements);
  return entries.length;
}
