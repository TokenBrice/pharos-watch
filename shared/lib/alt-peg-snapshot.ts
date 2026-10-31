import type { PegCurrency } from "../types";
import { isCommodityPeg } from "./filter-tags";
import { compareFiniteDesc } from "./sort";
import { getCirculatingRawOrNull } from "./supply";
import { buildSupplyObservationProvenance, classifySupplyCoverage } from "./supply-provenance";
import { CLIENT_ACTIVE_META_BY_ID } from "./stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "./stablecoins/aggregate-client-registry";

/**
 * Current non-USD market structure over the core aggregate: the one reducer
 * behind the `/alt-pegs/` hero, ranking and live share card. Each core member
 * is admitted once and classified by its registry peg (list rows carry no
 * `pegCurrency`). Supply is nullable: an unavailable member, or a core member
 * absent from the list, adds to the unavailable count, never a zero. A recorded
 * partial-chain remainder stays in the known subtotal but is incomplete, and
 * any unavailable or partial member withholds shares (as `homepage-hero-snapshot`
 * does).
 */

interface NonUsdMarketRow {
  id: string;
  name: string;
  symbol: string;
  circulating?: Record<string, number> | null;
  supplySource?: unknown;
  supplyObservedAt?: unknown;
  supplyChainGuard?: unknown;
}

export interface NonUsdPegEntry {
  peg: PegCurrency;
  commodity: boolean;
  /** Known subtotal; `null` when no member of the peg has an observed supply. */
  marketCap: number | null;
  /** Share of the non-USD total; `null` while any non-USD member is unavailable or partial. */
  sharePct: number | null;
  coinCount: number;
  supplyObservedCount: number;
  supplyUnavailableCount: number;
  /** Observed members whose numeric amount is a recorded partial-chain remainder. */
  supplyPartialCount: number;
  leader: { id: string; name: string; symbol: string } | null;
}

export interface NonUsdMarketSnapshot {
  /** Core market cap over observed members (the share denominator). */
  totalMarketCap: number | null;
  /** Known non-USD market cap; a partial subtotal when `altSupplyUnavailableCount` or `altSupplyPartialCount` is nonzero. */
  altMarketCap: number | null;
  altSharePct: number | null;
  commodityMarketCap: number | null;
  nonCommodityMarketCap: number | null;
  /** Commodity / non-commodity shares of the non-USD total; `null` unless every non-USD member is fully observed. */
  commoditySharePct: number | null;
  nonCommoditySharePct: number | null;
  supplyObservedCount: number;
  supplyUnavailableCount: number;
  /** Observed core members whose amount excludes unavailable chains. */
  supplyPartialCount: number;
  altSupplyObservedCount: number;
  altSupplyUnavailableCount: number;
  /** Observed non-USD members whose amount excludes unavailable chains. */
  altSupplyPartialCount: number;
  altCoinCount: number;
  pegs: NonUsdPegEntry[];
}

const EMPTY_SNAPSHOT: NonUsdMarketSnapshot = {
  totalMarketCap: null,
  altMarketCap: null,
  altSharePct: null,
  commodityMarketCap: null,
  nonCommodityMarketCap: null,
  commoditySharePct: null,
  nonCommoditySharePct: null,
  supplyObservedCount: 0,
  supplyUnavailableCount: 0,
  supplyPartialCount: 0,
  altSupplyObservedCount: 0,
  altSupplyUnavailableCount: 0,
  altSupplyPartialCount: 0,
  altCoinCount: 0,
  pegs: [],
};

/** Every core non-USD member and its registry peg: the denominator a partial read is measured against. */
const CORE_NON_USD_PEG_BY_ID: ReadonlyMap<string, PegCurrency> = new Map(
  [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].flatMap((id) => {
    const peg = CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency;
    return peg != null && peg !== "USD" ? [[id, peg] as const] : [];
  }),
);

/** Registry peg for a core member; `null` for non-core or unknown ids. */
export function getCoreNonUsdPeg(id: string): PegCurrency | null {
  return CORE_NON_USD_PEG_BY_ID.get(id) ?? null;
}

function shareOf(part: number, whole: number): number {
  return (part / whole) * 100;
}

export function buildNonUsdMarketSnapshot(rows: readonly NonUsdMarketRow[] | null | undefined): NonUsdMarketSnapshot {
  // Array.isArray widens a readonly array to any[]; test an unknown view to keep row typing.
  if (rows == null || !Array.isArray(rows as unknown) || rows.length === 0) return EMPTY_SNAPSHOT;

  let totalMarketCap = 0;
  let supplyObservedCount = 0;
  let supplyUnavailableCount = 0;
  let supplyPartialCount = 0;
  let commodityMarketCap = 0;
  let nonCommodityMarketCap = 0;
  let commodityObservedCount = 0;
  let nonCommodityObservedCount = 0;
  let altSupplyUnavailableCount = 0;
  let altSupplyPartialCount = 0;
  const seenIds = new Set<string>();
  const byPeg = new Map<PegCurrency, {
    marketCap: number;
    coinCount: number;
    supplyObservedCount: number;
    supplyPartialCount: number;
    leader: { id: string; name: string; symbol: string; marketCap: number } | null;
  }>();

  for (const row of rows) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(row.id) || seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    const marketCap = getCirculatingRawOrNull(row);
    const supplyPartial = marketCap !== null
      && classifySupplyCoverage(buildSupplyObservationProvenance(row)) === "partial";
    if (marketCap === null) supplyUnavailableCount += 1;
    else {
      supplyObservedCount += 1;
      totalMarketCap += marketCap;
      if (supplyPartial) supplyPartialCount += 1;
    }

    const peg = getCoreNonUsdPeg(row.id);
    if (peg === null) continue;
    const entry = byPeg.get(peg) ?? { marketCap: 0, coinCount: 0, supplyObservedCount: 0, supplyPartialCount: 0, leader: null };
    byPeg.set(peg, entry);
    entry.coinCount += 1;
    if (marketCap === null) {
      altSupplyUnavailableCount += 1;
      continue;
    }
    entry.marketCap += marketCap;
    entry.supplyObservedCount += 1;
    if (supplyPartial) {
      entry.supplyPartialCount += 1;
      altSupplyPartialCount += 1;
    }
    if (entry.leader === null || marketCap > entry.leader.marketCap) {
      entry.leader = { id: row.id, name: row.name, symbol: row.symbol, marketCap };
    }
    if (isCommodityPeg(peg)) {
      commodityObservedCount += 1;
      commodityMarketCap += marketCap;
    } else {
      nonCommodityObservedCount += 1;
      nonCommodityMarketCap += marketCap;
    }
  }

  // A core member the list omits is unavailable, not absent from the market.
  supplyUnavailableCount += CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size - seenIds.size;
  for (const [id, peg] of CORE_NON_USD_PEG_BY_ID) {
    if (seenIds.has(id)) continue;
    altSupplyUnavailableCount += 1;
    const entry = byPeg.get(peg) ?? { marketCap: 0, coinCount: 0, supplyObservedCount: 0, supplyPartialCount: 0, leader: null };
    byPeg.set(peg, entry);
    entry.coinCount += 1;
  }

  const altSupplyObservedCount = commodityObservedCount + nonCommodityObservedCount;
  const altMarketCap = commodityMarketCap + nonCommodityMarketCap;
  // A partial-chain remainder is an observed amount, not a complete one: it stays
  // in the known subtotal but every exact share and rank is withheld.
  const sharesComplete = altSupplyUnavailableCount === 0 && altSupplyPartialCount === 0 && altMarketCap > 0;
  const pegs = [...byPeg.entries()]
    .map(([peg, entry]): NonUsdPegEntry => ({
      peg,
      commodity: isCommodityPeg(peg),
      marketCap: entry.supplyObservedCount > 0 ? entry.marketCap : null,
      sharePct: sharesComplete ? shareOf(entry.marketCap, altMarketCap) : null,
      coinCount: entry.coinCount,
      supplyObservedCount: entry.supplyObservedCount,
      supplyUnavailableCount: entry.coinCount - entry.supplyObservedCount,
      supplyPartialCount: entry.supplyPartialCount,
      leader: entry.leader && { id: entry.leader.id, name: entry.leader.name, symbol: entry.leader.symbol },
    }))
    .sort(compareFiniteDesc<NonUsdPegEntry>((entry) => entry.marketCap ?? Number.NaN));

  return {
    totalMarketCap: supplyObservedCount > 0 ? totalMarketCap : null,
    altMarketCap: altSupplyObservedCount > 0 ? altMarketCap : null,
    altSharePct: supplyUnavailableCount === 0 && supplyPartialCount === 0 && altSupplyObservedCount > 0 && totalMarketCap > 0
      ? shareOf(altMarketCap, totalMarketCap) : null,
    commodityMarketCap: commodityObservedCount > 0 ? commodityMarketCap : null,
    nonCommodityMarketCap: nonCommodityObservedCount > 0 ? nonCommodityMarketCap : null,
    commoditySharePct: sharesComplete ? shareOf(commodityMarketCap, altMarketCap) : null,
    nonCommoditySharePct: sharesComplete ? shareOf(nonCommodityMarketCap, altMarketCap) : null,
    supplyObservedCount,
    supplyUnavailableCount,
    supplyPartialCount,
    altSupplyObservedCount,
    altSupplyUnavailableCount,
    altSupplyPartialCount,
    altCoinCount: altSupplyObservedCount + altSupplyUnavailableCount,
    pegs,
  };
}

/** One rounding for a peg's share of the non-USD total (0–100 scale): a nonzero share never prints as 0.0%. */
export function formatNonUsdShare(sharePct: number | null): string {
  if (sharePct === null) return "—";
  if (sharePct > 0 && sharePct < 0.05) return "<0.1%";
  return `${sharePct.toFixed(1)}%`;
}
