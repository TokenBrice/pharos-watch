import { isDewsAlertable, type DepegAlertPayload } from "../lib/telegram-alerts";
import { setCacheMany } from "../lib/db-cache";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  getReportCardGradeRank,
  REPORT_CARD_GRADE_RANK,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "@shared/lib/report-card-core";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import type {
  AlertSafetySnapshotEnvelope,
  AlertSafetySourceSnapshot,
} from "../lib/alert-safety-source-cache";

// ---------- Constants ----------

export const SNAPSHOT_KEYS = {
  dews: "alert:dews-snapshot",
  dewsAlertable: "alert:dews-alertable-snapshot",
  depeg: "alert:depeg-snapshot",
  safety: "alert:safety-snapshot",
  launch: "alert:launch-snapshot",
  // Reserve-drift snapshot. Written by the four-hourly reserve slot
  // (hourly-live-reserves.ts) as the LAUNCH-STYLE id-set of currently-drifting
  // coins; the dispatch cron only diffs prior-vs-current from this cache and
  // never recomputes drift (keeps reserve-adapter I/O out of the dispatch pool).
  reserve: "alert:reserve-snapshot",
  // Dispatch-owned baseline for the reserve-drift family: the drift id-set the
  // dispatcher last acted on. Diffing the producer's `reserve` set against this
  // baseline yields the not-drifting → drifting transitions. Distinct from the
  // producer key so the producer (4-hourly) and dispatcher (frequent) never
  // race on a single key.
  reserveDispatched: "alert:reserve-dispatched-snapshot",
} as const;

export const SNAPSHOT_MAX_AGE_SEC = DAY_SECONDS; // 24h

export const SAFETY_GRADE_RANK: Readonly<Record<string, number>> = REPORT_CARD_GRADE_RANK;

// ---------- Types ----------

export type DewsSnapshot = Record<string, string>;
export type DepegSnapshot = Record<string, DepegAlertPayload>;
export type SafetySnapshot = AlertSafetySourceSnapshot;

export interface DewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string | null;
}

export interface ActiveDepegRow {
  stablecoin_id: string;
  symbol: string;
  direction: "above" | "below";
  peak_deviation_bps: number;
  start_price: number;
  peg_reference: number;
}

export interface ClosedDepegRow {
  stablecoin_id: string;
  symbol: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number;
  recovery_price: number | null;
}

export interface SafetyRow {
  stablecoin_id: string;
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  recorded_at: number;
  methodology_version: string | null;
}

// ---------- Snapshot Parsing ----------

export function parseSnapshotMap<T extends Record<string, unknown>>(
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

export function isSnapshotMissingOrStale(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): boolean {
  return !cached || nowSec - cached.updatedAt > SNAPSHOT_MAX_AGE_SEC;
}

// ---------- Snapshot Building ----------

export function buildDewsSnapshot(rows: DewsRow[]): DewsSnapshot {
  const snapshot: DewsSnapshot = {};
  for (const row of rows) {
    snapshot[row.stablecoin_id] = row.band;
  }
  return snapshot;
}

export function buildDewsAlertableSnapshot(
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

export function filterAlertableBands(snapshot: DewsSnapshot | null): DewsSnapshot {
  if (!snapshot) return {};
  const filtered: DewsSnapshot = {};
  for (const [stablecoinId, band] of Object.entries(snapshot)) {
    if (!isDewsAlertable(band)) continue;
    filtered[stablecoinId] = band;
  }
  return filtered;
}

export function buildDepegSnapshot(rows: ActiveDepegRow[]): DepegSnapshot {
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

export function buildSafetySnapshot(rows: SafetyRow[]): SafetySnapshot {
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

// ---------- Signal Extraction ----------

export function extractTopSignals(signalsJson: string | null): Array<{ name: string; value: number }> {
  if (!signalsJson) return [];
  try {
    const unwrapped = unwrapStressSignalsEnvelope(JSON.parse(signalsJson));
    if (unwrapped == null) return [];
    return Object.entries(unwrapped.signals)
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

// ---------- Safety Grade Helpers ----------

export function isSafetyDeescalation(oldGrade: string, newGrade: string): boolean {
  const oldRank = getReportCardGradeRank(oldGrade, UNKNOWN_REPORT_CARD_GRADE_RANK);
  const newRank = getReportCardGradeRank(newGrade, UNKNOWN_REPORT_CARD_GRADE_RANK);
  if (oldRank == null || newRank == null) return false;
  return newRank > oldRank;
}

// ---------- Snapshot Persistence ----------

export interface TelegramAlertSnapshots {
  dews: DewsSnapshot;
  dewsAlertable: DewsSnapshot;
  depeg: DepegSnapshot;
  safety?: AlertSafetySnapshotEnvelope | null;
  launch: string[];
  reserveDispatched: string[] | null;
}

export function buildTelegramSnapshotCacheEntries(
  snapshots: TelegramAlertSnapshots,
): Array<{ key: string; value: string }> {
  const writes: Array<{ key: string; value: string }> = [
    { key: SNAPSHOT_KEYS.dews, value: JSON.stringify(snapshots.dews) },
    { key: SNAPSHOT_KEYS.dewsAlertable, value: JSON.stringify(snapshots.dewsAlertable) },
    { key: SNAPSHOT_KEYS.depeg, value: JSON.stringify(snapshots.depeg) },
    { key: SNAPSHOT_KEYS.launch, value: JSON.stringify(snapshots.launch) },
    { key: SNAPSHOT_KEYS.reserveDispatched, value: JSON.stringify(snapshots.reserveDispatched) },
  ];

  if (snapshots.safety) {
    writes.push({ key: SNAPSHOT_KEYS.safety, value: JSON.stringify(snapshots.safety) });
  }

  return writes;
}

export async function writeSnapshots(
  db: D1Database,
  snapshots: TelegramAlertSnapshots,
): Promise<void> {
  await setCacheMany(db, buildTelegramSnapshotCacheEntries(snapshots));
}
