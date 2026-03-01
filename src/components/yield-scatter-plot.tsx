"use client";

import { useMemo, useCallback } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { RECHARTS_TOOLTIP_STYLES, CHART_HEIGHT } from "@/lib/chart-colors";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@/lib/classification";
import type { YieldRanking, YieldType } from "@/lib/types";

interface ScatterDataPoint {
  x: number;          // safety score
  y: number;          // APY 30d
  id: string;
  name: string;
  symbol: string;
  yieldType: YieldType;
  safetyGrade: string | null;
  pharosYieldScore: number | null;
  yieldSource: string;
  tvl: number | null;
}

interface YieldScatterPlotProps {
  rankings: YieldRanking[];
  riskFreeRate: number;
  onDotClick: (id: string) => void;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterDataPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        ...RECHARTS_TOOLTIP_STYLES.contentStyle,
        padding: "8px 12px",
        fontSize: "12px",
      }}
    >
      <p className="font-semibold text-foreground mb-1">{d.name} ({d.symbol})</p>
      <p className="text-muted-foreground">APY: <span className="font-mono">{d.y.toFixed(2)}%</span></p>
      <p className="text-muted-foreground">Safety: <span className="font-mono">{d.safetyGrade ?? "N/A"}</span> ({d.x}/100)</p>
      <p className="text-muted-foreground">PYS: <span className="font-mono">{d.pharosYieldScore !== null ? d.pharosYieldScore.toFixed(1) : "N/A"}</span></p>
      <p className="text-muted-foreground">Source: {d.yieldSource}</p>
    </div>
  );
}

export function YieldScatterPlot({ rankings, riskFreeRate, onDotClick }: YieldScatterPlotProps) {
  const data = useMemo((): ScatterDataPoint[] => {
    return rankings
      .filter((r) => r.safetyScore !== null)
      .map((r) => ({
        x: r.safetyScore!,
        y: r.apy30d,
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        yieldType: r.yieldType,
        safetyGrade: r.safetyGrade,
        pharosYieldScore: r.pharosYieldScore,
        yieldSource: r.yieldSource,
        tvl: r.sourceTvlUsd,
      }));
  }, [rankings]);

  const maxApy = useMemo(() => {
    if (data.length === 0) return 20;
    return Math.max(20, Math.ceil(Math.max(...data.map((d) => d.y)) * 1.1));
  }, [data]);

  const handleClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => {
      if (entry?.id) onDotClick(entry.id);
    },
    [onDotClick],
  );

  // Legend entries: only yield types present in the data
  const legendTypes = useMemo(() => {
    const types = new Set(data.map((d) => d.yieldType));
    return Array.from(types).sort();
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] text-sm text-muted-foreground">
        No scatter data available (safety scores required)
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={CHART_HEIGHT}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
            {/* Quadrant shading */}
            <ReferenceArea
              x1={60} x2={100} y1={riskFreeRate} y2={maxApy}
              fill="#10b981" fillOpacity={0.05}
              label={{ value: "Sweet Spot", position: "insideTopRight", fill: "#10b981", fontSize: 11, opacity: 0.7 }}
            />
            <ReferenceArea
              x1={0} x2={60} y1={riskFreeRate} y2={maxApy}
              fill="#ef4444" fillOpacity={0.05}
              label={{ value: "Danger Zone", position: "insideTopLeft", fill: "#ef4444", fontSize: 11, opacity: 0.7 }}
            />
            <ReferenceArea
              x1={60} x2={100} y1={0} y2={riskFreeRate}
              fill="#3b82f6" fillOpacity={0.05}
              label={{ value: "Play It Safe", position: "insideBottomRight", fill: "#3b82f6", fontSize: 11, opacity: 0.7 }}
            />
            <ReferenceArea
              x1={0} x2={60} y1={0} y2={riskFreeRate}
              fill="#94a3b8" fillOpacity={0.05}
              label={{ value: "Why Bother?", position: "insideBottomLeft", fill: "#94a3b8", fontSize: 11, opacity: 0.7 }}
            />

            {/* Risk-free rate reference line */}
            <ReferenceLine
              y={riskFreeRate}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              label={{ value: `T-Bill ${riskFreeRate.toFixed(2)}%`, position: "right", fill: "#94a3b8", fontSize: 11 }}
            />

            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 100]}
              name="Safety Score"
              label={{ value: "Safety Score", position: "insideBottom", offset: -10, fill: "var(--color-muted-foreground)", fontSize: 12 }}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, maxApy]}
              name="APY (%)"
              label={{ value: "APY %", angle: -90, position: "insideLeft", offset: -5, fill: "var(--color-muted-foreground)", fontSize: 12 }}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              tickFormatter={(v: number) => v.toFixed(0)}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              width={40}
            />

            <Tooltip content={<CustomTooltip />} cursor={false} />

            <Scatter
              data={data}
              onClick={handleClick}
              cursor="pointer"
            >
              {data.map((entry) => (
                <Cell
                  key={entry.id}
                  fill={YIELD_TYPE_STYLES[entry.yieldType]?.hex ?? "#94a3b8"}
                  fillOpacity={0.8}
                  r={6}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        {legendTypes.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: YIELD_TYPE_STYLES[type]?.hex ?? "#94a3b8" }}
            />
            <span>{YIELD_TYPE_LABELS[type] ?? type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
