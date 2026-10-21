import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "@shared/lib/safety-score-v9/facts";
import type { DewsChange, LaunchAlert, ReserveAlert, SafetyChange } from "../../../telegram/common/alerts-formatting";
import {
  extractTopSignals,
  type DewsRow,
  type DewsSnapshot,
  type SafetySnapshot,
} from "./telegram-alert-snapshots";

export function buildDewsChanges(
  rows: readonly DewsRow[],
  safeDewsAlertable: DewsSnapshot,
  safeDewsSnapshot: DewsSnapshot,
  getSymbol: (stablecoinId: string) => string,
): DewsChange[] {
  const dewsChanges: DewsChange[] = [];
  for (const row of rows) {
    const oldBand = safeDewsAlertable[row.stablecoin_id];
    if (oldBand === row.band) continue;
    dewsChanges.push({
      stablecoinId: row.stablecoin_id,
      symbol: getSymbol(row.stablecoin_id),
      oldBand:
        typeof oldBand === "string"
          ? oldBand
          : typeof safeDewsSnapshot[row.stablecoin_id] === "string"
            ? safeDewsSnapshot[row.stablecoin_id]
            : "UNKNOWN",
      newBand: row.band,
      score: row.score,
      topSignals: extractTopSignals(row.signals_json),
    });
  }
  return dewsChanges;
}

/** Minimum grade distance (in notches, e.g. C to C+ is 1) for a safety alert. */
export const SAFETY_ALERT_MIN_GRADE_NOTCHES = 2;

/**
 * Reason codes that mean a live input was unavailable this run: every code the
 * V9 responsibility map attributes to a producer failure, plus the runtime
 * route/materiality codes it files as integration-missing. Reviewer-authored
 * findings are deliberately excluded so a real adverse finding still alerts.
 */
const RUNTIME_INTEGRATION_MISSING_REASON_CODES = [
  "runtime-bridge-materiality-unavailable",
  "selected-bridge-route-unresolved",
  "unresolved-exit-output",
  "missing-same-notional-route",
] as const satisfies readonly (keyof typeof V9_LEGACY_RESPONSIBILITY_BY_REASON)[];

export const SAFETY_RUNTIME_AVAILABILITY_REASON_CODES: ReadonlySet<string> = new Set([
  ...Object.entries(V9_LEGACY_RESPONSIBILITY_BY_REASON)
    // Unmatched material bridge supply can be a real exploit mint; never hold it.
    .filter(([code, responsibility]) => responsibility === "producer-failed" && code !== "material-bridge-supply-unmatched")
    .map(([code]) => code),
  ...RUNTIME_INTEGRATION_MISSING_REASON_CODES,
]);

/** An availability move that persists this long is treated as real and alerts. */
export const SAFETY_AVAILABILITY_HOLD_MAX_SEC = 6 * 60 * 60;

type SafetySnapshotRow = SafetySnapshot[string];

/** Null when the row predates persisted reason codes (unknown, never "toggled"). */
function runtimeAvailabilityCodes(row: SafetySnapshotRow): Set<string> | null {
  const codes = row.v9Explain?.reasonCodes;
  if (codes == null) return null;
  return new Set(codes.filter((code) => SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has(code)));
}

function runtimeAvailabilityToggled(previous: SafetySnapshotRow, current: SafetySnapshotRow): boolean {
  if (JSON.stringify(previous.partialEvidence ?? null) !== JSON.stringify(current.partialEvidence ?? null)) return true;
  const before = runtimeAvailabilityCodes(previous);
  const after = runtimeAvailabilityCodes(current);
  if (before == null || after == null) return false;
  for (const code of before) if (!after.has(code)) return true;
  for (const code of after) if (!before.has(code)) return true;
  return false;
}

function isDowngradeIntoDOrF(oldGrade: string, newGrade: string): boolean {
  const oldRank = getReportCardGradeRank(oldGrade);
  const newRank = getReportCardGradeRank(newGrade);
  const dRank = getReportCardGradeRank("D");
  return oldRank != null && newRank != null && dRank != null && newRank >= 0 && newRank <= dRank && newRank < oldRank;
}

function gradeNotchDistance(oldGrade: string, newGrade: string): number {
  const oldRank = getReportCardGradeRank(oldGrade);
  const newRank = getReportCardGradeRank(newGrade);
  // Unrankable grades are never suppressed as minor.
  if (oldRank == null || newRank == null || oldRank < 0 || newRank < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(newRank - oldRank);
}

export function buildSafetyChanges(
  currentSafetySnapshot: SafetySnapshot | null,
  safeSafetySnapshot: SafetySnapshot,
  getSymbol: (stablecoinId: string) => string,
  nowSec: number = Math.floor(Date.now() / 1000),
): {
  changes: SafetyChange[];
  suppressedMethodologyChanges: number;
  suppressedRuntimeAvailabilityChanges: number;
  suppressedMinorSafetyChanges: number;
  /** Coins whose suppressed move must keep the prior row as the alert baseline. */
  heldBaselineIds: string[];
  /** Subset of heldBaselineIds held for an availability toggle (time-capped). */
  availabilityHeldIds: string[];
} {
  const changes: SafetyChange[] = [];
  const heldBaselineIds: string[] = [];
  const availabilityHeldIds: string[] = [];
  let suppressedMethodologyChanges = 0;
  let suppressedRuntimeAvailabilityChanges = 0;
  let suppressedMinorSafetyChanges = 0;

  if (currentSafetySnapshot == null) {
    return { changes, suppressedMethodologyChanges, suppressedRuntimeAvailabilityChanges, suppressedMinorSafetyChanges, heldBaselineIds, availabilityHeldIds };
  }

  for (const [stablecoinId, row] of Object.entries(currentSafetySnapshot)) {
    const previous = safeSafetySnapshot[stablecoinId];
    // Availability gaps are recovery baselines, not grade movements.
    if (!previous || row.ratingStatus === "pipeline-gap" || previous.ratingStatus === "pipeline-gap" ||
      row.grade === null || previous.grade === null || previous.grade === row.grade) continue;
    if (
      row.operationallyAffected === true ||
      previous?.operationallyAffected === true
    ) {
      continue;
    }

    if (
      previous?.methodologyVersion &&
      row.methodologyVersion &&
      previous.methodologyVersion !== row.methodologyVersion
    ) {
      suppressedMethodologyChanges++;
      continue;
    }

    // A grade that moves only because a live input appeared or disappeared is
    // an availability toggle, not a risk change (R1/R2). Suppressed moves keep
    // the prior row as baseline, so a move that persists after the input
    // returns, or minor steps that add up, are still compared against the
    // last alerted grade.
    const holdExpired = previous.heldSinceSec != null &&
      nowSec - previous.heldSinceSec >= SAFETY_AVAILABILITY_HOLD_MAX_SEC;
    if (!holdExpired && runtimeAvailabilityToggled(previous, row)) {
      suppressedRuntimeAvailabilityChanges++;
      heldBaselineIds.push(stablecoinId);
      availabilityHeldIds.push(stablecoinId);
      continue;
    }

    if (
      !isDowngradeIntoDOrF(previous.grade, row.grade) &&
      gradeNotchDistance(previous.grade, row.grade) < SAFETY_ALERT_MIN_GRADE_NOTCHES
    ) {
      suppressedMinorSafetyChanges++;
      heldBaselineIds.push(stablecoinId);
      continue;
    }

    changes.push({
      stablecoinId,
      symbol: getSymbol(stablecoinId),
      oldGrade: previous.grade,
      newGrade: row.grade,
      oldScore: previous.score ?? null,
      newScore: row.score ?? null,
    });
  }

  return { changes, suppressedMethodologyChanges, suppressedRuntimeAvailabilityChanges, suppressedMinorSafetyChanges, heldBaselineIds, availabilityHeldIds };
}

/**
 * Reserve-drift transitions (C123). Fires only on the not-drifting → drifting
 * edge: a coin present in the current drift id-set but absent from the prior
 * one. Dispatch supplies comparable observed baselines and cold-seeds returning
 * assets after observation gaps; leaving the drift set produces no event.
 */
export function buildReserveTransitions(
  previousDriftIds: ReadonlySet<string>,
  currentDriftIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, { symbol: string; name: string }>,
): ReserveAlert[] {
  const transitions: ReserveAlert[] = [];
  for (const id of currentDriftIds) {
    if (previousDriftIds.has(id)) continue;
    const coin = trackedMetaById.get(id);
    if (coin) {
      transitions.push({ stablecoinId: id, symbol: coin.symbol, name: coin.name });
    }
  }
  return transitions;
}

export function buildLaunchPromotions(
  previousLaunchIds: ReadonlySet<string>,
  currentLaunchIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, { symbol: string; name: string }>,
): LaunchAlert[] {
  const launchPromoted: LaunchAlert[] = [];
  for (const id of previousLaunchIds) {
    if (!currentLaunchIds.has(id) && activeIds.has(id)) {
      const coin = trackedMetaById.get(id);
      if (coin) {
        launchPromoted.push({
          stablecoinId: id,
          symbol: coin.symbol,
          name: coin.name,
        });
      }
    }
  }
  return launchPromoted;
}

/**
 * The snapshot to persist as the next safety baseline: current rows, except
 * coins whose move was suppressed keep their previous (last alerted) row.
 */
export function holdSuppressedSafetyBaselines<Row extends SafetySnapshotRow>(
  currentSafetySnapshot: Record<string, Row>,
  previousSafetySnapshot: Record<string, Row>,
  nowSec: number,
): Record<string, Row> {
  const { heldBaselineIds, availabilityHeldIds } = buildSafetyChanges(
    currentSafetySnapshot, previousSafetySnapshot, (id) => id, nowSec,
  );
  if (heldBaselineIds.length === 0) return currentSafetySnapshot;
  const availabilityHeld = new Set(availabilityHeldIds);
  const persisted: Record<string, Row> = { ...currentSafetySnapshot };
  for (const id of heldBaselineIds) {
    const { heldSinceSec, ...previous } = previousSafetySnapshot[id]!;
    persisted[id] = (availabilityHeld.has(id)
      ? { ...previous, heldSinceSec: heldSinceSec ?? nowSec }
      : previous) as Row;
  }
  return persisted;
}
