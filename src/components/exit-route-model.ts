import {
  PROTOCOL_COLORS,
  PROTOCOL_HEX,
  PROTOCOL_LOGOS,
  EXTRA_COLORS,
  CHAIN_COLORS,
  CHAIN_HEX,
  prettifyProtocol,
  normalizeChain,
} from "@/lib/dex-display-constants";
import { CHAIN_META } from "@shared/lib/chains";
import type { DexLiquidityData } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";

const MAX_EXIT_ROUTE_ITEMS = 5;
const ROUTE_SCALE_DOMAIN_PCT = 75;
const OTHER_ROUTE_COLOR = "oklch(0.68 0.02 248)";

export const EXIT_ROUTE_SCENE = {
  width: 1000,
  height: 430,
  doorX: 58,
  doorY: 76,
  doorRowGap: 50,
  doorApertureX: 208,
  doorApertureMaxWidth: 132,
  leftCollectorX: 392,
  throatX: 510,
  rightCollectorX: 650,
  laneX: 734,
  laneY: 70,
  laneRowGap: 54,
  laneMaxWidth: 174,
  laneLabelX: 748,
  laneLogoX: 936,
} as const;

export interface LiquidityExitRouteItem {
  key: string;
  label: string;
  valueUsd: number;
  sharePct: number;
  rank: number;
  isOther: boolean;
  flowIntensity: "low" | "medium" | "high";
  packetCount: number;
  colorClass: string;
  colorHex: string;
  logoPath?: string;
  darkInvert?: boolean;
}

export type ExitRouteSelectionKind = "protocol" | "chain" | "throat";

export interface LiquidityExitRouteSelection {
  kind: ExitRouteSelectionKind;
  key: string;
  label: string;
  valueUsd: number;
  sharePct: number | null;
  detail: string;
}

export interface LiquidityExitRouteModel {
  totalTvlUsd: number;
  totalVolume24hUsd: number;
  protocolCount: number;
  chainCount: number;
  poolCount: number;
  protocolRoutes: LiquidityExitRouteItem[];
  chainRoutes: LiquidityExitRouteItem[];
  topProtocol: LiquidityExitRouteItem | null;
  topChain: LiquidityExitRouteItem | null;
  concentrationHhi: number | null;
  weightedBalancePct: number | null;
  organicPct: number | null;
  interpretation: string;
}

export type ExitRouteCrowdingBand = "unknown" | "broad" | "visible" | "crowded";

export interface ExitRouteThroatGeometry {
  band: ExitRouteCrowdingBand;
  throatHalfWidth: number;
  railDashArray?: string;
  flowDashArray?: string;
  upperRail: string;
  lowerRail: string;
  channelPath: string;
  poolTickCount: number;
}

export interface ExitRouteProtocolGeometry {
  y: number;
  apertureWidth: number;
  strokeWidth: number;
  pathD: string;
}

export interface ExitRouteChainGeometry {
  y: number;
  laneWidth: number;
  laneHeight: number;
  strokeWidth: number;
  laneBarY: number;
  logoY: number;
  pathD: string;
}

function computeHhi(values: Record<string, number>): number | null {
  const positiveValues = Object.values(values).filter((value) => value > 0);
  const total = positiveValues.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return positiveValues.reduce((sum, value) => {
    const share = value / total;
    return sum + share * share;
  }, 0);
}

function finiteNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function stableRouteAccentColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `oklch(0.68 0.14 ${hash})`;
}

export function flowIntensityBand(sharePct: number): LiquidityExitRouteItem["flowIntensity"] {
  const share = Math.max(0, finiteNumber(sharePct));
  if (share >= 25) return "high";
  if (share >= 10) return "medium";
  return "low";
}

export function routePacketCount(sharePct: number): number {
  const share = Math.max(0, finiteNumber(sharePct));
  if (share >= 35) return 5;
  if (share >= 22) return 4;
  if (share >= 12) return 3;
  if (share >= 5) return 2;
  return 1;
}

export function throatLabelForCrowding(concentrationHhi: number | null): string {
  const hhi = finiteNumber(concentrationHhi, Number.NaN);
  if (!Number.isFinite(hhi)) return "Crowding not scored";
  if (hhi < 0.18) return "Broad route diversity";
  if (hhi < 0.35) return "Visible route concentration";
  return "Crowded exits";
}

export function crowdingBand(concentrationHhi: number | null): ExitRouteCrowdingBand {
  const hhi = finiteNumber(concentrationHhi, Number.NaN);
  if (!Number.isFinite(hhi)) return "unknown";
  if (hhi < 0.18) return "broad";
  if (hhi < 0.35) return "visible";
  return "crowded";
}

const THROAT_HALF_WIDTH_BY_BAND: Record<ExitRouteCrowdingBand, number> = {
  broad: 62,
  visible: 40,
  crowded: 22,
  unknown: 44,
};

export function routeMagnitudeScale(sharePct: number | null | undefined, min: number, max: number): number {
  if (max <= min) return min;
  const share = Math.max(0, Math.min(ROUTE_SCALE_DOMAIN_PCT, finiteNumber(sharePct)));
  const normalized = Math.sqrt(share / ROUTE_SCALE_DOMAIN_PCT);
  return Math.round(min + normalized * (max - min));
}

function routeY(index: number, base: number, gap: number): number {
  return base + Math.max(0, index) * gap;
}

export function organicDashArray(organicPct: number | null): string | undefined {
  const organic = finiteNumber(organicPct, Number.NaN);
  if (!Number.isFinite(organic) || organic >= 60) return undefined;
  if (organic >= 35) return "10 8";
  return "5 9";
}

export function balanceRailDashArray(balancePct: number | null): string | undefined {
  const balance = finiteNumber(balancePct, Number.NaN);
  if (!Number.isFinite(balance) || balance >= 70) return undefined;
  if (balance >= 45) return "12 8";
  return "5 8";
}

export function compactRouteLabel(label: string, maxLength = 14): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}...`;
}

export function selectionKey(kind: ExitRouteSelectionKind, key: string): string {
  return `${kind}:${key}`;
}

export function selectionFromRoute(kind: "protocol" | "chain", route: LiquidityExitRouteItem): LiquidityExitRouteSelection {
  return {
    kind,
    key: route.key,
    label: route.label,
    valueUsd: route.valueUsd,
    sharePct: route.sharePct,
    detail: kind === "protocol"
      ? `#${route.rank} protocol door by DEX TVL`
      : `#${route.rank} chain lane by DEX TVL`,
  };
}

export function defaultExitRouteSelection(model: LiquidityExitRouteModel): LiquidityExitRouteSelection {
  const route = model.topProtocol ?? model.topChain;
  if (route) return selectionFromRoute(model.topProtocol ? "protocol" : "chain", route);
  return aggregateThroatSelection(model);
}

export function aggregateThroatSelection(model: LiquidityExitRouteModel): LiquidityExitRouteSelection {
  return {
    kind: "throat",
    key: "aggregate",
    label: "Aggregate exit throat",
    valueUsd: model.totalTvlUsd,
    sharePct: null,
    detail: throatLabelForCrowding(model.concentrationHhi),
  };
}

export function protocolRouteGeometry(route: LiquidityExitRouteItem, index: number): ExitRouteProtocolGeometry {
  const y = routeY(index, EXIT_ROUTE_SCENE.doorY, EXIT_ROUTE_SCENE.doorRowGap);
  const apertureWidth = routeMagnitudeScale(route.sharePct, 28, EXIT_ROUTE_SCENE.doorApertureMaxWidth);
  const strokeWidth = routeMagnitudeScale(route.sharePct, 2, 12);
  return {
    y,
    apertureWidth,
    strokeWidth,
    pathD: `M ${EXIT_ROUTE_SCENE.doorApertureX + apertureWidth} ${y} C 288 ${y}, 330 ${176 + index * 8}, ${EXIT_ROUTE_SCENE.leftCollectorX} 202`,
  };
}

export function chainRouteGeometry(route: LiquidityExitRouteItem, index: number): ExitRouteChainGeometry {
  const y = routeY(index, EXIT_ROUTE_SCENE.laneY, EXIT_ROUTE_SCENE.laneRowGap);
  const laneWidth = routeMagnitudeScale(route.sharePct, 52, EXIT_ROUTE_SCENE.laneMaxWidth);
  const laneHeight = routeMagnitudeScale(route.sharePct, 7, 18);
  const strokeWidth = routeMagnitudeScale(route.sharePct, 2, 10);
  const laneBarY = y + 14;
  const logoY = laneBarY + laneHeight / 2;
  return {
    y,
    laneWidth,
    laneHeight,
    strokeWidth,
    laneBarY,
    logoY,
    pathD: `M ${EXIT_ROUTE_SCENE.rightCollectorX} 228 C 680 ${240 - index * 8}, 700 ${logoY}, ${EXIT_ROUTE_SCENE.laneX} ${logoY}`,
  };
}

function poolTickCount(poolCount: number | null | undefined): number {
  const pools = Math.max(10, finiteNumber(poolCount, 0));
  return Math.max(3, Math.min(12, Math.ceil(Math.log10(pools) * 3)));
}

export function throatGeometry(model: LiquidityExitRouteModel): ExitRouteThroatGeometry {
  const band = crowdingBand(model.concentrationHhi);
  const throatHalfWidth = THROAT_HALF_WIDTH_BY_BAND[band];
  const { leftCollectorX, throatX, rightCollectorX } = EXIT_ROUTE_SCENE;
  return {
    band,
    throatHalfWidth,
    railDashArray: balanceRailDashArray(model.weightedBalancePct),
    flowDashArray: organicDashArray(model.organicPct),
    upperRail: `M ${leftCollectorX} 120 C 444 120, 464 ${202 - throatHalfWidth}, ${throatX} ${202 - throatHalfWidth} C 558 ${202 - throatHalfWidth}, 590 120, ${rightCollectorX} 120`,
    lowerRail: `M ${leftCollectorX} 310 C 444 310, 464 ${228 + throatHalfWidth}, ${throatX} ${228 + throatHalfWidth} C 558 ${228 + throatHalfWidth}, 590 310, ${rightCollectorX} 310`,
    channelPath: [
      `M ${leftCollectorX} 132`,
      `C 448 126, 466 ${210 - throatHalfWidth}, ${throatX} ${210 - throatHalfWidth}`,
      `C 554 ${210 - throatHalfWidth}, 590 126, ${rightCollectorX} 132`,
      `L ${rightCollectorX} 298`,
      `C 590 304, 554 ${220 + throatHalfWidth}, ${throatX} ${220 + throatHalfWidth}`,
      `C 466 ${220 + throatHalfWidth}, 448 304, ${leftCollectorX} 298`,
      "Z",
    ].join(" "),
    poolTickCount: poolTickCount(model.poolCount),
  };
}

function buildExitRouteItems(
  values: Record<string, number>,
  {
    labelForKey,
    colorForKey,
    colorHexForKey,
    logoForKey,
    denominatorUsd,
  }: {
    labelForKey: (key: string) => string;
    colorForKey: (key: string, index: number) => string;
    colorHexForKey: (key: string, index: number) => string;
    logoForKey?: (key: string) => { path: string; darkInvert?: boolean } | null;
    denominatorUsd?: number;
  },
): LiquidityExitRouteItem[] {
  const sortedEntries = Object.entries(values)
    .filter(([, value]) => value > 0)
    .sort(([, a], [, b]) => b - a);
  const total = sortedEntries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return [];
  const shareBase = denominatorUsd && denominatorUsd > 0 ? denominatorUsd : total;
  const visibleEntries = sortedEntries.slice(0, MAX_EXIT_ROUTE_ITEMS);
  const omittedTotal = sortedEntries
    .slice(MAX_EXIT_ROUTE_ITEMS)
    .reduce((sum, [, value]) => sum + value, 0);

  const routes = visibleEntries.map(([key, value], index) => {
    const logo = logoForKey?.(key);
    const sharePct = (value / shareBase) * 100;
    return {
      key,
      label: labelForKey(key),
      valueUsd: value,
      sharePct,
      rank: index + 1,
      isOther: false,
      flowIntensity: flowIntensityBand(sharePct),
      packetCount: routePacketCount(sharePct),
      colorClass: colorForKey(key, index),
      colorHex: colorHexForKey(key, index),
      logoPath: logo?.path,
      darkInvert: logo?.darkInvert,
    };
  });

  if (omittedTotal > 0) {
    const sharePct = (omittedTotal / shareBase) * 100;
    routes.push({
      key: "_other-routes",
      label: "Other routes",
      valueUsd: omittedTotal,
      sharePct,
      rank: visibleEntries.length + 1,
      isOther: true,
      flowIntensity: flowIntensityBand(sharePct),
      packetCount: routePacketCount(sharePct),
      colorClass: "bg-muted-foreground",
      colorHex: OTHER_ROUTE_COLOR,
      logoPath: undefined,
      darkInvert: undefined,
    });
  }

  return routes;
}

export function buildLiquidityExitRouteModel(
  liquidityMap: Record<string, DexLiquidityData>,
  aggregateStats?: Pick<LiquidityStatsData, "avgBalance" | "avgOrganic">,
): LiquidityExitRouteModel | null {
  const globalData = liquidityMap[DEX_GLOBAL_KEY];
  if (!globalData || globalData.totalTvlUsd <= 0) return null;

  const protocolRoutes = buildExitRouteItems(globalData.protocolTvl ?? {}, {
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    colorHexForKey: (protocol) => PROTOCOL_HEX[protocol] ?? stableRouteAccentColor(`protocol:${protocol}`),
    logoForKey: (protocol) => {
      const path = PROTOCOL_LOGOS[protocol];
      return path ? { path } : null;
    },
    denominatorUsd: globalData.totalTvlUsd,
  });
  const chainRoutes = buildExitRouteItems(globalData.chainTvl ?? {}, {
    labelForKey: normalizeChain,
    colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
    colorHexForKey: (chain) => CHAIN_HEX[chain.toLowerCase()] ?? stableRouteAccentColor(`chain:${chain.toLowerCase()}`),
    logoForKey: (chain) => {
      const meta = CHAIN_META[chain.toLowerCase()];
      return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
    },
    denominatorUsd: globalData.totalTvlUsd,
  });
  const concentrationHhi = globalData.concentrationHhi ?? computeHhi(globalData.protocolTvl ?? {});
  const weightedBalancePct = globalData.weightedBalanceRatio == null
    ? aggregateStats?.avgBalance ?? null
    : Math.round(globalData.weightedBalanceRatio * 100);
  const organicPct = globalData.organicFraction == null
    ? aggregateStats?.avgOrganic ?? null
    : Math.round(globalData.organicFraction * 100);
  const interpretation =
    concentrationHhi == null
      ? "Route concentration is not scored for this snapshot."
      : concentrationHhi < 0.18
        ? "Exit depth is broadly distributed across venues."
        : concentrationHhi < 0.35
          ? "Exit depth is usable, but route concentration is visible."
          : "Exit depth is crowded into a small set of venues.";

  return {
    totalTvlUsd: globalData.totalTvlUsd,
    totalVolume24hUsd: globalData.totalVolume24hUsd,
    protocolCount: Object.values(globalData.protocolTvl ?? {}).filter((value) => value > 0).length,
    chainCount: Object.values(globalData.chainTvl ?? {}).filter((value) => value > 0).length,
    poolCount: globalData.poolCount,
    protocolRoutes,
    chainRoutes,
    topProtocol: protocolRoutes[0] ?? null,
    topChain: chainRoutes[0] ?? null,
    concentrationHhi,
    weightedBalancePct,
    organicPct,
    interpretation,
  };
}
