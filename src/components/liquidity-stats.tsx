"use client";

import { useMemo } from "react";
import { DoorOpen, Gauge, Route, Split } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildBreakdownEntries,
  BreakdownBar,
  BreakdownLegend,
  type BreakdownEntry,
} from "@/components/liquidity-breakdown";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency, formatPercent } from "@shared/lib/format";
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
import { getScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityData } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";
import "./exit-route-instrument.css";

export interface LiquidityStatsData {
  totalTvl: number;
  totalVol: number;
  avgScore: number;
  withLiquidity: number;
  highConfidenceCoverage: number;
  fallbackCoverage: number;
  totalTracked: number;
  agg7dChange: number | null;
  avgBalance: number | null;
  avgOrganic: number | null;
}

interface LiquidityStatsProps {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
}

const MAX_PROTOCOL_LEGEND_ITEMS = 10;
const MAX_VISIBLE_PROTOCOLS = MAX_PROTOCOL_LEGEND_ITEMS - 1;
const MAX_EXIT_ROUTE_ITEMS = 5;
const EXTRA_HEX = ["#10b981", "#84cc16", "#14b8a6", "#f43f5e", "#d946ef", "#eab308", "#a855f7", "#fb923c"];

export interface LiquidityExitRouteItem {
  key: string;
  label: string;
  valueUsd: number;
  sharePct: number;
  colorClass: string;
  colorHex: string;
  logoPath?: string;
  darkInvert?: boolean;
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

export function buildProtocolBreakdown(protocolTvl: Record<string, number>) {
  const { entries, total } = buildBreakdownEntries(protocolTvl, {
    maxVisibleItems: MAX_VISIBLE_PROTOCOLS,
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    logoForKey: (protocol) => {
      const path = PROTOCOL_LOGOS[protocol];
      return path ? { path } : null;
    },
  });
  const displayEntries = entries.map((entry) => [entry.key, entry.value] as [string, number]);
  const colorMap = Object.fromEntries(entries.map((entry) => [entry.key, entry.colorClass]));

  return { displayEntries, colorMap, total };
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
    return {
      key,
      label: labelForKey(key),
      valueUsd: value,
      sharePct: (value / shareBase) * 100,
      colorClass: colorForKey(key, index),
      colorHex: colorHexForKey(key, index),
      logoPath: logo?.path,
      darkInvert: logo?.darkInvert,
    };
  });

  if (omittedTotal > 0) {
    routes.push({
      key: "_other-routes",
      label: "Other routes",
      valueUsd: omittedTotal,
      sharePct: (omittedTotal / shareBase) * 100,
      colorClass: "bg-muted-foreground",
      colorHex: "#9ca3af",
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
    colorHexForKey: (protocol, index) => PROTOCOL_HEX[protocol] ?? EXTRA_HEX[index % EXTRA_HEX.length],
    logoForKey: (protocol) => {
      const path = PROTOCOL_LOGOS[protocol];
      return path ? { path } : null;
    },
    denominatorUsd: globalData.totalTvlUsd,
  });
  const chainRoutes = buildExitRouteItems(globalData.chainTvl ?? {}, {
    labelForKey: normalizeChain,
    colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
    colorHexForKey: (chain) => CHAIN_HEX[chain.toLowerCase()] ?? "#9ca3af",
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

function ExitRouteMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function crowdingBand(concentrationHhi: number | null): "unknown" | "broad" | "visible" | "crowded" {
  if (concentrationHhi == null) return "unknown";
  if (concentrationHhi < 0.18) return "broad";
  if (concentrationHhi < 0.35) return "visible";
  return "crowded";
}

const INSTRUMENT_WIDTH = 1000;
const INSTRUMENT_HEIGHT = 430;
const DOOR_X = 58;
const DOOR_Y = 76;
const DOOR_ROW_GAP = 50;
const DOOR_APERTURE_X = 208;
const DOOR_APERTURE_MAX_WIDTH = 132;
const LEFT_COLLECTOR_X = 392;
const THROAT_X = 510;
const RIGHT_COLLECTOR_X = 650;
const LANE_X = 734;
const LANE_Y = 70;
const LANE_ROW_GAP = 54;
const LANE_MAX_WIDTH = 174;
const LANE_LABEL_X = 748;
const LANE_LOGO_X = 936;

const THROAT_HALF_WIDTH_BY_BAND: Record<ReturnType<typeof crowdingBand>, number> = {
  broad: 62,
  visible: 40,
  crowded: 22,
  unknown: 44,
};

function routeScale(sharePct: number, min: number, max: number): number {
  const clamped = Math.max(0, Math.min(45, sharePct));
  return Math.round(min + (clamped / 45) * (max - min));
}

function routeY(index: number, base: number, gap: number): number {
  return base + index * gap;
}

function organicDashArray(organicPct: number | null): string | undefined {
  if (organicPct == null || organicPct >= 60) return undefined;
  if (organicPct >= 35) return "10 8";
  return "5 9";
}

function balanceRailDashArray(balancePct: number | null): string | undefined {
  if (balancePct == null || balancePct >= 70) return undefined;
  if (balancePct >= 45) return "12 8";
  return "5 8";
}

function compactRouteLabel(label: string, maxLength = 14): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}...`;
}

function ExitRouteInstrumentScene({ model }: { model: LiquidityExitRouteModel }) {
  const band = crowdingBand(model.concentrationHhi);
  const throatHalfWidth = THROAT_HALF_WIDTH_BY_BAND[band];
  const railDashArray = balanceRailDashArray(model.weightedBalancePct);
  const flowDashArray = organicDashArray(model.organicPct);

  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol` : null,
    model.topChain ? `${model.topChain.label} leading chain` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  const upperRail = `M ${LEFT_COLLECTOR_X} 120 C 444 120, 464 ${202 - throatHalfWidth}, ${THROAT_X} ${202 - throatHalfWidth} C 558 ${202 - throatHalfWidth}, 590 120, ${RIGHT_COLLECTOR_X} 120`;
  const lowerRail = `M ${LEFT_COLLECTOR_X} 310 C 444 310, 464 ${228 + throatHalfWidth}, ${THROAT_X} ${228 + throatHalfWidth} C 558 ${228 + throatHalfWidth}, 590 310, ${RIGHT_COLLECTOR_X} 310`;
  const channelPath = [
    `M ${LEFT_COLLECTOR_X} 132`,
    `C 448 126, 466 ${210 - throatHalfWidth}, ${THROAT_X} ${210 - throatHalfWidth}`,
    `C 554 ${210 - throatHalfWidth}, 590 126, ${RIGHT_COLLECTOR_X} 132`,
    `L ${RIGHT_COLLECTOR_X} 298`,
    `C 590 304, 554 ${220 + throatHalfWidth}, ${THROAT_X} ${220 + throatHalfWidth}`,
    `C 466 ${220 + throatHalfWidth}, 448 304, ${LEFT_COLLECTOR_X} 298`,
    "Z",
  ].join(" ");

  return (
    <div className="exit-route-instrument overflow-hidden rounded-xl border border-border/70">
      <div className="exit-route-instrument__viewport">
        <svg
          viewBox={`0 0 ${INSTRUMENT_WIDTH} ${INSTRUMENT_HEIGHT}`}
          role="img"
          aria-label={`Exit route instrument: ${routeSummary}. Secondary-market DEX exits only.`}
          className="exit-route-instrument__scene"
          data-testid="exit-route-instrument"
        >
          <defs>
            <linearGradient id="exit-route-instrument-stage" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--route-stage-top)" />
              <stop offset="100%" stopColor="var(--route-stage-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-channel-fill" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--route-channel-edge)" />
              <stop offset="50%" stopColor="var(--route-channel-throat)" />
              <stop offset="100%" stopColor="var(--route-channel-edge)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width={INSTRUMENT_WIDTH} height={INSTRUMENT_HEIGHT} fill="url(#exit-route-instrument-stage)" />
          <g stroke="var(--route-grid)" strokeWidth="1" aria-hidden="true">
            <line x1="372" y1="42" x2="372" y2="388" />
            <line x1="660" y1="42" x2="660" y2="388" />
            <line x1="40" y1="42" x2="960" y2="42" />
            <line x1="40" y1="388" x2="960" y2="388" />
          </g>

          <text x="54" y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" letterSpacing="1.8">
            PROTOCOL DOORS
          </text>
          <text x={LANE_X} y="30" fill="var(--route-caption)" fontSize="10" fontWeight="700" letterSpacing="1.8">
            CHAIN LANES
          </text>

          <path d={channelPath} fill="url(#exit-route-channel-fill)" opacity="0.78" />
          <path d={upperRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={railDashArray} />
          <path d={lowerRail} fill="none" stroke="var(--route-rail)" strokeWidth="2" strokeDasharray={railDashArray} />

          {model.protocolRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 16);
            const y = routeY(i, DOOR_Y, DOOR_ROW_GAP);
            const apertureWidth = routeScale(route.sharePct, 28, DOOR_APERTURE_MAX_WIDTH);
            const strokeWidth = routeScale(route.sharePct, 2, 12);
            return (
              <g
                key={`protocol-${route.key}`}
                data-testid={`protocol-door-${route.key}`}
                aria-label={`${route.label} protocol door, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} protocol door (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  d={`M ${DOOR_APERTURE_X + apertureWidth} ${y} C 288 ${y}, 330 ${176 + i * 8}, ${LEFT_COLLECTOR_X} 202`}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  opacity="0.4"
                  strokeDasharray={flowDashArray}
                />
                <rect x={DOOR_APERTURE_X} y={y - 10} width={apertureWidth} height="20" rx="2" fill={route.colorHex} opacity="0.78" />
                <rect x={DOOR_APERTURE_X - 8} y={y - 14} width="5" height="28" fill="var(--route-frame)" />
                <rect x={DOOR_APERTURE_X + apertureWidth + 3} y={y - 14} width="5" height="28" fill="var(--route-frame)" />
                <circle cx={DOOR_X} cy={y} r="13" fill="var(--route-chip-bg)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x={DOOR_X - 9} y={y - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={DOOR_X} y={y + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="13" fontWeight="800">+</text>
                )}
                <text x="78" y={y - 4} fill="var(--route-hero)" fontSize="12" fontWeight="700">
                  {label}
                </text>
                <text x="78" y={y + 10} fill="var(--route-caption)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                  {`${formatCurrency(route.valueUsd, 0)} · ${formatPercent(route.sharePct, 1)}`}
                </text>
              </g>
            );
          })}

          {model.chainRoutes.map((route, i) => {
            const label = compactRouteLabel(route.label, 14);
            const y = routeY(i, LANE_Y, LANE_ROW_GAP);
            const laneWidth = routeScale(route.sharePct, 52, LANE_MAX_WIDTH);
            const laneHeight = routeScale(route.sharePct, 7, 18);
            const strokeWidth = routeScale(route.sharePct, 2, 10);
            const laneBarY = y + 14;
            const logoY = laneBarY + laneHeight / 2;
            return (
              <g
                key={`chain-${route.key}`}
                data-testid={`chain-lane-${route.key}`}
                aria-label={`${route.label} chain lane, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain lane (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  d={`M ${RIGHT_COLLECTOR_X} 228 C 680 ${240 - i * 8}, 700 ${logoY}, ${LANE_X} ${logoY}`}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  opacity="0.30"
                  strokeDasharray={flowDashArray}
                />
                <text x={LANE_LABEL_X} y={y} fill="var(--route-hero)" fontSize="12" fontWeight="700">
                  {label}
                </text>
                <text x={LANE_LABEL_X} y={y + 13} fill="var(--route-caption)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                  {`${formatCurrency(route.valueUsd, 0)} · ${formatPercent(route.sharePct, 1)}`}
                </text>
                <rect x={LANE_X} y={laneBarY} width={laneWidth} height={laneHeight} rx="3" fill={route.colorHex} opacity="0.78" />
                <line x1={LANE_X} y1={laneBarY + 3} x2={LANE_X + laneWidth} y2={laneBarY + 3} stroke="var(--route-lane-highlight)" strokeWidth="0.7" opacity="0.5" />
                <circle cx={LANE_LOGO_X} cy={logoY} r="12" fill="var(--route-chip-bg)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x={LANE_LOGO_X - 8} y={logoY - 8} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={LANE_LOGO_X} y={logoY + 4} textAnchor="middle" fill="var(--route-hero)" fontSize="12" fontWeight="800">+</text>
                )}
              </g>
            );
          })}

          <g
            data-testid="exit-throat"
            data-crowding-band={band}
            aria-label={`Aggregate exit throat; crowding ${band}`}
          >
            <rect x={THROAT_X - 64} y="174" width="128" height="82" rx="6" fill="var(--route-throat-panel)" stroke="var(--route-rail)" strokeWidth="1" />
            <line x1={THROAT_X - throatHalfWidth} y1="164" x2={THROAT_X - throatHalfWidth} y2="266" stroke="var(--route-throat-marker)" strokeWidth="2" />
            <line x1={THROAT_X + throatHalfWidth} y1="164" x2={THROAT_X + throatHalfWidth} y2="266" stroke="var(--route-throat-marker)" strokeWidth="2" />
            <text
              x={THROAT_X}
              y="211"
              textAnchor="middle"
              fill="var(--route-hero)"
              fontSize="38"
              fontWeight="800"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text
              x={THROAT_X}
              y="231"
              textAnchor="middle"
              fill="var(--route-caption)"
              fontSize="9"
              fontWeight="700"
              letterSpacing="0.45"
              textLength="116"
              lengthAdjust="spacingAndGlyphs"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              SECONDARY EXIT TVL
            </text>
            <text
              x={THROAT_X}
              y="249"
              textAnchor="middle"
              fill="var(--route-throat-marker)"
              fontSize="10"
              fontWeight="700"
              letterSpacing="1.4"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {band.toUpperCase()} CROWDING
            </text>
          </g>

          <g
            className="exit-route-instrument__flow"
            data-testid="exit-route-flow-markers"
            stroke="var(--route-flow-marker)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={flowDashArray}
            aria-hidden="true"
          >
            <path d="M424 158 H 596" />
            <path d="M420 192 H 600" />
            <path d="M420 238 H 600" />
            <path d="M424 272 H 596" />
          </g>
        </svg>
      </div>
    </div>
  );
}

function LiquidityExitRouteMap({
  data,
  stats,
}: {
  data: Record<string, DexLiquidityData>;
  stats: LiquidityStatsData;
}) {
  const model = useMemo(() => buildLiquidityExitRouteModel(data, stats), [data, stats]);
  if (!model) return null;

  return (
    <Card className="overflow-hidden rounded-xl border-l-[3px] border-l-emerald-500">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold tracking-tight">Exit Route Map</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">
              DEX depth by venue and chain. This maps secondary-market exits only; issuer redemption capacity is scored separately.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="pharos-chart-stage space-y-3">
            <ExitRouteInstrumentScene model={model} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              <span>
                Leading door:{" "}
                <span className="font-medium text-foreground">{model.topProtocol?.label ?? "n/a"}</span>
              </span>
              <span>
                Leading lane:{" "}
                <span className="font-medium text-foreground">{model.topChain?.label ?? "n/a"}</span>
              </span>
              <span className="font-mono tabular-nums">{formatCurrency(model.totalTvlUsd, 0)} total DEX TVL</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <ExitRouteMetric
              icon={<DoorOpen className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
              label="Open routes"
              value={`${model.protocolCount} / ${model.chainCount}`}
              detail={`${model.poolCount} pools across protocol / chain buckets`}
            />
            <ExitRouteMetric
              icon={<Gauge className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
              label="Crowding index"
              value={model.concentrationHhi == null ? "NR" : model.concentrationHhi.toFixed(2)}
              detail="HHI concentration; lower means more route diversity"
            />
            <ExitRouteMetric
              icon={<Split className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
              label="Pool balance"
              value={model.weightedBalancePct == null ? "NR" : `${model.weightedBalancePct}%`}
              detail="TVL-weighted balance across measured pools"
            />
            <ExitRouteMetric
              icon={<Route className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />}
              label="Organic"
              value={model.organicPct == null ? "NR" : `${model.organicPct}%`}
              detail={`${formatCurrency(model.totalVolume24hUsd, 0)} 24h routed volume`}
            />
          </div>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Source: DEX liquidity snapshot. Exit routes show secondary-market depth, not issuer redemption capacity.
        </p>
      </CardContent>
    </Card>
  );
}

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const { entries, total } = useMemo(() => {
    return buildBreakdownEntries(globalData?.chainTvl ?? {}, {
      labelForKey: normalizeChain,
      colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
      logoForKey: (chain) => {
        const meta = CHAIN_META[chain.toLowerCase()];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    });
  }, [globalData]);

  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          Chain TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <BreakdownBar
          entries={entries}
          total={total}
          minPercent={0.5}
          className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
          titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(1)}%)`}
        />
        <BreakdownLegend
          entries={entries.slice(0, 10)}
          total={total}
          minPercent={0}
          variant="stacked"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          itemClassName="flex items-center gap-2"
          markerClassName="h-3 w-3"
          logoClassName="h-4 w-4 rounded-full object-contain shrink-0"
          logoSize={16}
          valueFormatter={(entry) => formatCurrency(entry.value)}
        />
      </CardContent>
    </Card>
  );
}

function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const entries = useMemo(() => {
    const { displayEntries, colorMap } = buildProtocolBreakdown(globalData?.protocolTvl ?? {});
    return displayEntries.map(([protocol, tvl]) => ({
      key: protocol,
      label: protocol === "_other" ? "Other" : prettifyProtocol(protocol),
      value: tvl,
      colorClass: colorMap[protocol] ?? "bg-muted-foreground",
      logoPath: protocol === "_other" ? undefined : PROTOCOL_LOGOS[protocol],
    })) satisfies BreakdownEntry[];
  }, [globalData]);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          Protocol TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <BreakdownBar
          entries={entries}
          total={total}
          minPercent={0.5}
          className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
          titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(1)}%)`}
        />
        <BreakdownLegend
          entries={entries}
          total={total}
          minPercent={0}
          variant="stacked"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          itemClassName="flex items-center gap-2"
          markerClassName="h-3 w-3"
          logoSize={16}
          valueFormatter={(entry) => formatCurrency(entry.value)}
        />
      </CardContent>
    </Card>
  );
}

export function LiquidityStats({ stats, liquidityMap }: LiquidityStatsProps) {
  return (
    <>
      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
        <MetricStatCard
          borderColorClass="border-l-blue-500"
          title="Total DEX TVL"
          value={formatCurrency(stats.totalTvl)}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext={
            <>
              Across all tracked stablecoins
              {stats.agg7dChange != null && (
                <span
                  className={`ml-2 font-mono ${stats.agg7dChange >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
                >
                  {stats.agg7dChange >= 0 ? "\u2191" : "\u2193"}
                  {Math.abs(stats.agg7dChange).toFixed(1)}% 7d
                </span>
              )}
            </>
          }
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-emerald-500"
          title="24h DEX Volume"
          value={formatCurrency(stats.totalVol)}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext="Trading volume today"
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-amber-500"
          title={<MethodologyLabel topic="liquidityScore">Avg Liq Score</MethodologyLabel>}
          value={
            <>
              {stats.avgScore}
              <span className="text-lg text-muted-foreground">/100</span>
            </>
          }
          valueClassName={`text-2xl font-extrabold font-mono tabular-nums tracking-tight ${getScoreColor(stats.avgScore)}`}
          subtext="Mean score of active coins"
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-violet-500"
          title={<MethodologyLabel topic="liquidityScore">Covered on DEX</MethodologyLabel>}
          value={stats.withLiquidity}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext={`${stats.highConfidenceCoverage} primary/mixed · ${stats.fallbackCoverage} fallback · of ${stats.totalTracked}`}
          subtextClassName="text-sm text-muted-foreground"
        />
        {stats.avgBalance != null && (
          <MetricStatCard
            borderColorClass="border-l-cyan-500"
            title="Avg Pool Balance"
            value={`${stats.avgBalance}%`}
            valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
            subtext="TVL-weighted average"
            subtextClassName="text-sm text-muted-foreground"
          />
        )}
        {stats.avgOrganic != null && (
          <MetricStatCard
            borderColorClass="border-l-pink-500"
            title="Organic Liquidity"
            value={`${stats.avgOrganic}%`}
            valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
            subtext="Fee-based vs incentivized"
            subtextClassName="text-sm text-muted-foreground"
          />
        )}
      </div>

      <LiquidityExitRouteMap data={liquidityMap} stats={stats} />

      {/* Protocol TVL Breakdown */}
      <ProtocolAggregateBar data={liquidityMap} />

      {/* Chain TVL Breakdown */}
      <ChainAggregateBar data={liquidityMap} />
    </>
  );
}
