import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import {
  isDewsAlertable,
  isDewsDeescalation,
  type DewsChange,
  type ReserveAlert,
  type SafetyChange,
} from "../../../telegram/common/alerts-formatting";
import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { DEWS_THREAT_BANDS, dewsBandRanges } from "@shared/lib/dews-config";
import {
  extractTopSignals,
  type DewsCandidateSnapshot,
  type DewsRow,
  type DewsSnapshot,
  type SafetySnapshot,
} from "./telegram-alert-snapshots";

const DEWS_POLICY = TELEGRAM_ALERT_POLICY.dews;

/**
 * Exit hysteresis: a coin leaves its previously observed band only once its
 * score falls more than the policy margin below that band's lower bound.
 * Rising moves apply at once; the band can step down one level at a time.
 */
export function applyDewsExitHysteresis(score: number, rawBand: string, previousBand: string | undefined): string {
  if (previousBand == null || !isThreatBand(previousBand) || !isThreatBand(rawBand) ||
    !Number.isFinite(score) || THREAT_BAND_ORDER[rawBand] >= THREAT_BAND_ORDER[previousBand]) return rawBand;
  const ranges = dewsBandRanges();
  for (let index = DEWS_THREAT_BANDS.findIndex((entry) => entry.band === previousBand); index >= 0; index--) {
    const band = DEWS_THREAT_BANDS[index]!.band;
    if (THREAT_BAND_ORDER[band] <= THREAT_BAND_ORDER[rawBand]) break;
    if (score >= ranges[index]![0] - DEWS_POLICY.exitHysteresisPoints) return band;
  }
  return rawBand;
}

export interface DewsAlertPlan {
  changes: DewsChange[];
  /** Observed (hysteresis-applied) band per coin; the next observed baseline. */
  nextObserved: DewsSnapshot;
  /** Sticky last alerted band per coin; the next alertable baseline. */
  nextAlertable: DewsSnapshot;
  nextCandidates: DewsCandidateSnapshot;
  /** Escalations seen in only one DEWS computation so far. */
  suppressedPendingDewsEscalations: number;
  /** Moves down within the alertable range (daily roll-up material). */
  suppressedDewsDeescalations: number;
  /** Alerted-band baselines cleared after the quiet window. */
  resetDewsBaselines: number;
}

/**
 * Real-time DEWS alerts are escalations only, and only once the escalation
 * has appeared in the policy's number of consecutive DEWS computations.
 * Direction is judged against the previously observed band, not the sticky
 * alertable baseline: a coin that calmed below ALERT and now rises into the
 * alertable range escalates, whatever band it reached before. The alertable
 * baseline dedupes a return to the same alert band; it is held while an
 * escalation is pending, and cleared once the coin stays calm for the quiet
 * window so a later alert states the real prior band.
 */
export function planDewsAlerts(
  rows: readonly DewsRow[],
  previousAlertable: DewsSnapshot,
  previousObserved: DewsSnapshot,
  previousCandidates: DewsCandidateSnapshot,
  getSymbol: (stablecoinId: string) => string,
  nowSec: number,
): DewsAlertPlan {
  const plan: DewsAlertPlan = {
    changes: [],
    nextObserved: {},
    nextAlertable: { ...previousAlertable },
    nextCandidates: {},
    suppressedPendingDewsEscalations: 0,
    suppressedDewsDeescalations: 0,
    resetDewsBaselines: 0,
  };
  for (const row of rows) {
    const id = row.stablecoin_id;
    const observedBand = previousObserved[id];
    const band = applyDewsExitHysteresis(row.score, row.band, observedBand);
    plan.nextObserved[id] = band;
    const candidate = previousCandidates[id];

    if (!isDewsAlertable(band)) {
      const quietSinceSec = candidate?.quietSinceSec ?? nowSec;
      if (plan.nextAlertable[id] != null && nowSec - quietSinceSec >= DEWS_POLICY.baselineResetQuietSec) {
        delete plan.nextAlertable[id];
        plan.resetDewsBaselines++;
      }
      plan.nextCandidates[id] = { quietSinceSec };
      continue;
    }

    const oldBand = previousAlertable[id];
    if (oldBand === band) continue;
    // isDewsDeescalation is false unless both bands are threat bands; only an
    // observed alertable band can be the source of an unsent de-escalation.
    // A pending escalation still above the alerted band keeps counting even if
    // it eased from its peak; only a move at or below the alerted band is a
    // real de-escalation that may advance the baseline silently.
    if (
      typeof observedBand === "string" && isDewsAlertable(observedBand) && isDewsDeescalation(observedBand, band) &&
      typeof oldBand === "string" && isThreatBand(oldBand) && isThreatBand(band) &&
      THREAT_BAND_ORDER[band] <= THREAT_BAND_ORDER[oldBand]
    ) {
      plan.nextAlertable[id] = band;
      plan.suppressedDewsDeescalations++;
      continue;
    }

    // Dispatch runs several times per DEWS computation; count distinct ones.
    const computedAt = row.computed_at ?? nowSec;
    const counted = candidate?.computations ?? 0;
    const computations = candidate?.computedAt === computedAt ? counted : counted + 1;
    // The observed baseline moves on while an escalation is pending; keep the
    // band it rose from for the message.
    const fromBand = candidate?.fromBand ??
      (typeof observedBand === "string" ? observedBand : typeof oldBand === "string" ? oldBand : "UNKNOWN");
    if (computations < DEWS_POLICY.escalationMinComputations) {
      plan.nextCandidates[id] = { computedAt, computations, fromBand };
      plan.suppressedPendingDewsEscalations++;
      continue;
    }

    plan.nextAlertable[id] = band;
    plan.changes.push({
      stablecoinId: id,
      symbol: getSymbol(id),
      oldBand: fromBand,
      newBand: band,
      score: row.score,
      topSignals: extractTopSignals(row.signals_json),
    });
  }
  return plan;
}

type SafetySnapshotRow = SafetySnapshot[string];

const SAFETY_POLICY = TELEGRAM_ALERT_POLICY.safety;

type SafetyMoveKind = "severe-downgrade" | "minor-downgrade" | "upgrade";

function classifySafetyMove(oldGrade: string, newGrade: string): SafetyMoveKind | null {
  const oldRank = getReportCardGradeRank(oldGrade);
  const newRank = getReportCardGradeRank(newGrade);
  const floorRank = getReportCardGradeRank(SAFETY_POLICY.severeFloorGrade);
  // Unrankable grades are treated as severe so they are never silently dropped.
  if (oldRank == null || newRank == null || oldRank < 0 || newRank < 0) return "severe-downgrade";
  if (newRank === oldRank) return null;
  if (newRank > oldRank) return "upgrade";
  const intoFloor = floorRank != null && newRank <= floorRank;
  return intoFloor || oldRank - newRank >= SAFETY_POLICY.severeMinGradeNotches
    ? "severe-downgrade"
    : "minor-downgrade";
}

/** Per-coin outcome, replayed by `holdSuppressedSafetyBaselines` to build the next baseline. */
type SafetyDecision =
  | { kind: "advance" }
  | { kind: "hold"; pendingSinceSec?: number; pendingKind?: SafetyPendingKind }
  | { kind: "alert" }
  | { kind: "settle" };

type SafetyPendingKind = NonNullable<SafetySnapshotRow["pendingKind"]>;

export interface SafetyChangeSummary {
  changes: SafetyChange[];
  suppressedMethodologyChanges: number;
  /** Severe downgrades still inside the dwell window. */
  suppressedPendingDwellSafetyChanges: number;
  /** Downgrades below the severe threshold (daily roll-up material). */
  suppressedMinorSafetyChanges: number;
  /** Upgrades, never sent live (daily roll-up material). */
  suppressedUpgradeSafetyChanges: number;
  /** Severe downgrades past the dwell but held until the per-coin cooldown ends. */
  suppressedCooldownSafetyChanges: number;
  decisions: ReadonlyMap<string, SafetyDecision>;
}

/**
 * Live safety alerts are severe downgrades only (>= 2 notches, or into D/F)
 * that have held for the policy dwell against the last alerted grade, with a
 * per-coin cooldown. The persisted baseline keeps the last alerted row while a
 * move is pending, so a flip back inside the dwell is silent and small steps
 * still add up. Upgrades that hold for the dwell become the new baseline
 * silently; everything not sent is counted by reason (R4) for the roll-up.
 */
export function buildSafetyChanges(
  currentSafetySnapshot: SafetySnapshot | null,
  safeSafetySnapshot: SafetySnapshot,
  getSymbol: (stablecoinId: string) => string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SafetyChangeSummary {
  const changes: SafetyChange[] = [];
  const decisions = new Map<string, SafetyDecision>();
  const summary: SafetyChangeSummary = {
    changes,
    suppressedMethodologyChanges: 0,
    suppressedPendingDwellSafetyChanges: 0,
    suppressedMinorSafetyChanges: 0,
    suppressedUpgradeSafetyChanges: 0,
    suppressedCooldownSafetyChanges: 0,
    decisions,
  };
  if (currentSafetySnapshot == null) return summary;

  for (const [stablecoinId, row] of Object.entries(currentSafetySnapshot)) {
    const previous = safeSafetySnapshot[stablecoinId];
    // A gap or quarantine tick mid-dwell keeps the last alerted row and its
    // pending clock; the move is judged again once the coin is rated.
    if (previous?.pendingKind != null && (row.ratingStatus === "pipeline-gap" || row.grade === null || row.operationallyAffected === true)) {
      decisions.set(stablecoinId, { kind: "hold", pendingSinceSec: previous.pendingSinceSec, pendingKind: previous.pendingKind });
      continue;
    }
    // Availability gaps are recovery baselines, not grade movements.
    if (!previous || row.ratingStatus === "pipeline-gap" || previous.ratingStatus === "pipeline-gap" ||
      row.grade === null || previous.grade === null || previous.grade === row.grade ||
      row.operationallyAffected === true || previous.operationallyAffected === true) {
      decisions.set(stablecoinId, { kind: "advance" });
      continue;
    }

    if (
      previous.methodologyVersion &&
      row.methodologyVersion &&
      previous.methodologyVersion !== row.methodologyVersion
    ) {
      summary.suppressedMethodologyChanges++;
      decisions.set(stablecoinId, { kind: "advance" });
      continue;
    }

    const move = classifySafetyMove(previous.grade, row.grade);
    if (move === "minor-downgrade") {
      summary.suppressedMinorSafetyChanges++;
      decisions.set(stablecoinId, { kind: "hold" });
      continue;
    }
    const pendingKind: SafetyPendingKind = move === "upgrade" ? "upgrade" : "severe-downgrade";
    const pendingSinceSec = previous.pendingKind === pendingKind && previous.pendingSinceSec != null
      ? previous.pendingSinceSec
      : nowSec;
    const dwellElapsed = nowSec - pendingSinceSec >= SAFETY_POLICY.dwellSec;

    if (move === "upgrade") {
      summary.suppressedUpgradeSafetyChanges++;
      decisions.set(stablecoinId, dwellElapsed ? { kind: "settle" } : { kind: "hold", pendingSinceSec, pendingKind });
      continue;
    }
    if (!dwellElapsed) {
      summary.suppressedPendingDwellSafetyChanges++;
      decisions.set(stablecoinId, { kind: "hold", pendingSinceSec, pendingKind });
      continue;
    }
    // Inside the cooldown the move stays pending and fires once it ends.
    if (previous.lastAlertedAtSec != null && nowSec - previous.lastAlertedAtSec < SAFETY_POLICY.downgradeCooldownSec) {
      summary.suppressedCooldownSafetyChanges++;
      decisions.set(stablecoinId, { kind: "hold", pendingSinceSec, pendingKind });
      continue;
    }

    decisions.set(stablecoinId, { kind: "alert" });
    changes.push({
      stablecoinId,
      symbol: getSymbol(stablecoinId),
      oldGrade: previous.grade,
      newGrade: row.grade,
      oldScore: previous.score ?? null,
      newScore: row.score ?? null,
    });
  }

  return summary;
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

/**
 * The snapshot to persist as the next safety baseline. Held coins keep their
 * previous (last alerted) row plus the pending-move clock; alerted coins
 * stamp the cooldown clock; every other coin advances to its current row.
 */
export function holdSuppressedSafetyBaselines<Row extends SafetySnapshotRow>(
  currentSafetySnapshot: Record<string, Row>,
  previousSafetySnapshot: Record<string, Row>,
  nowSec: number,
  /** The run delivers nothing: keep the previous row for a due alert so it fires next run. */
  options: { deferAlerts?: boolean } = {},
): Record<string, Row> {
  const { decisions } = buildSafetyChanges(currentSafetySnapshot, previousSafetySnapshot, (id) => id, nowSec);
  const persisted: Record<string, Row> = {};
  for (const [id, current] of Object.entries(currentSafetySnapshot)) {
    const decision = decisions.get(id);
    const previous = previousSafetySnapshot[id];
    if (options.deferAlerts && decision?.kind === "alert" && previous) {
      persisted[id] = previous;
      continue;
    }
    const { pendingSinceSec: _since, pendingKind: _kind, lastAlertedAtSec: _alerted, ...currentRow } = current;
    const lastAlertedAtSec = decision?.kind === "alert" ? nowSec : previous?.lastAlertedAtSec;
    if (decision?.kind === "hold" && previous) {
      const { pendingSinceSec: _p, pendingKind: _k, ...previousRow } = previous;
      persisted[id] = {
        ...previousRow,
        ...(decision.pendingSinceSec != null ? { pendingSinceSec: decision.pendingSinceSec, pendingKind: decision.pendingKind } : {}),
      } as Row;
      continue;
    }
    persisted[id] = { ...currentRow, ...(lastAlertedAtSec != null ? { lastAlertedAtSec } : {}) } as Row;
  }
  return persisted;
}

/**
 * Baseline for a safety reseed. Every coin keeps its cooldown clock. When the
 * publication identities are comparable (continuity loss, generation change),
 * a coin with a pending live-alert move also keeps its previous row so the
 * dwell resumes; across an incomparable identity (model/methodology change)
 * current rows become the baseline silently.
 */
export function reseedSafetyBaseline<Row extends SafetySnapshotRow>(
  currentSafetySnapshot: Record<string, Row>,
  previousSafetySnapshot: Record<string, Row> | null,
  carryPending: boolean,
): Record<string, Row> {
  if (previousSafetySnapshot == null) return currentSafetySnapshot;
  const persisted: Record<string, Row> = {};
  for (const [id, current] of Object.entries(currentSafetySnapshot)) {
    const previous = previousSafetySnapshot[id];
    if (carryPending && previous?.pendingKind != null && previous.grade !== null) {
      persisted[id] = previous;
      continue;
    }
    const { pendingSinceSec: _since, pendingKind: _kind, lastAlertedAtSec: _alerted, ...currentRow } = current;
    persisted[id] = (previous?.lastAlertedAtSec != null
      ? { ...currentRow, lastAlertedAtSec: previous.lastAlertedAtSec }
      : currentRow) as Row;
  }
  return persisted;
}
