import {
  getLiveCurrentDeviationBps,
  getResolution,
  getTierVocabulary,
  isCurrentForecast,
} from "@/components/depeg/depeg-resolver-row-card-model";
import { readPublishedDeviation } from "@/lib/current-peg";
import type { DdrTierVocabulary } from "@shared/lib/classification";
import {
  DDR_RESOLUTION_TIER_VALUES,
  type DdrResolutionTier,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import type { PegSummaryCoin } from "@shared/types/peg";

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

/**
 * Worklist order: verdict severity, then incidents now at a new worst, then
 * holder exposure (unavailable last), then the widest live gap to peg, then a
 * stable identity so equally urgent rows cannot reshuffle between refreshes on
 * API row order. DDR rows are not control-board rows, so the board's attention
 * comparator does not apply.
 */
export function compareResolverUrgency(
  a: DdrV2ResponseRow,
  b: DdrV2ResponseRow,
  marketCaps?: MarketCapById | null,
): number {
  const verdictDelta = verdictUrgency(b) - verdictUrgency(a);
  if (verdictDelta !== 0) return verdictDelta;
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

export interface OpenIncidentRow {
  id: string;
  symbol: string;
  /** Admitted live deviation, or null when unavailable. */
  deviationBps: number | null;
  referenceNote: string | null;
  marketCapUsd: number | null;
  /** The resolver row for the coin's active incident, a current forecast first. */
  ddr: DdrV2ResponseRow | null;
}

/**
 * The hero's named open incidents: the peg summary's confirmed census, largest
 * holder exposure first (unavailable exposure last), then the wider live
 * deviation, then identity. Callers show a slice and count the whole list.
 */
export function rankOpenIncidents(
  coins: readonly PegSummaryCoin[],
  resolverRows: readonly DdrV2ResponseRow[],
  marketCaps: MarketCapById | null,
): OpenIncidentRow[] {
  return coins
    .filter((coin) => coin.activeDepeg)
    .map((coin) => {
      const { deviationBps, referenceNote } = readPublishedDeviation(coin.pegCurrency, coin);
      const active = resolverRows.filter((row) => row.stablecoinId === coin.id && row.live.eventState === "active");
      return {
        id: coin.id,
        symbol: coin.symbol,
        deviationBps,
        referenceNote,
        marketCapUsd: marketCaps?.get(coin.id) ?? null,
        ddr: active.find(isCurrentForecast) ?? active[0] ?? null,
      };
    })
    .sort((a, b) =>
      compareExposure(holderExposureUsd(a.marketCapUsd, a.deviationBps), holderExposureUsd(b.marketCapUsd, b.deviationBps))
      || Math.abs(b.deviationBps ?? 0) - Math.abs(a.deviationBps ?? 0)
      || a.id.localeCompare(b.id));
}
