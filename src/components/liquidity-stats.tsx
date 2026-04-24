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
import "./exit-route-canal.css";

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

// Canal scene geometry — viewBox is 1000 × 480.
// Gates occupy the left half of the canal so the right half reads as the open-water
// focal area carrying the aggregate-TVL numeric and the drifting vessel.
const SCENE_WIDTH = 1000;
const SCENE_HEIGHT = 480;
const CANAL_TOP = 140;
const CANAL_BOTTOM = 380;
const CANAL_LEFT_EDGE = 30;
const GATE_AREA_LEFT = 80;
const GATE_AREA_RIGHT = 500;
const GATE_AREA_WIDTH = GATE_AREA_RIGHT - GATE_AREA_LEFT; // 420
const OPEN_WATER_LEFT = GATE_AREA_RIGHT + 20;
const DAM_X = 748;
const DAM_WIDTH = 6;
const BASIN_LEFT = DAM_X + DAM_WIDTH;
const BASIN_RIGHT = 968;
const BASIN_AREA_TOP = 150;
const BASIN_AREA_BOTTOM = 372;
const BASIN_GAP = 4;

// Vessel drift duration per crowding band — higher HHI (crowded) = slower vessel.
// Applied via a CSS custom property so motion stays in the stylesheet.
const VESSEL_DURATION_BY_BAND: Record<ReturnType<typeof crowdingBand>, string> = {
  broad: "11s",
  visible: "14s",
  crowded: "22s",
  unknown: "14s",
};

// Canal taper on the open-water side — depth of the inward pinch toward the dam.
// Higher HHI = more squeeze. Makes data-crowding-band visually legible instead of
// being only a semantic attribute.
const CANAL_TAPER_BY_BAND: Record<ReturnType<typeof crowdingBand>, number> = {
  broad: 12,
  visible: 32,
  crowded: 64,
  unknown: 20,
};

const GATE_MIN_OPEN = 14;
const GATE_MAX_OPEN = 58;
const GATE_LEAN = 6;   // inward tilt at the top of each leaf (px)
const GATE_CHIP_R = 12;

function gateOpenWidth(sharePct: number): number {
  const clamped = Math.max(0, Math.min(45, sharePct));
  const t = clamped / 45;
  return Math.round(GATE_MIN_OPEN + t * (GATE_MAX_OPEN - GATE_MIN_OPEN));
}

function gateXPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [GATE_AREA_LEFT + GATE_AREA_WIDTH / 2];
  const step = GATE_AREA_WIDTH / count;
  return Array.from({ length: count }, (_, i) => GATE_AREA_LEFT + step * (i + 0.5));
}

function basinHeights(routes: LiquidityExitRouteItem[]): number[] {
  // Allocate BASIN_AREA_TOP..BASIN_AREA_BOTTOM proportionally to sharePct, with a
  // minimum row height for legibility. Invariant: minH * maxRoutes <= usable.
  // With MAX_EXIT_ROUTE_ITEMS = 5 + 1 "Other" = 6 rows and usable ≈ 200 px, minH=18
  // gives 108 px floor — well under the 200 px ceiling, so overflow is unreachable.
  if (routes.length === 0) return [];
  const usable = BASIN_AREA_BOTTOM - BASIN_AREA_TOP - BASIN_GAP * (routes.length - 1);
  const totalShare = routes.reduce((sum, r) => sum + Math.max(0, r.sharePct), 0);
  if (totalShare <= 0) return routes.map(() => 0);
  const raw = routes.map((r) => (Math.max(0, r.sharePct) / totalShare) * usable);
  const minH = 18;
  const floored = raw.map((h) => Math.max(minH, h));
  const sumFloored = floored.reduce((sum, h) => sum + h, 0);
  if (sumFloored <= usable) return floored.map((h) => Math.round(h));
  const scale = usable / sumFloored;
  return floored.map((h) => Math.round(h * scale));
}

function ExitRouteCanalScene({ model }: { model: LiquidityExitRouteModel }) {
  const band = crowdingBand(model.concentrationHhi);
  const taper = CANAL_TAPER_BY_BAND[band];
  const vesselDuration = VESSEL_DURATION_BY_BAND[band];

  const routeSummary = [
    `${formatCurrency(model.totalTvlUsd, 0)} DEX TVL`,
    model.topProtocol ? `${model.topProtocol.label} leading protocol` : null,
    model.topChain ? `${model.topChain.label} leading chain` : null,
    model.concentrationHhi == null ? null : `${model.concentrationHhi.toFixed(2)} crowding index`,
  ].filter(Boolean).join(", ");

  const canalPath = [
    `M ${CANAL_LEFT_EDGE} ${CANAL_TOP}`,
    `L ${OPEN_WATER_LEFT} ${CANAL_TOP}`,
    `L ${DAM_X} ${CANAL_TOP + taper}`,
    `L ${DAM_X} ${CANAL_BOTTOM - taper}`,
    `L ${OPEN_WATER_LEFT} ${CANAL_BOTTOM}`,
    `L ${CANAL_LEFT_EDGE} ${CANAL_BOTTOM}`,
    "Z",
  ].join(" ");

  return (
    <div
      className="exit-route-canal overflow-hidden rounded-xl border border-border/70"
      style={{ "--vessel-duration": vesselDuration } as React.CSSProperties}
    >
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={`Exit route canal: ${routeSummary}. Secondary-market DEX exits only.`}
          className="exit-route-canal__scene"
          data-testid="exit-route-canal"
        >
          <defs>
            <linearGradient id="exit-route-canal-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--canal-sky-top)" />
              <stop offset="70%" stopColor="var(--canal-sky-bottom)" />
              <stop offset="100%" stopColor="var(--canal-sea-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-water" x1="0" x2="1">
              <stop offset="0%" stopColor="var(--canal-water-shallow)" />
              <stop offset="100%" stopColor="var(--canal-water-deep)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-sea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--canal-sea-top)" />
              <stop offset="100%" stopColor="var(--canal-sea-bottom)" />
            </linearGradient>
            <linearGradient id="exit-route-canal-beam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--canal-beacon-beam)" />
              <stop offset="100%" stopColor="var(--canal-beacon-beam)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sky band */}
          <rect x="0" y="0" width={SCENE_WIDTH} height="140" fill="url(#exit-route-canal-sky)" />

          {/* Canal water body (tapers toward dam per crowding band) */}
          <path d={canalPath} fill="url(#exit-route-canal-water)" />

          {/* Waterline highlight */}
          <path
            d={`M ${CANAL_LEFT_EDGE} ${CANAL_TOP} L ${OPEN_WATER_LEFT} ${CANAL_TOP} L ${DAM_X} ${CANAL_TOP + taper}`}
            fill="none"
            stroke="var(--canal-accent)"
            strokeWidth="0.6"
            opacity="0.35"
          />

          {/* Upstream wall — stone column at the canal's left edge, with 4 tide-gauge ticks. */}
          <rect x={CANAL_LEFT_EDGE} y={CANAL_TOP} width="5" height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-wall-stone)" />
          <g stroke="var(--canal-caption-dim)" strokeWidth="0.8" opacity="0.7">
            <line x1={CANAL_LEFT_EDGE + 5} y1="180" x2={CANAL_LEFT_EDGE + 11} y2="180" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="220" x2={CANAL_LEFT_EDGE + 11} y2="220" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="260" x2={CANAL_LEFT_EDGE + 11} y2="260" />
            <line x1={CANAL_LEFT_EDGE + 5} y1="300" x2={CANAL_LEFT_EDGE + 11} y2="300" />
          </g>

          {/* Mitre-pair lock gates (protocols) */}
          {(() => {
            const xs = gateXPositions(model.protocolRoutes.length);
            return model.protocolRoutes.map((route, i) => {
              const open = gateOpenWidth(route.sharePct);
              const cx = xs[i];
              const leftPierX = cx - open / 2 - 10;
              const rightPierX = cx + open / 2 + 6;
              const canalDepth = CANAL_BOTTOM - CANAL_TOP;
              const chipCy = CANAL_TOP + canalDepth / 2;

              const leftLeaf = [
                `M ${leftPierX + 6} ${CANAL_TOP}`,
                `L ${cx - open / 2} ${CANAL_TOP + GATE_LEAN}`,
                `L ${cx - open / 2} ${CANAL_BOTTOM - GATE_LEAN}`,
                `L ${leftPierX + 6} ${CANAL_BOTTOM}`,
                "Z",
              ].join(" ");
              const rightLeaf = [
                `M ${rightPierX - 2} ${CANAL_TOP}`,
                `L ${cx + open / 2} ${CANAL_TOP + GATE_LEAN}`,
                `L ${cx + open / 2} ${CANAL_BOTTOM - GATE_LEAN}`,
                `L ${rightPierX - 2} ${CANAL_BOTTOM}`,
                "Z",
              ].join(" ");

              return (
                <g
                  key={`protocol-${route.key}`}
                  data-testid={`protocol-gate-${route.key}`}
                  aria-label={`${route.label} lock gate, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} lock gate (${formatPercent(route.sharePct, 1)})`}</title>
                  <rect x={leftPierX} y={CANAL_TOP} width="4" height={canalDepth} fill="var(--canal-wall-stone)" />
                  <path d={leftLeaf} fill={route.colorHex} fillOpacity="0.72" stroke="var(--canal-wall)" strokeWidth="0.6" />
                  <path d={rightLeaf} fill={route.colorHex} fillOpacity="0.72" stroke="var(--canal-wall)" strokeWidth="0.6" />
                  <rect x={rightPierX} y={CANAL_TOP} width="4" height={canalDepth} fill="var(--canal-wall-stone)" />
                  <rect x={leftPierX - 1} y={CANAL_TOP - 6} width={rightPierX - leftPierX + 6} height="4" fill="var(--canal-wall)" />
                  <circle cx={cx} cy={chipCy} r={GATE_CHIP_R} fill="oklch(0.06 0.012 248 / 0.92)" stroke={route.colorHex} strokeWidth="1.2" />
                  {route.logoPath ? (
                    <image href={route.logoPath} x={cx - 9} y={chipCy - 9} width="18" height="18" preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text x={cx} y={chipCy + 4} textAnchor="middle" fill="oklch(0.92 0.01 248)" fontSize="13" fontWeight="800">+</text>
                  )}
                  <text x={cx} y={CANAL_BOTTOM + 16} textAnchor="middle" fill="var(--canal-hero)" fontSize="10" fontFamily="ui-monospace, Menlo, monospace">
                    {formatCurrency(route.valueUsd, 0)}
                  </text>
                  <text
                    x={cx}
                    y={CANAL_BOTTOM + 30}
                    textAnchor="middle"
                    fill="var(--canal-caption)"
                    fontSize="9"
                    fontFamily="ui-monospace, Menlo, monospace"
                    className="exit-route-canal__gate-pct"
                  >
                    {formatPercent(route.sharePct, 1)}
                  </text>
                </g>
              );
            });
          })()}

          {/* Sea band (behind ripples, added in Task 6) */}
          <rect x="0" y="380" width={SCENE_WIDTH} height="100" fill="url(#exit-route-canal-sea)" />

          {/* Dam wall with a mid-tone cornice strip (masonry depth). */}
          <rect x={DAM_X - 2} y={CANAL_TOP - 4} width={DAM_WIDTH + 4} height="4" fill="var(--canal-wall-stone)" />
          <rect x={DAM_X} y={CANAL_TOP} width={DAM_WIDTH} height={CANAL_BOTTOM - CANAL_TOP} fill="var(--canal-dam)" />

          {/* Chain basins (delta) — trapezoidal pools splaying right from the dam face. */}
          {(() => {
            const heights = basinHeights(model.chainRoutes);
            let cursor = BASIN_AREA_TOP;
            return model.chainRoutes.map((route, i) => {
              const top = cursor;
              const h = heights[i];
              cursor = top + h + BASIN_GAP;
              const midY = top + h / 2;
              const basinPath = [
                `M ${BASIN_LEFT} ${top}`,
                `L ${BASIN_RIGHT} ${top + 4}`,
                `L ${BASIN_RIGHT} ${top + h - 4}`,
                `L ${BASIN_LEFT} ${top + h}`,
                "Z",
              ].join(" ");
              return (
                <g
                  key={`chain-${route.key}`}
                  data-testid={`chain-basin-${route.key}`}
                  aria-label={`${route.label} chain basin, ${formatCurrency(route.valueUsd, 0)}, ${formatPercent(route.sharePct, 1)} of DEX TVL`}
                >
                  <title>{`${route.label}: ${formatCurrency(route.valueUsd, 0)} chain basin (${formatPercent(route.sharePct, 1)})`}</title>
                  <path d={basinPath} fill={route.colorHex} fillOpacity="0.62" />
                  <line x1={BASIN_LEFT + 4} y1={top + 5} x2={BASIN_RIGHT - 4} y2={top + 5} stroke="var(--canal-accent)" strokeWidth="0.4" opacity="0.3" />
                  <text x={BASIN_RIGHT - 30} y={midY - 1} textAnchor="end" fill="var(--canal-hero)" fontSize="11" fontFamily="ui-monospace, Menlo, monospace">
                    {`${route.label} · ${formatCurrency(route.valueUsd, 0)}`}
                  </text>
                  <text x={BASIN_RIGHT - 30} y={midY + 11} textAnchor="end" fill="var(--canal-caption)" fontSize="9" fontFamily="ui-monospace, Menlo, monospace">
                    {formatPercent(route.sharePct, 1)}
                  </text>
                  <circle cx={BASIN_RIGHT - 12} cy={midY + 3} r="10" fill="oklch(0.06 0.012 248 / 0.9)" stroke={route.colorHex} strokeWidth="1" />
                  {route.logoPath ? (
                    <image href={route.logoPath} x={BASIN_RIGHT - 20} y={midY - 5} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text x={BASIN_RIGHT - 12} y={midY + 6} textAnchor="middle" fill="oklch(0.92 0.01 248)" fontSize="11" fontWeight="800">+</text>
                  )}
                </g>
              );
            });
          })()}

          {/* Canal group — carries the data-crowding-band attribute and the focal TVL numeric. */}
          <g
            data-testid="exit-canal"
            data-crowding-band={band}
            aria-label={`Aggregate exit canal; crowding ${band}`}
          >
            <text
              x="625"
              y="232"
              textAnchor="middle"
              fill="var(--canal-hero)"
              fontSize="48"
              fontWeight="800"
              letterSpacing="-1.5"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {formatCurrency(model.totalTvlUsd, 0)}
            </text>
            <text
              x="625"
              y="252"
              textAnchor="middle"
              fill="var(--canal-hero-kicker)"
              fontSize="10"
              fontWeight="700"
              letterSpacing="1.8"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              SECONDARY EXIT TVL · DEX DEPTH
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
            <ExitRouteCanalScene model={model} />
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
