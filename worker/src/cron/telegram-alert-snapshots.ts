import { isDewsAlertable, type DepegAlertPayload } from "../lib/telegram-alerts";
import { setCache } from "../lib/db-cache";
import { DAY_SECONDS } from "@shared/lib/time-constants";
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
} as const;

export const SNAPSHOT_MAX_AGE_SEC = DAY_SECONDS; // 24h

export const SAFETY_GRADE_RANK: Record<string, number> = {
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
  const oldRank = SAFETY_GRADE_RANK[oldGrade];
  const newRank = SAFETY_GRADE_RANK[newGrade];
  if (oldRank == null || newRank == null) return false;
  return newRank > oldRank;
}

// ---------- Snapshot Persistence ----------

export async function writeSnapshots(
  db: D1Database,
  snapshots: {
    dews: DewsSnapshot;
    dewsAlertable: DewsSnapshot;
    depeg: DepegSnapshot;
    safety?: AlertSafetySnapshotEnvelope | null;
    launch: string[];
  },
): Promise<void> {
  const writes: Promise<unknown>[] = [
    setCache(db, SNAPSHOT_KEYS.dews, JSON.stringify(snapshots.dews)),
    setCache(db, SNAPSHOT_KEYS.dewsAlertable, JSON.stringify(snapshots.dewsAlertable)),
    setCache(db, SNAPSHOT_KEYS.depeg, JSON.stringify(snapshots.depeg)),
    setCache(db, SNAPSHOT_KEYS.launch, JSON.stringify(snapshots.launch)),
  ];

  if (snapshots.safety) {
    writes.push(setCache(db, SNAPSHOT_KEYS.safety, JSON.stringify(snapshots.safety)));
  }

  await Promise.all(writes);
}
