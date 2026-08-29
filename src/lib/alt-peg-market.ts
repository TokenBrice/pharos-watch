import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { getCirculatingRaw } from "@shared/lib/supply";
import { compareFiniteDesc } from "@shared/lib/sort";
import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import type { PegCurrency, StablecoinData } from "@shared/types";
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
  marketCap: number;
  sharePct: number;
  coinCount: number;
  leaderSymbol: string;
  leaderName: string;
  leaderHref: string;
  colorHex: string;
  colorTextClass: string;
  colorBgClass: string;
}

export interface AltPegSnapshot {
  totalMarketCap: number;
  altMarketCap: number;
  altSharePct: number;
  fiatNonUsdMarketCap: number;
  commodityMarketCap: number;
  altCoinCount: number;
  altPegCount: number;
  distributionRows: AltPegDistributionRow[];
  topRows: AltPegDistributionRow[];
}

export interface AltPegTrendPoint {
  date: number;
  commodityShare: number | null;
  fiatNonUsdShare: number | null;
  commodity: number | null;
  fiatNonUsd: number | null;
  total: number;
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
  totalMarketCap: 0,
  altMarketCap: 0,
  altSharePct: 0,
  fiatNonUsdMarketCap: 0,
  commodityMarketCap: 0,
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

function sharePointTotal(point: AltPegTrendPoint): number {
  return (point.commodityShare ?? 0) + (point.fiatNonUsdShare ?? 0);
}

function sharePointMarketCap(point: AltPegTrendPoint): number {
  return (point.commodity ?? 0) + (point.fiatNonUsd ?? 0);
}

export function buildAltPegSnapshot(peggedAssets?: StablecoinData[]): AltPegSnapshot {
  if (!Array.isArray(peggedAssets) || peggedAssets.length === 0) return EMPTY_SNAPSHOT;

  let totalMarketCap = 0;
  let fiatNonUsdMarketCap = 0;
  let commodityMarketCap = 0;
  const altPegIds = new Set<string>();
  const altPegs = new Set<PegCurrency>();
  const distributionMap = new Map<
    PegCurrency,
    {
      marketCap: number;
      coinCount: number;
      leaderId: string;
      leaderName: string;
      leaderSymbol: string;
      leaderMcap: number;
    }
  >();

  for (const coin of peggedAssets) {
    if (!CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(coin.id)) continue;
    const marketCap = getCirculatingRaw(coin);
    totalMarketCap += marketCap;

    const meta = ACTIVE_META_BY_ID.get(coin.id);
    if (!meta || !isAltPeg(meta.flags.pegCurrency)) continue;

    const peg = meta.flags.pegCurrency;
    altPegIds.add(coin.id);
    altPegs.add(peg);

    if (isCommodityPeg(peg)) {
      commodityMarketCap += marketCap;
    } else {
      fiatNonUsdMarketCap += marketCap;
    }

    const existing = distributionMap.get(peg);
    if (!existing) {
      distributionMap.set(peg, {
        marketCap,
        coinCount: 1,
        leaderId: coin.id,
        leaderName: coin.name,
        leaderSymbol: coin.symbol,
        leaderMcap: marketCap,
      });
      continue;
    }

    existing.marketCap += marketCap;
    existing.coinCount += 1;
    if (marketCap > existing.leaderMcap) {
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
        marketCap: entry.marketCap,
        sharePct: altMarketCap > 0 ? (entry.marketCap / altMarketCap) * 100 : 0,
        coinCount: entry.coinCount,
        leaderSymbol: entry.leaderSymbol,
        leaderName: entry.leaderName,
        leaderHref: buildStablecoinUrl(entry.leaderId),
        colorHex: pegMeta.hex,
        colorTextClass: pegMeta.textColor,
        colorBgClass: pegMeta.bgColor,
      } satisfies AltPegDistributionRow;
    })
    .sort(compareFiniteDesc<AltPegDistributionRow>((row) => row.marketCap));

  return {
    totalMarketCap,
    altMarketCap,
    altSharePct: totalMarketCap > 0 ? (altMarketCap / totalMarketCap) * 100 : 0,
    fiatNonUsdMarketCap,
    commodityMarketCap,
    altCoinCount: altPegIds.size,
    altPegCount: altPegs.size,
    distributionRows,
    topRows: distributionRows.slice(0, 3),
  };
}

export function buildAltPegTrendStats(points?: readonly AltPegTrendPoint[]): AltPegTrendStats | null {
  if (!Array.isArray(points) || points.length === 0) return null;

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
