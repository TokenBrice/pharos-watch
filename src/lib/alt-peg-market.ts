import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { buildNonUsdMarketSnapshot, type NonUsdMarketSnapshot } from "@shared/lib/alt-peg-snapshot";
import type { PegCurrency, StablecoinData } from "@shared/types";
import type { NonUsdSharePoint } from "@shared/types/market";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";
import { buildStablecoinUrl } from "@shared/lib/urls";

const OTHER_PEGS = new Set<PegCurrency>(["VAR", "OTHER"]);

type AltPegGroup = "Fiat" | "Commodity" | "Other";

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

export interface AltPegSnapshot extends NonUsdMarketSnapshot {
  altPegCount: number;
  distributionRows: AltPegDistributionRow[];
}


export interface AltPegTrendStats {
  /** Latest included provider-wide sample (unix seconds): the share's "as of", never "current". */
  latestDate: number;
  latestSharePct: number;
  /** The latest sample estimates or lacks value for some assets. */
  latestCoverageIncomplete: boolean;
  latestAltMarketCap: number;
  yearlyShareDeltaPctPoints: number | null;
  yearlyMarketCapChangePct: number | null;
  valueCoverageIncomplete: boolean;
}

function getAltPegGroup(peg: PegCurrency): AltPegGroup {
  if (isCommodityPeg(peg)) return "Commodity";
  if (OTHER_PEGS.has(peg)) return "Other";
  return "Fiat";
}

function sharePointTotal(point: NonUsdSharePoint): number {
  return point.commodityShare + point.fiatNonUsdShare;
}

function isCoverageIncomplete(point: NonUsdSharePoint): boolean {
  return point.coverage == null || point.coverage.total < 1 || point.coverage.commodity < 1 || point.coverage.fiatNonUsd < 1;
}

function sharePointMarketCap(point: NonUsdSharePoint): number {
  return point.commodity + point.fiatNonUsd;
}

export function buildAltPegSnapshot(peggedAssets?: StablecoinData[]): AltPegSnapshot {
  const snapshot = buildNonUsdMarketSnapshot(peggedAssets);
  const distributionRows = snapshot.pegs.map((entry): AltPegDistributionRow => {
    const page = PEG_TAXONOMY_BY_VALUE.get(entry.peg);
    const pegMeta = PEG_CHART_COLORS[entry.peg] ?? PEG_CHART_COLORS.OTHER;
    return {
      peg: entry.peg,
      label: page?.shortLabel ?? pegMeta.label ?? entry.peg,
      href: page?.href ?? "#",
      group: getAltPegGroup(entry.peg),
      marketCap: entry.marketCap,
      sharePct: entry.sharePct,
      supplyObservedCount: entry.supplyObservedCount,
      supplyUnavailableCount: entry.supplyUnavailableCount,
      coinCount: entry.coinCount,
      leaderSymbol: entry.leader?.symbol ?? "",
      leaderName: entry.leader?.name ?? "",
      leaderHref: entry.leader ? buildStablecoinUrl(entry.leader.id) : "#",
      colorHex: pegMeta.hex,
      colorTextClass: pegMeta.textColor,
      colorBgClass: pegMeta.bgColor,
    };
  });
  return { ...snapshot, altPegCount: distributionRows.length, distributionRows };
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
    latestDate: latest.date,
    latestSharePct,
    latestCoverageIncomplete: isCoverageIncomplete(latest),
    latestAltMarketCap,
    yearlyShareDeltaPctPoints: yearAgo ? latestSharePct - sharePointTotal(yearAgo) : null,
    yearlyMarketCapChangePct:
      yearAgo && sharePointMarketCap(yearAgo) > 0
        ? ((latestAltMarketCap - sharePointMarketCap(yearAgo)) / sharePointMarketCap(yearAgo)) * 100
        : null,
    valueCoverageIncomplete: [latest, yearAgo].some((point) => point != null && isCoverageIncomplete(point)),
  };
}

const ALT_PEG_BY_PARAM = new Map<string, PegCurrency>(
  PEG_TAXONOMY_PAGES.filter((page) => page.value !== "USD").map((page) => [page.value.toLowerCase(), page.value]),
);

/** `?peg=` value (case-insensitive peg code) → a non-USD peg, or `null` for absent/unknown values. */
export function parseAltPegParam(raw: string | null): PegCurrency | null {
  return raw ? ALT_PEG_BY_PARAM.get(raw.toLowerCase()) ?? null : null;
}
