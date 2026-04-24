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

function routeStrokeWidth(sharePct: number): number {
  return Math.max(6, Math.min(30, 5 + Math.sqrt(Math.max(0, sharePct)) * 3.2));
}

function crowdingWaist(concentrationHhi: number | null): number {
  if (concentrationHhi == null) return 138;
  const clamped = Math.max(0.08, Math.min(0.5, concentrationHhi));
  const t = (clamped - 0.08) / 0.42;
  return Math.round(188 - t * 106);
}

function routeY(index: number, count: number): number {
  if (count <= 1) return 190;
  return 70 + (index * 240) / (count - 1);
}

function crowdingBand(concentrationHhi: number | null): "unknown" | "broad" | "visible" | "crowded" {
  if (concentrationHhi == null) return "unknown";
  if (concentrationHhi < 0.18) return "broad";
  if (concentrationHhi < 0.35) return "visible";
  return "crowded";
}

function ExitRouteTerminal({ model }: { model: LiquidityExitRouteModel }) {
  const centerX = 460;
  const centerY = 190;
  const waist = crowdingWaist(model.concentrationHhi);
  const outerWidth = 238;
  const terminalTop = 102;
  const terminalBottom = 278;
  const organicIsLow = model.organicPct != null && model.organicPct < 55;
  const balanceIsLow = model.weightedBalancePct != null && model.weightedBalancePct < 55;
  const protocolTargetX = centerX - waist / 2;
  const chainTargetX = centerX + waist / 2;
  const routeDash = organicIsLow ? "12 9" : undefined;
  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol route` : null,
    model.topChain ? `${model.topChain.label} leading chain lane` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-[radial-gradient(circle_at_50%_50%,oklch(0.18_0.03_180_/_0.32),transparent_38%),linear-gradient(180deg,oklch(0.13_0.014_248_/_0.78),oklch(0.08_0.012_248_/_0.92))]">
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 920 380"
          role="img"
          aria-label={`Exit route terminal: ${routeSummary}. Secondary-market DEX exits only.`}
          className="h-auto min-w-[620px] w-full md:min-w-0"
          data-testid="exit-route-terminal"
        >
          <defs>
            <linearGradient id="exit-route-terminal-surface" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.2 0.018 248 / 0.94)" />
              <stop offset="100%" stopColor="oklch(0.105 0.014 248 / 0.98)" />
            </linearGradient>
            <filter id="exit-route-terminal-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect x="0" y="0" width="920" height="380" fill="url(#exit-route-terminal-surface)" />
          {[58, 118, 178, 238, 298].map((y) => (
            <line key={y} x1="28" x2="892" y1={y} y2={y} stroke="oklch(1 0 0 / 0.055)" strokeDasharray="2 14" />
          ))}
          <text x="40" y="34" fill="oklch(0.78 0.025 248)" fontSize="11" fontWeight="700" letterSpacing="2.2">
            PROTOCOL GATES
          </text>
          <text x="730" y="34" fill="oklch(0.78 0.025 248)" fontSize="11" fontWeight="700" letterSpacing="2.2">
            CHAIN LANES
          </text>
          <text x={centerX} y="34" textAnchor="middle" fill="oklch(0.78 0.025 248)" fontSize="11" fontWeight="700" letterSpacing="2.2">
            EXIT CONCOURSE
          </text>

          {model.protocolRoutes.map((route, index) => {
            const y = routeY(index, model.protocolRoutes.length);
            const strokeWidth = routeStrokeWidth(route.sharePct);
            const path = `M 184 ${y} C 292 ${y}, ${protocolTargetX - 58} ${centerY}, ${protocolTargetX + 2} ${centerY}`;
            return (
              <g
                key={`protocol-${route.key}`}
                data-testid={`protocol-gate-${route.key}`}
                aria-label={`${route.label} protocol route, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} protocol route (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  d={path}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={routeDash}
                  opacity="0.58"
                  filter="url(#exit-route-terminal-glow)"
                />
                <rect
                  x="128"
                  y={y - strokeWidth / 2 - 8}
                  width={44 + route.sharePct * 0.55}
                  height={strokeWidth + 16}
                  rx="8"
                  fill="oklch(0.06 0.012 248 / 0.82)"
                  stroke={route.colorHex}
                  strokeWidth="1.4"
                  opacity="0.98"
                />
                <rect
                  x="136"
                  y={y - strokeWidth / 2 - 1}
                  width={Math.max(16, route.sharePct * 1.5)}
                  height={strokeWidth + 2}
                  rx="4"
                  fill={route.colorHex}
                  opacity="0.9"
                />
                <circle cx="52" cy={y} r="14" fill="oklch(0.98 0.006 248 / 0.96)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x="43" y={y - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x="52" y={y + 4} textAnchor="middle" fill="oklch(0.2 0.012 248)" fontSize="13" fontWeight="800">
                    +
                  </text>
                )}
                <text x="72" y={y - 5} fill="oklch(0.94 0.01 248)" fontSize="11" fontFamily="ui-monospace, Menlo, monospace">
                  {formatCurrency(route.valueUsd, 0)}
                </text>
                <text x="72" y={y + 10} fill="oklch(0.72 0.025 248)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                  {formatPercent(route.sharePct, 1)}
                </text>
              </g>
            );
          })}

          {model.chainRoutes.map((route, index) => {
            const y = routeY(index, model.chainRoutes.length);
            const strokeWidth = routeStrokeWidth(route.sharePct);
            const path = `M ${chainTargetX - 2} ${centerY} C ${chainTargetX + 58} ${centerY}, 628 ${y}, 726 ${y}`;
            return (
              <g
                key={`chain-${route.key}`}
                data-testid={`chain-lane-${route.key}`}
                aria-label={`${route.label} chain lane, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
              >
                <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain lane (${formatPercent(route.sharePct, 1)})`}</title>
                <path
                  d={path}
                  fill="none"
                  stroke={route.colorHex}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={routeDash}
                  opacity="0.58"
                  filter="url(#exit-route-terminal-glow)"
                />
                <rect
                  x="724"
                  y={y - strokeWidth / 2 - 6}
                  width={42 + route.sharePct * 0.62}
                  height={strokeWidth + 12}
                  rx="7"
                  fill={route.colorHex}
                  opacity="0.86"
                />
                <line
                  x1="724"
                  x2="852"
                  y1={y}
                  y2={y}
                  stroke={route.colorHex}
                  strokeWidth={Math.max(3, strokeWidth * 0.45)}
                  strokeLinecap="round"
                  opacity="0.68"
                />
                <text x="824" y={y - 5} fill="oklch(0.94 0.01 248)" fontSize="11" fontFamily="ui-monospace, Menlo, monospace" textAnchor="end">
                  {formatCurrency(route.valueUsd, 0)}
                </text>
                <text x="824" y={y + 10} fill="oklch(0.72 0.025 248)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace" textAnchor="end">
                  {formatPercent(route.sharePct, 1)}
                </text>
                <circle cx="846" cy={y} r="14" fill="oklch(0.98 0.006 248 / 0.96)" stroke={route.colorHex} strokeWidth="1.2" />
                {route.logoPath ? (
                  <image href={route.logoPath} x="837" y={y - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x="846" y={y + 4} textAnchor="middle" fill="oklch(0.2 0.012 248)" fontSize="13" fontWeight="800">
                    +
                  </text>
                )}
              </g>
            );
          })}

          <g
            data-testid="exit-concourse"
            data-crowding-band={crowdingBand(model.concentrationHhi)}
            aria-label={`Exit concourse crowding is ${crowdingBand(model.concentrationHhi)} with waist ${waist}`}
          >
            <path
              d={[
                `M ${centerX - outerWidth / 2} ${terminalTop}`,
                `C ${centerX - waist / 2} ${terminalTop + 44}, ${centerX - waist / 2} ${terminalBottom - 44}, ${centerX - outerWidth / 2} ${terminalBottom}`,
                `L ${centerX + outerWidth / 2} ${terminalBottom}`,
                `C ${centerX + waist / 2} ${terminalBottom - 44}, ${centerX + waist / 2} ${terminalTop + 44}, ${centerX + outerWidth / 2} ${terminalTop}`,
                "Z",
              ].join(" ")}
              fill="oklch(0.07 0.018 248 / 0.9)"
              stroke="oklch(0.76 0.12 178 / 0.72)"
              strokeWidth={balanceIsLow ? 1.2 : 1.8}
              strokeDasharray={balanceIsLow ? "8 7" : undefined}
            />
            <ellipse
              cx={centerX}
              cy={centerY}
              rx={Math.max(34, waist / 2 - 12)}
              ry="42"
              fill="oklch(0.77 0.13 178 / 0.14)"
              stroke="oklch(0.78 0.14 178 / 0.58)"
              strokeWidth="1"
            />
            <text x={centerX} y={centerY - 8} textAnchor="middle" fill="oklch(0.97 0.01 248)" fontSize="14" fontWeight="800">
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text x={centerX} y={centerY + 12} textAnchor="middle" fill="oklch(0.75 0.025 248)" fontSize="10" fontWeight="700" letterSpacing="1.5">
              SECONDARY EXIT TVL
            </text>
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
            <ExitRouteTerminal model={model} />
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
