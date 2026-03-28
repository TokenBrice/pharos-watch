"use client";

import { useMemo } from "react";
import { Treemap, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { RISK_COLORS } from "@/lib/chart-colors";
import type { ReserveSlice, ReserveRisk } from "@shared/types";

interface ReserveTreemapProps {
  reserves: ReserveSlice[];
  isLive?: boolean;
}

const RISK_LABELS: Record<ReserveRisk, string> = {
  "very-low": "Very Low Risk",
  low: "Low Risk",
  medium: "Medium Risk",
  high: "High Risk",
  "very-high": "Very High Risk",
};

function TreemapCell({
  x,
  y,
  width,
  height,
  name,
  risk,
  pct,
  depth,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  risk: ReserveRisk;
  pct: number;
  depth?: number;
}) {
  // Recharts renders the synthetic root node (depth=0) via content too — skip it
  if (depth === 0) return <g />;

  const fill = RISK_COLORS[risk];
  const showLabel = width > 50 && height > 30;
  const showPct = showLabel && width > 40 && height > 40;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        fill={fill}
        opacity={0.6}
        stroke="var(--color-card)"
        strokeWidth={2}
      />
      {showLabel && (
        <text
          x={x + width / 2}
          y={y + height / 2 - (showPct ? 6 : 0)}
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={Math.min(12, width / 8)}
          fontWeight={600}
        >
          {name.length > width / 7 ? `${name.slice(0, Math.floor(width / 7))}…` : name}
        </text>
      )}
      {showLabel && showPct && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 10}
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={10}
          opacity={0.7}
          fontFamily="var(--font-mono, monospace)"
        >
          {pct}%
        </text>
      )}
    </g>
  );
}

function ReserveTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; pct: number; risk: ReserveRisk } }>;
}) {
  if (!payload?.[0]) return null;
  const { name, pct, risk } = payload[0].payload;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{name}</TooltipLabel>
      <TooltipRow color={RISK_COLORS[risk]} label={RISK_LABELS[risk]} value={`${pct}%`} />
    </PharosChartTooltip>
  );
}

export function ReserveTreemap({ reserves, isLive }: ReserveTreemapProps) {
  const data = useMemo(() => reserves.map((r) => ({ ...r, size: r.pct })), [reserves]);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={`${DETAIL_SECTION_TITLE_CLASS} flex items-center gap-2`}>
          Reserve Composition
          {isLive && (
            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              Live
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
          {(Object.entries(RISK_LABELS) as [ReserveRisk, string][]).map(([risk, label]) => (
            <div key={risk} className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: RISK_COLORS[risk], opacity: 0.6 }} />
              {label}
            </div>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div
          ref={chartContainerRef}
          className="h-48"
          role="figure"
          aria-label={`Reserve composition treemap: ${reserves.map((r) => `${r.name} ${r.pct}%`).join(", ")}`}
        >
          {isChartReady ? (
            <Treemap
              width={width}
              height={height}
              data={data}
              dataKey="size"
              nameKey="name"
              content={<TreemapCell x={0} y={0} width={0} height={0} name="" risk="low" pct={0} depth={1} />}
              isAnimationActive={false}
            >
              <Tooltip content={<ReserveTooltip />} />
            </Treemap>
          ) : (
            <ChartSkeleton className="h-full w-full" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
