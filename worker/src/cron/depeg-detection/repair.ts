import { readPendingObservationReceipt } from "../../lib/depeg-pending";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { isPairedDepegPeak, parsePendingReason, rowPriceCoverage, serializeDepegPriceCoverage, type DepegRow } from "../../lib/depeg-helpers";
import { mergeDepegIntervals } from "@shared/lib/peg-utils";
import { maxNullableInt } from "../../lib/depeg-escalation-metadata";
import type { DepegDetectionRow, DepegDiagnostic, DepegPersistenceCommand } from "./types";

export interface OrphanDepegRow {
  id: number;
  stablecoin_id: string;
  started_at: number;
}

export interface DuplicateRepairResult<T extends DepegRow = DepegRow> {
  openEvents: Map<string, T>;
  commands: DepegPersistenceCommand[];
}

export interface OrphanRepairResult {
  commands: DepegPersistenceCommand[];
  diagnostics: DepegDiagnostic[];
}

/**
 * Whether the orphan-close pass should force-close a depeg event for the
 * given coin id. Returns false for currently-tracked active coins (their
 * row is just temporarily missing from the cache iteration) and for frozen
 * coins (preserved historical data must not be falsified).
 */
export function shouldCloseOrphanedDepeg(
  coinId: string,
  iteratedTrackedIds: Set<string>,
  frozenIds: ReadonlySet<string> = FROZEN_IDS,
): boolean {
  if (iteratedTrackedIds.has(coinId)) return false;
  if (frozenIds.has(coinId)) return false;
  return true;
}

// Same-domain references are refreshed from the same live rates, so they agree
// well inside this bound; a domain mix or a drifted peak-time reference does not.
const DUPLICATE_PEAK_REFERENCE_TOLERANCE = 0.01;

function pairedPeakMagnitude(row: DepegRow): number | null {
  if ((row.peak_quote_domain !== "usd" && !(row.peak_quote_domain === "native-peg" && row.peak_peg_reference === 1)) ||
    !isPairedDepegPeak(row.peak_price, row.peak_peg_reference, row.peak_deviation_bps)) return null;
  return Math.abs((row.peak_price! / row.peak_peg_reference - 1) * 10000);
}

function isPeakComparable(keeper: DepegRow, dupe: DepegRow): boolean {
  if (isNativePegEvent(keeper) !== isNativePegEvent(dupe) ||
    parsePendingReason(keeper.pending_reason).has("peer-relative") !== parsePendingReason(dupe.pending_reason).has("peer-relative")) return false;
  const dupePaired = pairedPeakMagnitude(dupe);
  if (dupePaired != null) return dupe.peak_quote_domain === (isNativePegEvent(keeper) ? "native-peg" : "usd");
  if (dupe.peak_quote_domain != null || dupe.peak_peg_reference != null) return false;
  // Unpaired legacy rows compare only within the original reference scale.
  const keeperReference = keeper.peg_reference;
  const dupeReference = dupe.peg_reference;
  if (
    !Number.isFinite(keeperReference) || keeperReference <= 0 ||
    !Number.isFinite(dupeReference) || dupeReference <= 0
  ) return false;
  return Math.abs(keeperReference - dupeReference)
    <= Math.max(keeperReference, dupeReference) * DUPLICATE_PEAK_REFERENCE_TOLERANCE;
}

export interface DuplicateRepairOptions {
  /** Only for offline boundary-seed tools whose synthetic rows have no DDR dispute table. */
  allowUnverifiedRows?: boolean;
}

export function buildDuplicateOpenEventRepair<T extends DepegRow>(
  openRows: T[],
  options?: DuplicateRepairOptions,
): DuplicateRepairResult<T> {
  const allowUnverifiedRows = options?.allowUnverifiedRows === true;
  const openByCoin = new Map<string, Map<string, T[]>>();
  for (const row of openRows) {
    const directionGroups = openByCoin.get(row.stablecoin_id) ?? new Map<string, T[]>();
    const list = directionGroups.get(row.direction) ?? [];
    list.push(row);
    directionGroups.set(row.direction, list);
    openByCoin.set(row.stablecoin_id, directionGroups);
  }

  const commands: DepegPersistenceCommand[] = [];
  const openEvents = new Map<string, T>();
  for (const [coinId, directionGroups] of openByCoin) {
    const directionKeepers: T[] = [];

    for (const rows of directionGroups.values()) {
      if (rows.length === 1) {
        directionKeepers.push(rows[0]);
        continue;
      }

      // Sort by started_at ascending; prefer verified-clean rows as keeper so a
      // reviewed-disputed row never deletes or absorbs a clean open event.
      rows.sort((a, b) => a.started_at - b.started_at || a.id - b.id);
      const isRowUnverified = (row: T): boolean => {
        const det = row as DepegDetectionRow;
        if (det.escalation_metadata_hydrated === false) return true;
        return !allowUnverifiedRows && det.reviewed_disputed === undefined;
      };
      const cleanRows = rows.filter((row) => !isRowUnverified(row) && (row as DepegDetectionRow).reviewed_disputed !== true);
      const disputedRows = rows.filter((row) => !isRowUnverified(row) && (row as DepegDetectionRow).reviewed_disputed === true);

      // Defer destructive repair when no verified-clean keeper can be established
      // (e.g. base hydration fallback or all rows verified reviewed-disputed).
      const keeper = cleanRows[0];
      if (!keeper) {
        if (rows[0]) directionKeepers.push(rows[0]);
        continue;
      }
      const keeperDetection = keeper as DepegDetectionRow;
      // Only verified-clean duplicates contribute evidence; unverified duplicates
      // are deferred completely (no coverage/peak/escalation merge and no delete),
      // and verified-disputed duplicates contribute zero evidence before deletion.
      const cleanDupes = cleanRows.slice(1);
      const deletableDupes = [...cleanDupes, ...disputedRows];
      if (deletableDupes.length === 0) {
        directionKeepers.push(keeper);
        continue;
      }

      const initialCoverage = rowPriceCoverage(keeper);
      const normalizeCoverageForCompare = (
        cov: ReturnType<typeof rowPriceCoverage>,
      ): string | null =>
        cov == null
          ? null
          : JSON.stringify({
              intervals: cov.intervals,
              atParIntervals: cov.atParIntervals ?? [],
              lastTrustedObservationAt: cov.lastTrustedObservationAt ?? null,
              gapStartedAt: cov.gapStartedAt ?? null,
              lastObservationKind: cov.lastObservationKind ?? null,
            });
      const initialCoverageComparable = normalizeCoverageForCompare(initialCoverage);
      let coverageChanged = false;
      if (cleanDupes.length > 0) {
        const coverages = [initialCoverage, ...cleanDupes.map(rowPriceCoverage)].filter((coverage) => coverage != null);
        if (coverages.length > 0) {
          const latest = coverages.reduce((a, b) =>
            (b.lastTrustedObservationAt ?? -1) > (a.lastTrustedObservationAt ?? -1) ? b : a);
          const intervals = mergeDepegIntervals(coverages.flatMap((coverage) => coverage.intervals));
          const atParIntervals = mergeDepegIntervals(coverages.flatMap((coverage) => coverage.atParIntervals ?? []));
          const nextLastTrusted = latest.lastTrustedObservationAt;
          // Preserve unresolved blind gaps, but do not discard known at-par intervals. A trusted
          // off-peg observation at or after a gap's onset ends it (`advanceDepegPriceCoverage`), so a
          // retained duplicate's older gap never reopens the keeper's newer trusted coverage; the
          // keeper's own gap always stands and the duplicate's intervals are still merged.
          const keeperOffPegEnd = initialCoverage?.intervals.reduce((end, [, to]) => Math.max(end, to), -Infinity) ?? -Infinity;
          const openGaps = coverages.filter((coverage) => coverage.gapStartedAt != null &&
            (coverage === initialCoverage || coverage.gapStartedAt > keeperOffPegEnd));
          const nextGapStarted = openGaps.reduce<number | null>((gap, coverage) =>
            Math.min(gap ?? Infinity, coverage.gapStartedAt!), null);
          const coverage = {
            intervals,
            atParIntervals,
            lastTrustedObservationAt: nextLastTrusted,
            gapStartedAt: nextGapStarted,
            lastObservationKind: openGaps.some((value) => value.lastObservationKind !== "trusted-at-par")
              ? "blind" as const : latest.lastObservationKind,
          };
          const serializedCoverage = serializeDepegPriceCoverage(coverage);
          coverageChanged = normalizeCoverageForCompare(coverage) !== initialCoverageComparable;
          keeper.last_trusted_price_at = nextLastTrusted;
          keeper.price_coverage_gap_started_at = nextGapStarted;
          keeper.price_coverage_json = serializedCoverage;
          if (coverageChanged) {
            commands.push({
              type: "record-price-coverage",
              id: keeper.id,
              coverage,
            });
          }
        }
      }

      let peakReceipt: string | undefined;
      let peakChanged = false;
      const initialAnchor = keeper.peak_escalation_anchor_bps ?? null;
      const initialEscalatedAt = keeper.peak_escalated_at ?? null;
      const initialCandidateAt = keeper.peak_escalation_candidate_at ?? null;
      const initialCandidateSeenAt = keeper.peak_escalation_candidate_seen_at ?? null;
      let mergedAnchor = initialAnchor;
      let mergedEscalatedAt = initialEscalatedAt;

      for (const dupe of cleanDupes) {
        const dupeDetection = dupe as DepegDetectionRow;
        // Only verified-clean pairs may propagate escalation state or canonical onset;
        // an indeterminate keeper stays undefined so it never inherits a younger onset.
        if (keeperDetection.reviewed_disputed === false && dupeDetection.reviewed_disputed === false) {
          mergedAnchor = maxNullableInt(mergedAnchor, dupe.peak_escalation_anchor_bps ?? null);
          mergedEscalatedAt = maxNullableInt(mergedEscalatedAt, dupe.peak_escalated_at ?? null);
          if (keeperDetection.incident_started_at != null && dupeDetection.incident_started_at != null) {
            keeperDetection.incident_started_at = Math.min(
              keeper.started_at,
              keeperDetection.incident_started_at,
              dupeDetection.incident_started_at,
            );
          }
          const mergedCarryAnchor = maxNullableInt(
            keeperDetection.carry_forward_escalation_anchor_bps ?? null,
            dupeDetection.carry_forward_escalation_anchor_bps ?? null,
          );
          if (mergedCarryAnchor != null) keeperDetection.carry_forward_escalation_anchor_bps = mergedCarryAnchor;
          const mergedCarryEscalated = maxNullableInt(
            keeperDetection.carry_forward_peak_escalated_at ?? null,
            dupeDetection.carry_forward_peak_escalated_at ?? null,
          );
          if (mergedCarryEscalated != null) keeperDetection.carry_forward_peak_escalated_at = mergedCarryEscalated;
        }
        // Absorb worse peak deviation into the same-direction keeper only when
        // both rows are verified clean and price the same quote domain and reference scale.
        if (isPeakComparable(keeper, dupe) && (pairedPeakMagnitude(dupe) ?? Math.abs(dupe.peak_deviation_bps)) >
          (pairedPeakMagnitude(keeper) ?? Math.abs(keeper.peak_deviation_bps))) {
          peakChanged = true;
          keeper.peak_deviation_bps = dupe.peak_deviation_bps;
          keeper.peak_price = dupe.peak_price;
          keeper.peak_peg_reference = dupe.peak_peg_reference ?? null;
          keeper.peak_quote_domain = dupe.peak_quote_domain ?? null;
          if (keeper.peer_basis_json || dupe.peer_basis_json || peakReceipt != null) {
            const observation = readPendingObservationReceipt(dupe.peer_basis_json)?.peak;
            const peak = observation?.price === dupe.peak_price && observation.pegReference === dupe.peak_peg_reference &&
              observation.observedAt >= dupe.started_at && isPairedDepegPeak(observation.price, observation.pegReference, observation.bps)
              ? observation : null;
            peakReceipt = JSON.stringify(peak);
            // Later decisions in the same tick see the receipt that this command writes.
            let receipt: Record<string, unknown> = {};
            try {
              const decoded: unknown = JSON.parse(keeper.peer_basis_json ?? "{}");
              if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) receipt = { ...decoded };
            } catch { /* An unreadable prior receipt carries no evidence. */ }
            keeper.peer_basis_json = JSON.stringify({ ...receipt, peak });
          }
        }
      }
      // Persistence retains duplicates referenced by canonical incidents/links;
      // this detector repair never authorizes incident identity changes.
      for (const dupe of deletableDupes) {
        commands.push({ type: "delete-event", id: dupe.id });
      }
      if (cleanDupes.length > 0) {
        commands.push({
          type: "update-peak",
          id: keeper.id,
          peakDeviationBps: keeper.peak_deviation_bps,
          peakPrice: keeper.peak_price,
          ...(keeper.peak_peg_reference !== undefined ? { peakPegReference: keeper.peak_peg_reference } : {}),
          ...(peakReceipt != null ? { peakReceipt } : {}),
          ...(keeper.peak_quote_domain !== undefined ? { peakQuoteDomain: keeper.peak_quote_domain } : {}),
        });
      }
      // Clear an armed candidate only when repair mutates persisted columns (coverage,
      // peak, anchor, or confirmed escalation). In-memory-only hydrated fields
      // (`incident_started_at`, carry-forward) are enforced directly by `escalation.ts`, and a
      // superseded duplicate gap is not re-imported, so a retained DDR-referenced duplicate
      // cannot wipe an armed candidate every tick.
      const evidenceChanged =
        coverageChanged ||
        peakChanged ||
        mergedAnchor !== initialAnchor ||
        mergedEscalatedAt !== initialEscalatedAt;
      const hasCandidate = initialCandidateAt !== null || initialCandidateSeenAt !== null;
      const shouldClearCandidate = hasCandidate && evidenceChanged;
      if (
        mergedAnchor !== initialAnchor ||
        mergedEscalatedAt !== initialEscalatedAt ||
        shouldClearCandidate
      ) {
        const nextCandidateAt = shouldClearCandidate ? null : initialCandidateAt;
        const nextCandidateSeenAt = shouldClearCandidate ? null : initialCandidateSeenAt;
        keeper.peak_escalation_anchor_bps = mergedAnchor;
        keeper.peak_escalated_at = mergedEscalatedAt;
        keeper.peak_escalation_candidate_at = nextCandidateAt;
        keeper.peak_escalation_candidate_seen_at = nextCandidateSeenAt;
        commands.push({
          type: "update-escalation",
          id: keeper.id,
          peakEscalatedAt: mergedEscalatedAt,
          peakEscalationAnchorBps: mergedAnchor,
          peakEscalationCandidateAt: nextCandidateAt,
          peakEscalationCandidateSeenAt: nextCandidateSeenAt,
        });
      }
      directionKeepers.push(keeper);
    }

    if (directionKeepers.length === 0) continue;
    if (directionKeepers.length === 1) {
      openEvents.set(coinId, directionKeepers[0]);
      continue;
    }

    // Opposite-direction open rows are not true duplicates. Prefer verified-clean
    // keepers when present and defer superseding if any opposite-direction row is unverified.
    const hasUnverifiedDirection = directionKeepers.some((row) => {
      const det = row as DepegDetectionRow;
      return det.escalation_metadata_hydrated === false || (!allowUnverifiedRows && det.reviewed_disputed === undefined);
    });
    if (hasUnverifiedDirection) {
      directionKeepers.sort((a, b) => b.started_at - a.started_at || b.id - a.id);
      if (directionKeepers[0]) openEvents.set(coinId, directionKeepers[0]);
      continue;
    }
    const cleanDirections = directionKeepers.filter((row) => (row as DepegDetectionRow).reviewed_disputed !== true);
    const eligibleDirections = cleanDirections.length > 0 ? cleanDirections : directionKeepers;
    eligibleDirections.sort((a, b) => b.started_at - a.started_at || b.id - a.id);
    const keeper = eligibleDirections[0];
    if (!keeper) continue;
    if (cleanDirections.length > 0) {
      for (const stale of directionKeepers) {
        if (stale.id === keeper.id) continue;
        // Preserve strict chronology (`endedAt > startedAt`): never close a newer
        // disputed opposite-direction row (or same-second tie) at or before its onset.
        if (keeper.started_at <= stale.started_at) continue;
        commands.push({
          type: "close-event",
          id: stale.id,
          endedAt: keeper.started_at,
          recoveryPrice: null,
          closeReason: "superseded-direction",
        });
      }
    }
    openEvents.set(coinId, keeper);
  }

  return { openEvents, commands };
}

export function buildOrphanCloseRepair(input: {
  rows: OrphanDepegRow[];
  seenEventIds: Set<number>;
  syncStart: number;
  trackedCoinIds: Set<string>;
  now: number;
}): OrphanRepairResult {
  const commands: DepegPersistenceCommand[] = [];
  const diagnostics: DepegDiagnostic[] = [];

  for (const row of input.rows) {
    // Skip events we know are legitimately still open.
    if (input.seenEventIds.has(row.id)) continue;
    // Skip events just created in this run (their IDs weren't known during the loop).
    if (row.started_at >= input.syncStart) continue;
    // Skip tracked coins even if not observed this run (usually missing/stale inputs).
    // Also skip frozen coins - their historical events must not be force-closed.
    if (!shouldCloseOrphanedDepeg(row.stablecoin_id, input.trackedCoinIds)) continue;

    commands.push({
      type: "close-event",
      id: row.id,
      endedAt: input.now,
      recoveryPrice: null,
      closeReason: "orphan-tracking-removed",
    });
    diagnostics.push({
      level: "log",
      message: `[depeg] Closing orphan event for ${row.stablecoin_id} (id=${row.id})`,
    });
  }

  return { commands, diagnostics };
}
