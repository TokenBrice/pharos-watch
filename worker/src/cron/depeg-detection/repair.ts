import { readPendingObservationReceipt } from "../../lib/depeg-pending";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { isPairedDepegPeak, parsePendingReason, rowPriceCoverage, serializeDepegPriceCoverage, type DepegRow } from "../../lib/depeg-helpers";
import { mergeDepegIntervals } from "@shared/lib/peg-utils";
import type { DepegDiagnostic, DepegPersistenceCommand } from "./types";

export interface OrphanDepegRow {
  id: number;
  stablecoin_id: string;
  started_at: number;
}

export interface DuplicateRepairResult {
  openEvents: Map<string, DepegRow>;
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

export function buildDuplicateOpenEventRepair(openRows: DepegRow[]): DuplicateRepairResult {
  const openByCoin = new Map<string, Map<string, DepegRow[]>>();
  for (const row of openRows) {
    const directionGroups = openByCoin.get(row.stablecoin_id) ?? new Map<string, DepegRow[]>();
    const list = directionGroups.get(row.direction) ?? [];
    list.push(row);
    directionGroups.set(row.direction, list);
    openByCoin.set(row.stablecoin_id, directionGroups);
  }

  const commands: DepegPersistenceCommand[] = [];
  const openEvents = new Map<string, DepegRow>();
  for (const [coinId, directionGroups] of openByCoin) {
    const directionKeepers: DepegRow[] = [];

    for (const rows of directionGroups.values()) {
      if (rows.length === 1) {
        directionKeepers.push(rows[0]);
        continue;
      }

      // Sort by started_at ascending - keep the earliest same-direction event.
      rows.sort((a, b) => a.started_at - b.started_at || a.id - b.id);
      const keeper = rows[0];
      if (!keeper) continue;
      const coverages = rows.map(rowPriceCoverage).filter((coverage) => coverage != null);
      if (coverages.length > 0) {
        const latest = coverages.reduce((a, b) =>
          (b.lastTrustedObservationAt ?? -1) > (a.lastTrustedObservationAt ?? -1) ? b : a);
        const intervals = mergeDepegIntervals(coverages.flatMap((coverage) => coverage.intervals));
        const atParIntervals = mergeDepegIntervals(coverages.flatMap((coverage) => coverage.atParIntervals ?? []));
        keeper.last_trusted_price_at = latest.lastTrustedObservationAt;
        // Preserve unresolved blind gaps, but do not discard known at-par intervals.
        keeper.price_coverage_gap_started_at = coverages.reduce<number | null>((gap, coverage) =>
          coverage.gapStartedAt == null ? gap : Math.min(gap ?? Infinity, coverage.gapStartedAt), null);
        const coverage = {
          intervals,
          atParIntervals,
          lastTrustedObservationAt: keeper.last_trusted_price_at,
          gapStartedAt: keeper.price_coverage_gap_started_at,
          lastObservationKind: coverages.some((value) => value.gapStartedAt != null && value.lastObservationKind !== "trusted-at-par")
            ? "blind" as const : latest.lastObservationKind,
        };
        keeper.price_coverage_json = serializeDepegPriceCoverage(coverage);
        commands.push({
          type: "record-price-coverage",
          id: keeper.id,
          coverage,
        });
      }
      let peakReceipt: string | undefined;
      for (let i = 1; i < rows.length; i++) {
        const dupe = rows[i];
        if (!dupe) continue;
        // Absorb worse peak deviation into the same-direction keeper only when
        // both rows price the same quote domain and reference scale.
        if (isPeakComparable(keeper, dupe) && (pairedPeakMagnitude(dupe) ?? Math.abs(dupe.peak_deviation_bps)) >
          (pairedPeakMagnitude(keeper) ?? Math.abs(keeper.peak_deviation_bps))) {
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
        // Persistence retains duplicates referenced by canonical incidents/links;
        // this detector repair never authorizes incident identity changes.
        commands.push({ type: "delete-event", id: dupe.id });
      }
      commands.push({
        type: "update-peak",
        id: keeper.id,
        peakDeviationBps: keeper.peak_deviation_bps,
        peakPrice: keeper.peak_price,
        ...(keeper.peak_peg_reference !== undefined ? { peakPegReference: keeper.peak_peg_reference } : {}),
        ...(peakReceipt != null ? { peakReceipt } : {}),
        ...(keeper.peak_quote_domain !== undefined ? { peakQuoteDomain: keeper.peak_quote_domain } : {}),
      });
      directionKeepers.push(keeper);
    }

    if (directionKeepers.length === 0) continue;
    if (directionKeepers.length === 1) {
      openEvents.set(coinId, directionKeepers[0]);
      continue;
    }

    // Opposite-direction open rows are not true duplicates. Keep the most
    // recent direction live and close older direction keepers at that boundary.
    directionKeepers.sort((a, b) => b.started_at - a.started_at || b.id - a.id);
    const keeper = directionKeepers[0];
    if (!keeper) continue;
    for (let i = 1; i < directionKeepers.length; i++) {
      const stale = directionKeepers[i];
      if (!stale) continue;
      commands.push({
        type: "close-event",
        id: stale.id,
        endedAt: keeper.started_at,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      });
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
