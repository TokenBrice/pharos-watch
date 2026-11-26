import { isDewsAlertable, type DepegAlertPayload } from "../../../telegram/common/alerts-formatting";
import { setCacheMany } from "../../../lib/db-cache";
import { parseJsonObject } from "../../../lib/json-parse";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import type { DepegEventQuoteDomain } from "@shared/types/peg";
import {
  getReportCardGradeRank,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "@shared/lib/report-card-core";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import type {
  AlertSafetySnapshotEnvelope,
  AlertSafetySourceRow,
} from "@shared/types/status/telegram";

export const SNAPSHOT_KEYS = {
  dews: "alert:dews-snapshot",
  dewsAlertable: "alert:dews-alertable-snapshot",
  // Per-coin DEWS escalation persistence and quiet-window clocks.
  dewsCandidates: "alert:dews-candidate-snapshot",
  depeg: "alert:depeg-snapshot",
  depegRecoveries: "alert:depeg-pending-recoveries",
  safety: "alert:safety-snapshot",
  // Reserve-drift snapshot. Written by the four-hourly reserve post-sync
  // watchdog (reserve-post-sync-watchdog.ts) as a versioned envelope carrying
  // the drift id-set, observation epochs, and optional per-coin drift scores;
  // the dispatch cron only diffs prior-vs-current from this cache and never
  // recomputes drift (keeps reserve-adapter I/O out of the dispatch pool).
  reserve: "alert:reserve-snapshot",
  // Dispatch-owned baseline for the reserve-drift family: the drift id-set the
  // dispatcher last acted on. Diffing the producer's `reserve` set against this
  // baseline yields the not-drifting → drifting transitions. Distinct from the
  // producer key so the producer (4-hourly) and dispatcher (frequent) never
  // race on a single key.
  reserveDispatched: "alert:reserve-dispatched-snapshot",
  reserveObserved: "alert:reserve-observed-snapshot",
} as const;

export const SNAPSHOT_MAX_AGE_SEC = DAY_SECONDS; // 24h

export type DewsSnapshot = Record<string, string>;
/**
 * Pending escalation: distinct DEWS computations seen so far (`computedAt` is
 * the last one counted) and the band it rose from. Calm coin: when it last
 * went below ALERT.
 */
export type DewsCandidateSnapshot = Record<string, {
  computedAt?: number;
  computations?: number;
  fromBand?: string;
  quietSinceSec?: number;
}>;
export type DepegSnapshot = Record<string, DepegAlertPayload & { eventId?: number; recoveryPending?: true }>;
export type SafetySnapshot = Record<string,
  Omit<AlertSafetySourceRow, "v9Explain"> & Partial<Pick<AlertSafetySourceRow, "v9Explain">>
>;

export interface DewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  signals_json: string | null;
  computed_at?: number;
}

export interface ActiveDepegRow {
  event_id?: number;
  started_at?: number;
  stablecoin_id: string;
  symbol: string;
  direction: "above" | "below";
  peak_deviation_bps: number;
  start_price: number;
  peak_price: number | null;
  peg_reference: number;
  peg_type?: string;
  source?: string;
  quote_mode?: string | null;
  peak_peg_reference?: number | null;
  peak_quote_domain?: DepegEventQuoteDomain | null;
  pending_reason?: string | null;
  peer_basis_json?: string | null;
}

type PeakDomainRow = Pick<ActiveDepegRow, "peak_quote_domain" | "source" | "peg_type" | "peg_reference" | "quote_mode">;

function isNativeDepegPeak(row: PeakDomainRow): boolean {
  return row.peak_quote_domain == null ? isNativePegEvent(row) : row.peak_quote_domain === "native-peg";
}

export function projectDepegPeakBasis(
  row: PeakDomainRow & Pick<ActiveDepegRow, "pending_reason" | "peer_basis_json">,
): Pick<DepegAlertPayload, "peakBasis"> {
  const receipt = parseJsonObject<{ peak?: { basis?: unknown } | null }>(row.peer_basis_json);
  const basis = receipt?.peak?.basis;
  if (basis === "peer-relative" || basis === "native-peg") return { peakBasis: basis };
  if (basis === "benchmark") return {};
  if (row.peak_quote_domain === "native-peg") return { peakBasis: "native-peg" };
  if (row.pending_reason?.split("+").includes("peer-relative")) return { peakBasis: "peer-relative" };
  return isNativeDepegPeak(row) ? { peakBasis: "native-peg" } : {};
}

export function projectDepegPeakPrice(row: ActiveDepegRow): Pick<DepegAlertPayload, "price" | "pegReference" | "priceCurrency" | "peakBasis"> {
  const peg = getPegTaxonomyByType(row.peg_type);
  const native = isNativeDepegPeak(row);
  const price = row.peak_price != null && Number.isFinite(row.peak_price) && row.peak_price > 0 ? row.peak_price : null;
  const reference = row.peak_peg_reference;
  const legacyPar = row.peak_quote_domain == null && row.peg_reference === 1 && (native || peg?.currency === "USD");
  return {
    price,
    pegReference: reference != null && Number.isFinite(reference) && reference > 0 ? reference
      : legacyPar ? 1 : null,
    priceCurrency: native ? peg?.currency : "USD",
    ...projectDepegPeakBasis(row),
  };
}

export interface ReserveDriftScores {
  liveScore: number;
  curatedScore: number;
}

export function buildReserveDriftScoreMap(
  entries: readonly { id: string; liveScore: number; curatedScore: number }[],
): Record<string, ReserveDriftScores> {
  const scores: Record<string, ReserveDriftScores> = {};
  for (const entry of entries) {
    if (!Number.isFinite(entry.liveScore) || !Number.isFinite(entry.curatedScore)) continue;
    scores[entry.id] = { liveScore: entry.liveScore, curatedScore: entry.curatedScore };
  }
  return scores;
}

/**
 * Read optional per-coin `{ liveScore, curatedScore }` attached to the
 * `alert:reserve-snapshot` envelope. Legacy envelopes lacking `driftScores`
 * (or carrying invalid entries) cleanly return `{}` so observation continuity
 * and alert delivery stay 100% backwards-compatible.
 */
export function parseReserveDriftScores(
  cached: { value: string; updatedAt: number } | null,
): Record<string, ReserveDriftScores> {
  if (!cached) return {};
  const parsed = parseJsonObject<{ driftScores?: unknown }>(cached.value);
  if (!parsed || !parsed.driftScores || typeof parsed.driftScores !== "object" || Array.isArray(parsed.driftScores)) {
    return {};
  }
  const scores: Record<string, ReserveDriftScores> = {};
  for (const [id, raw] of Object.entries(parsed.driftScores as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as { liveScore?: unknown; curatedScore?: unknown };
    if (typeof entry.liveScore === "number" && Number.isFinite(entry.liveScore)
      && typeof entry.curatedScore === "number" && Number.isFinite(entry.curatedScore)) {
      scores[id] = { liveScore: entry.liveScore, curatedScore: entry.curatedScore };
    }
  }
  return scores;
}

export function parseSnapshotMap<T extends Record<string, unknown>>(
  cached: { value: string; updatedAt: number } | null,
): T | null {
  if (!cached) return null;
  // Corrupted or legacy cache values parse to null.
  return parseJsonObject<T>(cached.value);
}

export function isSnapshotMissingOrStale(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): boolean {
  return !cached || nowSec - cached.updatedAt > SNAPSHOT_MAX_AGE_SEC;
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
      eventId: row.event_id,
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      direction: row.direction,
      deviationBps: Math.abs(Number(row.peak_deviation_bps ?? 0)),
      ...projectDepegPeakPrice(row),
    };
  }
  return snapshot;
}

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

export function isSafetyDeescalation(oldGrade: string, newGrade: string): boolean {
  const oldRank = getReportCardGradeRank(oldGrade, UNKNOWN_REPORT_CARD_GRADE_RANK);
  const newRank = getReportCardGradeRank(newGrade, UNKNOWN_REPORT_CARD_GRADE_RANK);
  if (oldRank == null || newRank == null) return false;
  return newRank > oldRank;
}

export interface TelegramAlertSnapshots {
  dews: DewsSnapshot;
  dewsAlertable: DewsSnapshot;
  /** Absent on source-event baselines written before DEWS persistence. */
  dewsCandidates?: DewsCandidateSnapshot;
  /** The DEWS read was unavailable this run: leave all DEWS keys untouched. */
  dewsUnavailable?: boolean;
  depeg: DepegSnapshot;
  safety?: AlertSafetySnapshotEnvelope | null;
  reserveDispatched: string[] | null;
  reserveObserved?: Record<string, number> | null;
}

export function buildTelegramSnapshotCacheEntries(
  snapshots: TelegramAlertSnapshots,
): Array<{ key: string; value: string }> {
  // Older Workers interpret every entry in the depeg snapshot as an active event.
  const active: DepegSnapshot = {};
  const pending: DepegSnapshot = {};
  for (const [id, row] of Object.entries(snapshots.depeg)) {
    if (row.recoveryPending) pending[id] = row;
    else active[id] = row;
  }
  const writes: Array<{ key: string; value: string }> = [
    ...(snapshots.dewsUnavailable ? [] : [
      { key: SNAPSHOT_KEYS.dews, value: JSON.stringify(snapshots.dews) },
      { key: SNAPSHOT_KEYS.dewsAlertable, value: JSON.stringify(snapshots.dewsAlertable) },
    ]),
    { key: SNAPSHOT_KEYS.depeg, value: JSON.stringify(active) },
    { key: SNAPSHOT_KEYS.depegRecoveries, value: JSON.stringify(pending) },
    { key: SNAPSHOT_KEYS.reserveDispatched, value: JSON.stringify(snapshots.reserveDispatched) },
    { key: SNAPSHOT_KEYS.reserveObserved, value: JSON.stringify(snapshots.reserveObserved ?? null) },
  ];

  if (snapshots.dewsCandidates && !snapshots.dewsUnavailable) {
    writes.push({ key: SNAPSHOT_KEYS.dewsCandidates, value: JSON.stringify(snapshots.dewsCandidates) });
  }
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
