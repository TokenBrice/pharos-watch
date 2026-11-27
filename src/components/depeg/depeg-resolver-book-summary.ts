import {
  getLiveCurrentDeviationBps,
  getResolution,
  getTierVocabulary,
  isCurrentForecast,
} from "@/components/depeg/depeg-resolver-row-card-model";
import { readUnroundedPublishedDeviation } from "@/lib/current-peg";
import {
  classifyOpenIncidentCoverage,
  classifyOpenIncidentEvidence,
  classifyOpenIncidentTier,
  compareOpenIncidentRows,
  isRecentOpenIncidentTier,
  type RankableOpenIncidentRow,
} from "@shared/lib/active-depegs";
import type {
  DdrTierVocabulary,
  OpenIncidentEvidence,
  OpenIncidentTier,
} from "@shared/lib/classification";
import {
  DDR_RESOLUTION_TIER_VALUES,
  type DdrResolutionTier,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import type { DepegEvent, OpenIncidentSnapshot, PegSummaryCoin } from "@shared/types/peg";

/**
 * Below this the "past peak" test is snapshot jitter, not a real move. A bare
 * 2% margin is only 2bps at a 100bps event threshold.
 */
const PAST_PEAK_FLOOR_BPS = 25;

/** Keep headline claims and forecast cards behind the same fail-closed gate. */
export function isResolverBookAvailable<T extends {
  _meta?: { degraded: boolean; degradedReason?: string | null };
  rows: readonly unknown[];
}>(data: T | undefined): data is T {
  return data != null && (!data._meta?.degraded
    || (data._meta.degradedReason === "stale-cache" && data.rows.length > 0));
}

/**
 * Is the live gap to peg wider than this event's live recorded peak — a new worst?
 *
 * Both sides must be live. `getCurrentDeviationBps()` and `getPeakDeviationBps()`
 * deliberately return lock-time evidence for frozen predictions; comparing live
 * deviation with the frozen lock peak flags incidents that already went deeper
 * after lock (and misses ones whose live peak is shallower than at lock).
 */
function isPastEventPeak(row: DdrV2ResponseRow): boolean {
  const live = getLiveCurrentDeviationBps(row);
  if (live == null) return false;
  const peakDeviationBps = row.live.peakDeviationBps;
  if (peakDeviationBps == null) return false;
  const peak = Math.abs(peakDeviationBps);
  if (peak <= 0) return false;
  return Math.abs(live) > peak + Math.max(PAST_PEAK_FLOOR_BPS, peak * 0.02);
}

/** Circulating USD by coin id; a missing id or a null value is unavailable, never zero. */
export type MarketCapById = ReadonlyMap<string, number | null>;

/** Holder exposure in USD: circulating supply × |live deviation|; unavailable when either input is. */
export function holderExposureUsd(marketCapUsd: number | null | undefined, deviationBps: number | null): number | null {
  return marketCapUsd == null || deviationBps == null ? null : (marketCapUsd * Math.abs(deviationBps)) / 10_000;
}

/** Larger exposure first; an unavailable exposure sorts after every observed one. */
function compareExposure(a: number | null, b: number | null): number {
  if (a == null || b == null) return Number(a == null) - Number(b == null);
  return b - a;
}

/**
 * Verdict severity: terminal evidence / no recovery expected, then stress / at
 * risk, then an open incident without a current verdict (not locked yet,
 * no-call, insufficient signal), then no break signals / recovery likely. An
 * incident that is no longer active ranks last, whatever it was forecast.
 */
const VERDICT_URGENCY: Record<DdrResolutionTier, number> = {
  recovery_unlikely: 4,
  at_risk: 3,
  insufficient_signal: 2,
  recovery_likely: 1,
};

function verdictUrgency(row: DdrV2ResponseRow): number {
  if (row.live.eventState !== "active") return 0;
  return VERDICT_URGENCY[isCurrentForecast(row) ? getResolution(row).tier : "insufficient_signal"];
}

export interface CompareResolverUrgencyOptions {
  openIncidents?: Readonly<Record<string, OpenIncidentSnapshot>> | null;
  clockSec?: number;
}

/**
 * Join a live DDR row to `/api/peg-summary` `openIncidents` strictly by matching
 * `eventId` (`incident.eventId === row.live.currentEventId`), never bare coin ID.
 */
export function matchOpenIncidentForResolverRow(
  row: DdrV2ResponseRow,
  openIncidents: Readonly<Record<string, OpenIncidentSnapshot>> | null | undefined,
): OpenIncidentSnapshot | null {
  if (!openIncidents || row.live.eventState !== "active") return null;
  const incident = openIncidents[row.stablecoinId];
  if (!incident) return null;
  return row.live.currentEventId != null && incident.eventId === row.live.currentEventId
    ? incident
    : null;
}

/**
 * Classify a DDR row's open-incident horizon tier via exact `eventId` join on a
 * single assessment clock. Returns `null` when unmatched, closed, or unclocked.
 */
export function resolveResolverRowIncidentTier(
  row: DdrV2ResponseRow,
  openIncidents: Readonly<Record<string, OpenIncidentSnapshot>> | null | undefined,
  clockSec: number | undefined,
): OpenIncidentTier | null {
  if (!clockSec || !(clockSec > 0)) return null;
  const incident = matchOpenIncidentForResolverRow(row, openIncidents);
  return classifyOpenIncidentTier(incident, clockSec);
}

function resolverHorizonRank(tier: OpenIncidentTier | null): number {
  if (isRecentOpenIncidentTier(tier)) return 2;
  if (tier === "long_running") return 0;
  return 1;
}

/**
 * Worklist order: verdict severity first; within equal verdict urgency, when
 * split metadata is available, active `recent`/`escalating` rows (matched by
 * `eventId`) lead quiet `>30d` long-running rows; then incidents now at a new
 * worst, then holder exposure (unavailable last), then the widest live gap to
 * peg, then a stable identity so equally urgent rows cannot reshuffle between
 * refreshes on API row order. DDR rows are not control-board rows, so the
 * board's attention comparator does not apply.
 */
export function compareResolverUrgency(
  a: DdrV2ResponseRow,
  b: DdrV2ResponseRow,
  marketCaps?: MarketCapById | null,
  options?: CompareResolverUrgencyOptions,
): number {
  const verdictDelta = verdictUrgency(b) - verdictUrgency(a);
  if (verdictDelta !== 0) return verdictDelta;
  if (options?.openIncidents && options.clockSec && options.clockSec > 0) {
    const activeDelta = Number(b.live.eventState === "active") - Number(a.live.eventState === "active");
    if (activeDelta !== 0) return activeDelta;
    if (a.live.eventState === "active" && b.live.eventState === "active") {
      const aTier = resolveResolverRowIncidentTier(a, options.openIncidents, options.clockSec);
      const bTier = resolveResolverRowIncidentTier(b, options.openIncidents, options.clockSec);
      const horizonDelta = resolverHorizonRank(bTier) - resolverHorizonRank(aTier);
      if (horizonDelta !== 0) return horizonDelta;
    }
  }
  const pastPeakDelta = Number(isPastEventPeak(b)) - Number(isPastEventPeak(a));
  if (pastPeakDelta !== 0) return pastPeakDelta;
  const exposureDelta = compareExposure(
    holderExposureUsd(marketCaps?.get(a.stablecoinId), getLiveCurrentDeviationBps(a)),
    holderExposureUsd(marketCaps?.get(b.stablecoinId), getLiveCurrentDeviationBps(b)),
  );
  if (exposureDelta !== 0) return exposureDelta;
  const deviationDelta =
    Math.abs(getLiveCurrentDeviationBps(b) ?? 0) - Math.abs(getLiveCurrentDeviationBps(a) ?? 0);
  if (deviationDelta !== 0) return deviationDelta;
  const idDelta = a.stablecoinId.localeCompare(b.stablecoinId);
  return idDelta !== 0 ? idDelta : String(a.eventId).localeCompare(String(b.eventId));
}

export interface ResolverTierGroup {
  tier: DdrResolutionTier;
  vocabulary: DdrTierVocabulary;
  count: number;
}

export interface ResolverBookSummary {
  total: number;
  rowCount: number;
  tierCounts: Record<DdrResolutionTier, number>;
  /**
   * Non-empty tier counts split by the label vocabulary each forecast was
   * locked under, in tier order (current vocabulary first), so a pre-v5 lock
   * is never relabeled by an aggregate.
   */
  tierGroups: ResolverTierGroup[];
  pastPeakCount: number;
}

const VOCABULARY_ORDER: readonly DdrTierVocabulary[] = ["evidence_class", "legacy"];

/** Groups tiered items by (tier, vocabulary), dropping empty groups. */
export function groupTiersByVocabulary(
  items: ReadonlyArray<{ tier: DdrResolutionTier; vocabulary: DdrTierVocabulary }>,
): ResolverTierGroup[] {
  const groups: ResolverTierGroup[] = [];
  for (const tier of DDR_RESOLUTION_TIER_VALUES) {
    for (const vocabulary of VOCABULARY_ORDER) {
      const count = items.filter((item) => item.tier === tier && item.vocabulary === vocabulary).length;
      if (count > 0) groups.push({ tier, vocabulary, count });
    }
  }
  return groups;
}

/**
 * One derivation of the whole resolver book, shared by the hero's recovery
 * posture and the resolver module's own header, so the two can never disagree.
 */
export function summarizeResolverBook(rows: readonly DdrV2ResponseRow[]): ResolverBookSummary {
  const tierCounts = {} as Record<DdrResolutionTier, number>;
  for (const tier of DDR_RESOLUTION_TIER_VALUES) tierCounts[tier] = 0;
  const tiered: Array<{ tier: DdrResolutionTier; vocabulary: DdrTierVocabulary }> = [];
  let pastPeakCount = 0;
  let total = 0;
  for (const row of rows) {
    if (!isCurrentForecast(row)) continue;
    total += 1;
    const tier = getResolution(row).tier;
    tierCounts[tier] += 1;
    tiered.push({ tier, vocabulary: getTierVocabulary(row) });
    if (isPastEventPeak(row)) pastPeakCount += 1;
  }
  return { total, rowCount: rows.length, tierCounts, tierGroups: groupTiersByVocabulary(tiered), pastPeakCount };
}

export interface OpenIncidentRow extends RankableOpenIncidentRow {
  id: string;
  symbol: string;
  pegCurrency: string;
  /** Admitted live deviation, or null when unavailable. */
  deviationBps: number | null;
  /** Live deviation alias required by `RankableOpenIncidentRow` / `compareOpenIncidentRows`. */
  bps: number | null;
  referenceNote: string | null;
  marketCapUsd: number | null;
  /** Holder exposure in USD off peg, or null when supply or deviation is unavailable. */
  exposureUsd: number | null;
  /** Latest trusted observation coverage classification for this open incident. */
  evidence: OpenIncidentEvidence;
  /** Elapsed seconds since canonical incident onset, or null when unavailable/future. */
  ageSec: number | null;
  /** Display horizon tier (`recent`, `escalating`, `long_running`), or null when unsplit. */
  tier: OpenIncidentTier | null;
  /** The resolver row for the coin's active incident, matched by `eventId` when available, current forecast first. */
  ddr: DdrV2ResponseRow | null;
}

/**
 * The hero's named open incidents: the peg summary's confirmed census, ranked
 * by shared `compareOpenIncidentRows` (two-tier materiality, holder exposure,
 * confirmed off-peg tie-break, widest deviation, then identity).
 */
export function rankOpenIncidents(
  coins: readonly PegSummaryCoin[],
  resolverRows: readonly DdrV2ResponseRow[],
  marketCaps: MarketCapById | null,
  openIncidents?: Readonly<Record<string, OpenIncidentSnapshot>> | null,
  clockSec = 0,
  activeEvents?: readonly DepegEvent[] | null,
  horizonClockSec = clockSec,
): OpenIncidentRow[] {
  const deviationClockSec = clockSec > 0 ? clockSec : undefined;
  return coins
    .filter((coin) => coin.activeDepeg)
    .map((coin) => {
      const { deviationBps: rawBps, referenceNote } = readUnroundedPublishedDeviation(
        coin.pegCurrency,
        coin,
        undefined,
        deviationClockSec,
      );
      const deviationBps = rawBps == null ? null : Math.round(rawBps);
      const marketCapUsd = marketCaps?.get(coin.id) ?? null;
      const exposureUsd = holderExposureUsd(marketCapUsd, rawBps);
      const incident = openIncidents?.[coin.id] ?? null;
      const evidence =
        openIncidents === undefined && activeEvents
          ? classifyOpenIncidentEvidence(activeEvents, coin.id, clockSec)
          : classifyOpenIncidentCoverage(incident?.coverage, clockSec);
      const tier = classifyOpenIncidentTier(incident, horizonClockSec);
      const ageSec =
        incident && horizonClockSec > 0 && Number.isFinite(incident.startedAt) && incident.startedAt <= horizonClockSec
          ? horizonClockSec - incident.startedAt
          : null;
      const active = resolverRows.filter((row) => row.stablecoinId === coin.id && row.live.eventState === "active");
      const matched = incident
        ? active.filter((row) => row.live.currentEventId === incident.eventId)
        : active;
      return {
        id: coin.id,
        symbol: coin.symbol,
        pegCurrency: coin.pegCurrency,
        deviationBps,
        bps: rawBps,
        referenceNote,
        marketCapUsd,
        exposureUsd,
        evidence,
        ageSec,
        tier,
        ddr: matched.find(isCurrentForecast) ?? matched[0] ?? null,
      };
    })
    .sort(compareOpenIncidentRows);
}
