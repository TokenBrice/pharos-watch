"use client";

import { useMemo } from "react";
import { Treemap, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReserveSlice, ReserveRisk } from "@shared/types";

interface ReserveTreemapProps {
  reserves: ReserveSlice[];
}

const RISK_COLORS: Record<ReserveRisk, string> = {
  "very-low": "#16a34a",
  low: "#22c55e",
  medium: "#f59e0b",
  high: "#f97316",
  "very-high": "#ef4444",
};

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
  if (!active || !payload?.[0]) return null;
  const { name, pct, risk } = payload[0].payload;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md text-sm">
      <p className="font-semibold">{name}</p>
      <div className="flex items-center gap-2 mt-1">
        <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: RISK_COLORS[risk] }} />
        <span className="font-mono tabular-nums">{pct}%</span>
        <span className="text-muted-foreground text-xs">({RISK_LABELS[risk]})</span>
      </div>
    </div>
  );
}

export function ReserveTreemap({ reserves }: ReserveTreemapProps) {
  const data = useMemo(
    () => reserves.map((r) => ({ ...r, size: r.pct })),
    [reserves],
  );

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Reserve Composition
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
          className="h-48"
          role="figure"
          aria-label={`Reserve composition treemap: ${reserves.map((r) => `${r.name} ${r.pct}%`).join(", ")}`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <Treemap
              data={data}
              dataKey="size"
              nameKey="name"
              content={<TreemapCell x={0} y={0} width={0} height={0} name="" risk="low" pct={0} depth={1} />}
              isAnimationActive={false}
            >
              <Tooltip content={<ReserveTooltip />} />
            </Treemap>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
