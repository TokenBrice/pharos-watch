import type { DepegPendingIncident, PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import {
  classifyOpenIncidentMateriality,
  isRecentOpenIncidentTier,
} from "@shared/lib/active-depegs";
import {
  THREAT_BAND_ORDER,
  isThreatBand,
  type OpenIncidentEvidence,
  type OpenIncidentTier,
} from "@shared/lib/classification";
import { readPublishedDeviation, readUnroundedPublishedDeviation } from "@/lib/current-peg";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
  pendingIncident?: DepegPendingIncident | null;
  /** Latest trusted observation of this coin's open confirmed incident. */
  openIncidentEvidence?: OpenIncidentEvidence | null;
  /** Open-incident display horizon tier from `/api/peg-summary` `openIncidents`. */
  openIncidentTier?: OpenIncidentTier | null;
  /** Canonical incident onset (unix seconds) from `/api/peg-summary` `openIncidents`. */
  openIncidentStartedAt?: number | null;
  /** Circulating USD; null is unavailable, undefined is not read yet. */
  marketCapUsd?: number | null;
}

export function readTrackerDeviation(row: DepegTrackerRow, nowSec?: number) {
  return readPublishedDeviation(row.coin.pegCurrency, row.coin, undefined, nowSec);
}

function getDewsBandOrder(row: DepegTrackerRow): number {
  const band = row.dews?.band;
  return band && isThreatBand(band) ? THREAT_BAND_ORDER[band] : THREAT_BAND_ORDER.CALM;
}

/**
 * Horizon rank for active open incidents:
 * - `recent` / `escalating`: 2 (leads active incidents)
 * - `null` / `undefined` (legacy payload without split metadata): 1
 * - `long_running` (`>30d`, quiet): 0
 */
function activeHorizonRank(tier: OpenIncidentTier | null | undefined): number {
  if (isRecentOpenIncidentTier(tier)) return 2;
  if (tier === "long_running") return 0;
  return 1;
}

function compareNullableAbsDesc(a: number | null, b: number | null): number {
  const aValid = a != null && Number.isFinite(a);
  const bValid = b != null && Number.isFinite(b);
  if (aValid && bValid) return Math.abs(b) - Math.abs(a);
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

/**
 * Authoritative lexicographic comparator for default "needs attention" ordering
 * (negative when `a` needs more attention than `b`):
 * 1. Active open incident (`true > false`)
 * 2. Materiality tier for active rows (`1 > 0`: material off-peg / unpriced ahead of near-par / inside recovery)
 * 3. Horizon bucket for active rows (`recent` / `escalating` > unknown > `long_running`)
 * 4. Pending incident (`true > false`, strictly below active and above DEWS DANGER)
 * 5. DEWS threat band (`DANGER > WARNING > ALERT > WATCH > CALM`)
 * 6. Absolute live deviation bps desc (unavailable last)
 * 7. Stablecoin ID asc
 */
export function compareDepegAttention(a: DepegTrackerRow, b: DepegTrackerRow, nowSec?: number): number {
  const aActive = Boolean(a.coin.activeDepeg);
  const bActive = Boolean(b.coin.activeDepeg);
  if (aActive !== bActive) return Number(bActive) - Number(aActive);

  const aDev = readUnroundedPublishedDeviation(a.coin.pegCurrency, a.coin, undefined, nowSec).deviationBps;
  const bDev = readUnroundedPublishedDeviation(b.coin.pegCurrency, b.coin, undefined, nowSec).deviationBps;

  if (aActive && bActive) {
    const aMat = classifyOpenIncidentMateriality(
      a.openIncidentEvidence ?? "unconfirmed",
      aDev,
      a.coin.pegCurrency,
    );
    const bMat = classifyOpenIncidentMateriality(
      b.openIncidentEvidence ?? "unconfirmed",
      bDev,
      b.coin.pegCurrency,
    );
    if (bMat !== aMat) return bMat - aMat;

    const horizonDiff = activeHorizonRank(b.openIncidentTier) - activeHorizonRank(a.openIncidentTier);
    if (horizonDiff !== 0) return horizonDiff;
  }

  const pendingDiff = Number(Boolean(b.pendingIncident)) - Number(Boolean(a.pendingIncident));
  if (pendingDiff !== 0) return pendingDiff;

  const bandDiff = getDewsBandOrder(b) - getDewsBandOrder(a);
  if (bandDiff !== 0) return bandDiff;

  const devDiff = compareNullableAbsDesc(aDev, bDev);
  if (devDiff !== 0) return devDiff;

  return (a.coin.id ?? "").localeCompare(b.coin.id ?? "");
}
