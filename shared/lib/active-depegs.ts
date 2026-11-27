import type { DepegEvent, OpenIncidentCoverage, OpenIncidentSnapshot } from "../types/peg";
import type { OpenIncidentEvidence, OpenIncidentTier } from "./classification/depeg";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";
import {
  DEPEG_LONG_RUNNING_AGE_SEC,
  DEPEG_REESCALATION_WINDOW_SEC,
  getDepegRecoveryThresholdBpsForPegCurrency,
} from "./depeg-config";
import { hasCurrentTrustedCoverage } from "./peg-utils";

/**
 * The active-depeg census: `/api/peg-summary` coins flagged `activeDepeg` over
 * the active registry. One reducer for the homepage Active depegs card rows
 * and the route share cards (headline counts use the peg summary's own
 * `activeDepegCount`, as the /depeg/ hero does). The id set is passed in so
 * client bundles can supply their generated projection instead of loading the
 * registry.
 */
export function selectActiveDepegCoins<T extends { id: string; activeDepeg?: boolean | null }>(
  coins: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  return coins.filter((coin) => activeIds.has(coin.id) && coin.activeDepeg === true);
}

/**
 * Classify open-incident observation coverage against `nowSec`.
 * Off-peg requires gap-free continuity within the observation gap limit; at-par
 * keeps its intentional gap but must be fresh within that same limit. Missing,
 * blind, expired, or future-dated evidence reads "unconfirmed".
 */
export function classifyOpenIncidentCoverage(
  coverage: {
    lastObservationKind?: OpenIncidentCoverage["lastObservationKind"];
    lastTrustedObservationAt: number | null;
    gapStartedAt: number | null;
  } | null | undefined,
  nowSec: number,
): OpenIncidentEvidence {
  if (!coverage || !(nowSec > 0)) return "unconfirmed";
  if (coverage.lastObservationKind === "trusted-off-peg" && hasCurrentTrustedCoverage(coverage, nowSec)) {
    return "outside";
  }
  const last = coverage.lastTrustedObservationAt;
  if (
    coverage.lastObservationKind === "trusted-at-par" &&
    last != null &&
    nowSec >= last &&
    nowSec - last <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC
  ) {
    return "inside";
  }
  return "unconfirmed";
}

/**
 * Evidence for one coin's open confirmed incident, from the event detail page.
 * Only a unique open event with a current trusted observation says anything:
 * off-peg needs the gap-free continuity scoring uses; at-par keeps its
 * intentional gap but must be no older than the continuous-observation limit.
 * Missing, ambiguous (several open rows), blind, stale or future-dated evidence
 * reads "unconfirmed" — never recovered, never off peg. Spot bps are not used.
 */
export function classifyOpenIncidentEvidence(
  events: readonly DepegEvent[] | null | undefined,
  stablecoinId: string,
  nowSec: number,
): OpenIncidentEvidence {
  if (!events || !(nowSec > 0)) return "unconfirmed";
  const open = events.filter((event) => event.stablecoinId === stablecoinId && event.endedAt == null);
  if (open.length !== 1) return "unconfirmed";
  return classifyOpenIncidentCoverage(open[0].priceCoverage, nowSec);
}

/**
 * Classify an open incident's display horizon against `nowSec`.
 * Fail-closed (R1): absent onset, non-positive clock, or future-dated `startedAt`
 * returns `null` rather than inventing `"recent"`.
 */
export function classifyOpenIncidentTier(
  incident: { startedAt: number; escalatedAt?: number | null } | null | undefined,
  nowSec: number,
): OpenIncidentTier | null {
  if (
    !incident ||
    !(nowSec > 0) ||
    !Number.isSafeInteger(incident.startedAt) ||
    incident.startedAt < 0 ||
    incident.startedAt > nowSec
  ) {
    return null;
  }
  const escalatedAt = incident.escalatedAt;
  if (escalatedAt != null && (!Number.isSafeInteger(escalatedAt) || escalatedAt < 0)) {
    return null;
  }
  const ageSec = nowSec - incident.startedAt;
  if (ageSec <= DEPEG_LONG_RUNNING_AGE_SEC) {
    return "recent";
  }
  if (
    escalatedAt != null &&
    escalatedAt <= nowSec &&
    nowSec - escalatedAt <= DEPEG_REESCALATION_WINDOW_SEC
  ) {
    return "escalating";
  }
  return "long_running";
}

export function isRecentOpenIncidentTier(tier: OpenIncidentTier | null | undefined): boolean {
  return tier === "recent" || tier === "escalating";
}

/**
 * Returns a deterministic crossing signature whenever any open-incident representative's
 * classified horizon tier at `clockSec` differs from its tier at `asOfSec` (`clockSec > asOfSec`),
 * or `null` when no displayed representative has crossed a horizon boundary.
 */
export function getOpenIncidentHorizonCrossingKey(
  openIncidents: Readonly<Record<string, OpenIncidentSnapshot>> | null | undefined,
  asOfSec: number | null | undefined,
  clockSec: number,
): string | null {
  if (!openIncidents || asOfSec == null || !(asOfSec > 0) || !(clockSec > asOfSec)) return null;
  const crossed: string[] = [];
  for (const [coinId, incident] of Object.entries(openIncidents)) {
    const initialTier = classifyOpenIncidentTier(incident, asOfSec);
    const currentTier = classifyOpenIncidentTier(incident, clockSec);
    if (initialTier !== null && currentTier !== initialTier) {
      crossed.push(`${coinId}:${incident.eventId}:${currentTier ?? "null"}`);
    }
  }
  if (crossed.length === 0) return null;
  crossed.sort();
  return `${asOfSec}|${crossed.join(",")}`;
}

/**
 * True only when a finite live deviation is measured inside or on the inclusive
 * recovery band (`<= 50 bps` USD / `<= 75 bps` non-USD) without trusted evidence.
 * Unpriced (`deviationBps == null`) is never near par (R1/R2).
 */
export function isNearParUnconfirmedOpenIncident(
  evidence: OpenIncidentEvidence,
  deviationBps: number | null,
  pegCurrency: string | undefined,
): boolean {
  if (evidence !== "unconfirmed" || deviationBps == null || !Number.isFinite(deviationBps)) {
    return false;
  }
  const recoveryBandBps = getDepegRecoveryThresholdBpsForPegCurrency(pegCurrency);
  return Math.abs(deviationBps) <= recoveryBandBps;
}

/**
 * Two-tier materiality classifier for open confirmed incidents:
 * - Tier 1 (Material): `outside`, OR `unconfirmed` with `|bps| > recoveryBand` or unpriced (`null`)
 * - Tier 0 (Near-par / inside recovery): `inside`, OR `unconfirmed` with measured `|bps| <= recoveryBand`
 *
 * Uses strict `>` for off-peg matching the detector's inclusive recovery band (`<= 50` / `<= 75` bps).
 */
export function classifyOpenIncidentMateriality(
  evidence: OpenIncidentEvidence,
  deviationBps: number | null,
  pegCurrency: string | undefined,
): 0 | 1 {
  if (evidence === "outside") return 1;
  if (evidence === "inside") return 0;
  if (deviationBps == null || !Number.isFinite(deviationBps)) return 1;
  const recoveryBandBps = getDepegRecoveryThresholdBpsForPegCurrency(pegCurrency);
  return Math.abs(deviationBps) > recoveryBandBps ? 1 : 0;
}

export interface RankableOpenIncidentRow {
  id: string;
  bps: number | null;
  exposureUsd: number | null;
  evidence: OpenIncidentEvidence;
  pegCurrency?: string | undefined;
}

function compareNullableDesc(a: number | null, b: number | null): number {
  const aValid = a != null && Number.isFinite(a);
  const bValid = b != null && Number.isFinite(b);
  if (aValid && bValid) return b - a;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

/**
 * Single deterministic comparator for bounded open-incident lists across Homepage,
 * Mobile KPI, `/depeg/` Hero, and OG Briefing:
 * 1. Materiality tier (`1 > 0`: confirmed or unconfirmed off-peg/unpriced above near-par / inside recovery)
 * 2. Holder exposure USD off peg desc (unavailable last)
 * 3. Confirmed off-peg tie-break (`outside` ahead of `unconfirmed`)
 * 4. Absolute live deviation bps desc (unavailable last)
 * 5. Stablecoin ID asc
 */
export function compareOpenIncidentRows(a: RankableOpenIncidentRow, b: RankableOpenIncidentRow): number {
  const matDiff =
    classifyOpenIncidentMateriality(b.evidence, b.bps, b.pegCurrency) -
    classifyOpenIncidentMateriality(a.evidence, a.bps, a.pegCurrency);
  if (matDiff !== 0) return matDiff;

  const expDiff = compareNullableDesc(a.exposureUsd, b.exposureUsd);
  if (expDiff !== 0) return expDiff;

  const confirmedDiff = (b.evidence === "outside" ? 1 : 0) - (a.evidence === "outside" ? 1 : 0);
  if (confirmedDiff !== 0) return confirmedDiff;

  const bpsDiff = compareNullableDesc(
    a.bps == null ? null : Math.abs(a.bps),
    b.bps == null ? null : Math.abs(b.bps),
  );
  if (bpsDiff !== 0) return bpsDiff;

  return a.id.localeCompare(b.id);
}

export interface PartitionedActiveDepegRows<T> {
  splitAvailable: boolean;
  allRows: T[];
  recentRows: T[];
  longRunningRows: T[];
  recentCount: number | null;
  longRunningCount: number | null;
  escalatedCount: number | null;
}

/**
 * Partition already-constructed active-depeg rows using one assessment clock.
 * Fails closed to `splitAvailable: false` if `openIncidents` is absent or any
 * active row lacks a valid tier (R1: never invent age=0 or drop rows).
 */
export function partitionActiveDepegRows<T extends RankableOpenIncidentRow & { tier?: OpenIncidentTier | null }>(
  rows: readonly T[],
  openIncidents: Readonly<Record<string, OpenIncidentSnapshot>> | null | undefined,
  clockSec: number,
): PartitionedActiveDepegRows<T> {
  const allRows = [...rows].sort(compareOpenIncidentRows);
  if (!openIncidents || !(clockSec > 0)) {
    return {
      splitAvailable: false,
      allRows,
      recentRows: [],
      longRunningRows: [],
      recentCount: null,
      longRunningCount: null,
      escalatedCount: null,
    };
  }
  const recentRows: T[] = [];
  const longRunningRows: T[] = [];
  let escalatedCount = 0;
  for (const row of allRows) {
    const tier = row.tier !== undefined ? row.tier : classifyOpenIncidentTier(openIncidents[row.id], clockSec);
    if (tier === null) {
      return {
        splitAvailable: false,
        allRows,
        recentRows: [],
        longRunningRows: [],
        recentCount: null,
        longRunningCount: null,
        escalatedCount: null,
      };
    }
    if (tier === "long_running") {
      longRunningRows.push(row);
    } else {
      recentRows.push(row);
      if (tier === "escalating") escalatedCount++;
    }
  }
  return {
    splitAvailable: true,
    allRows,
    recentRows,
    longRunningRows,
    recentCount: recentRows.length,
    longRunningCount: longRunningRows.length,
    escalatedCount,
  };
}
