import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { compareFiniteDesc } from "@shared/lib/sort";
import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import type { PegCurrency, StablecoinData } from "@shared/types";
import type { NonUsdSharePoint } from "@shared/types/market";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";
import { buildStablecoinUrl } from "@shared/lib/urls";

const OTHER_PEGS = new Set<PegCurrency>(["VAR", "OTHER"]);

type AltPegGroup = "Fiat" | "Commodity" | "Other";
export type AltPegRegion = "Europe" | "Asia" | "Americas" | "Africa" | "Oceania" | "Other";

const PEG_TAXONOMY_BY_VALUE = new Map(PEG_TAXONOMY_PAGES.map((page) => [page.value, page]));

export interface AltPegDistributionRow {
  peg: PegCurrency;
  label: string;
  href: string;
  group: AltPegGroup;
  marketCap: number | null;
  sharePct: number | null;
  supplyObservedCount: number;
  supplyUnavailableCount: number;
  coinCount: number;
  leaderSymbol: string;
  leaderName: string;
  leaderHref: string;
  colorHex: string;
  colorTextClass: string;
  colorBgClass: string;
}

export interface AltPegSnapshot {
  totalMarketCap: number | null;
  altMarketCap: number | null;
  altSharePct: number | null;
  fiatNonUsdMarketCap: number | null;
  commodityMarketCap: number | null;
  supplyObservedCount: number;
  supplyUnavailableCount: number;
  altSupplyObservedCount: number;
  altSupplyUnavailableCount: number;
  altCoinCount: number;
  altPegCount: number;
  distributionRows: AltPegDistributionRow[];
  topRows: AltPegDistributionRow[];
}


export interface AltPegTrendStats {
  latestSharePct: number;
  latestAltMarketCap: number;
  yearlyShareDeltaPctPoints: number | null;
  yearlyMarketCapChangePct: number | null;
}

export interface AltPegLinkHubItem {
  peg: PegCurrency;
  label: string;
  href: string;
  coinCount: number;
  symbolPreview: string;
  group: AltPegGroup;
  region: AltPegRegion;
  colorHex: string;
}

export interface AltPegLinkHubGroup {
  label: AltPegGroup;
  items: AltPegLinkHubItem[];
}

const EMPTY_SNAPSHOT: AltPegSnapshot = {
  totalMarketCap: null,
  altMarketCap: null,
  altSharePct: null,
  fiatNonUsdMarketCap: null,
  commodityMarketCap: null,
  supplyObservedCount: 0,
  supplyUnavailableCount: 0,
  altSupplyObservedCount: 0,
  altSupplyUnavailableCount: 0,
  altCoinCount: 0,
  altPegCount: 0,
  distributionRows: [],
  topRows: [],
};

function getAltPegGroup(peg: PegCurrency): AltPegGroup {
  if (isCommodityPeg(peg)) return "Commodity";
  if (OTHER_PEGS.has(peg)) return "Other";
  return "Fiat";
}

function isAltPeg(peg: PegCurrency): boolean {
  return peg !== "USD";
}

function getFiatPegRegion(peg: PegCurrency): AltPegRegion {
  switch (peg) {
    case "EUR":
    case "CHF":
    case "GBP":
    case "RUB":
    case "TRY":
    case "UAH":
    case "CZK":
    case "PLN":
      return "Europe";
    case "JPY":
    case "KRW":
    case "IDR":
    case "MYR":
    case "SGD":
    case "CNH":
    case "CNY":
    case "PHP":
    case "KGS":
    case "VND":
    case "AED":
      return "Asia";
    case "BRL":
    case "CAD":
    case "MXN":
    case "ARS":
      return "Americas";
    case "ZAR":
    case "NGN":
    case "XOF":
      return "Africa";
    case "AUD":
      return "Oceania";
    default:
      return "Other";
  }
}

function sharePointTotal(point: NonUsdSharePoint): number {
  return point.commodityShare + point.fiatNonUsdShare;
}

function sharePointMarketCap(point: NonUsdSharePoint): number {
  return point.commodity + point.fiatNonUsd;
}

export function buildAltPegSnapshot(peggedAssets?: StablecoinData[]): AltPegSnapshot {
  if (!Array.isArray(peggedAssets) || peggedAssets.length === 0) return EMPTY_SNAPSHOT;

  let totalMarketCap = 0;
  let fiatNonUsdMarketCap = 0;
  let commodityMarketCap = 0;
  let supplyObservedCount = 0;
  let supplyUnavailableCount = 0;
  let altSupplyObservedCount = 0;
  let altSupplyUnavailableCount = 0;
  let fiatObservedCount = 0;
  let commodityObservedCount = 0;
  const seenIds = new Set<string>();
  const distributionMap = new Map<PegCurrency, {
    marketCap: number;
    coinCount: number;
    supplyObservedCount: number;
    supplyUnavailableCount: number;
    leaderId: string;
    leaderName: string;
    leaderSymbol: string;
    leaderMcap: number | null;
  }>();

  for (const coin of peggedAssets) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(coin.id) || seenIds.has(coin.id)) continue;
    seenIds.add(coin.id);
    const marketCap = getCirculatingRawOrNull(coin);
    if (marketCap === null) {
      supplyUnavailableCount += 1;
    } else {
      supplyObservedCount += 1;
      totalMarketCap += marketCap;
    }

    const meta = ACTIVE_META_BY_ID.get(coin.id);
    if (!meta || !isAltPeg(meta.flags.pegCurrency)) continue;
    const peg = meta.flags.pegCurrency;
    if (marketCap === null) {
      altSupplyUnavailableCount += 1;
    } else {
      altSupplyObservedCount += 1;
      if (isCommodityPeg(peg)) {
        commodityObservedCount += 1;
        commodityMarketCap += marketCap;
      } else {
        fiatObservedCount += 1;
        fiatNonUsdMarketCap += marketCap;
      }
    }

    const existing = distributionMap.get(peg);
    if (!existing) {
      distributionMap.set(peg, {
        marketCap: marketCap ?? 0,
        coinCount: 1,
        supplyObservedCount: marketCap === null ? 0 : 1,
        supplyUnavailableCount: marketCap === null ? 1 : 0,
        leaderId: coin.id,
        leaderName: coin.name,
        leaderSymbol: coin.symbol,
        leaderMcap: marketCap,
      });
      continue;
    }
    existing.coinCount += 1;
    if (marketCap === null) {
      existing.supplyUnavailableCount += 1;
      continue;
    }
    existing.marketCap += marketCap;
    existing.supplyObservedCount += 1;
    if (existing.leaderMcap === null || marketCap > existing.leaderMcap) {
      existing.leaderId = coin.id;
      existing.leaderName = coin.name;
      existing.leaderSymbol = coin.symbol;
      existing.leaderMcap = marketCap;
    }
  }

  const altMarketCap = fiatNonUsdMarketCap + commodityMarketCap;
  const distributionRows = [...distributionMap.entries()]
    .map(([peg, entry]) => {
      const page = PEG_TAXONOMY_BY_VALUE.get(peg);
      const pegMeta = PEG_CHART_COLORS[peg] ?? PEG_CHART_COLORS.OTHER;
      return {
        peg,
        label: page?.shortLabel ?? pegMeta.label ?? peg,
        href: page?.href ?? "#",
        group: getAltPegGroup(peg),
        marketCap: entry.supplyObservedCount > 0 ? entry.marketCap : null,
        sharePct: altSupplyUnavailableCount === 0 && entry.supplyObservedCount > 0 && altMarketCap > 0
          ? (entry.marketCap / altMarketCap) * 100 : null,
        supplyObservedCount: entry.supplyObservedCount,
        supplyUnavailableCount: entry.supplyUnavailableCount,
        coinCount: entry.coinCount,
        leaderSymbol: entry.leaderSymbol,
        leaderName: entry.leaderName,
        leaderHref: buildStablecoinUrl(entry.leaderId),
        colorHex: pegMeta.hex,
        colorTextClass: pegMeta.textColor,
        colorBgClass: pegMeta.bgColor,
      } satisfies AltPegDistributionRow;
    })
    .sort(compareFiniteDesc<AltPegDistributionRow>((row) => row.marketCap ?? Number.NaN));

  return {
    totalMarketCap: supplyObservedCount > 0 ? totalMarketCap : null,
    altMarketCap: altSupplyObservedCount > 0 ? altMarketCap : null,
    altSharePct: supplyUnavailableCount === 0 && altSupplyObservedCount > 0 && totalMarketCap > 0
      ? (altMarketCap / totalMarketCap) * 100 : null,
    fiatNonUsdMarketCap: fiatObservedCount > 0 ? fiatNonUsdMarketCap : null,
    commodityMarketCap: commodityObservedCount > 0 ? commodityMarketCap : null,
    supplyObservedCount,
    supplyUnavailableCount,
    altSupplyObservedCount,
    altSupplyUnavailableCount,
    altCoinCount: [...distributionMap.values()].reduce((sum, entry) => sum + entry.coinCount, 0),
    altPegCount: distributionMap.size,
    distributionRows,
    topRows: distributionRows.filter((row) => row.marketCap !== null).slice(0, 3),
  };
}

export function buildAltPegTrendStats(points?: readonly NonUsdSharePoint[]): AltPegTrendStats | null {
  // Keep the runtime array check without widening the readonly element type.
  const isArray = Boolean(Array.isArray(points));
  if (!isArray || !points || points.length === 0) return null;

  const latest = points[points.length - 1];
  if (!latest) return null;

  const latestSharePct = sharePointTotal(latest);
  const latestAltMarketCap = sharePointMarketCap(latest);
  const cutoff = latest.date - 365 * 86400;
  const yearAgo = [...points].reverse().find((point) => point.date <= cutoff) ?? null;

  return {
    latestSharePct,
    latestAltMarketCap,
    yearlyShareDeltaPctPoints: yearAgo ? latestSharePct - sharePointTotal(yearAgo) : null,
    yearlyMarketCapChangePct:
      yearAgo && sharePointMarketCap(yearAgo) > 0
        ? ((latestAltMarketCap - sharePointMarketCap(yearAgo)) / sharePointMarketCap(yearAgo)) * 100
        : null,
  };
}

export function buildAltPegLinkHubGroups(): AltPegLinkHubGroup[] {
  const groups = new Map<AltPegGroup, AltPegLinkHubItem[]>();
  const orderedGroups: AltPegGroup[] = ["Fiat", "Commodity", "Other"];

  for (const page of PEG_TAXONOMY_PAGES) {
    if (!isAltPeg(page.value)) continue;

    const pegMeta = PEG_CHART_COLORS[page.value] ?? PEG_CHART_COLORS.OTHER;
    const group = getAltPegGroup(page.value);
    const items = groups.get(group) ?? [];
    items.push({
      peg: page.value,
      label: page.shortLabel,
      href: page.href,
      coinCount: page.coins.length,
      symbolPreview: page.coins
        .slice(0, 3)
        .map((coin) => coin.symbol)
        .join(" · "),
      group,
      region: group === "Fiat" ? getFiatPegRegion(page.value) : "Other",
      colorHex: pegMeta.hex,
    });
    groups.set(group, items);
  }

  return orderedGroups
    .map((label) => ({
      label,
      items: (groups.get(label) ?? []).sort((left, right) => right.coinCount - left.coinCount),
    }))
    .filter((group) => group.items.length > 0);
}
