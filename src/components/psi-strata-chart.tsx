"use client";

import { useRef, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Customized,
} from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES, PSI_BAND_COLORS, CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { trackEvent } from "@/lib/analytics";
import { PSI_EVENTS, BAND_ZONES } from "@/components/psi-history-chart";

/* ─── Wavy Path Generator ──────────────────────────────────────── */

function wavyPath(
  xStart: number,
  xEnd: number,
  yTop: number,
  yBottom: number,
  topWave: boolean,
  bottomWave: boolean,
  seed: number,
): string {
  const steps = 80;
  const dx = (xEnd - xStart) / steps;
  const amp = 2.5;
  const freq = 0.08;

  const topPoints: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = xStart + i * dx;
    const wobble = topWave
      ? Math.sin(i * freq * 3 + seed) * amp +
        Math.sin(i * freq * 7 + seed * 2) * amp * 0.4
      : 0;
    topPoints.push(`${x},${yTop + wobble}`);
  }

  const bottomPoints: string[] = [];
  for (let i = steps; i >= 0; i--) {
    const x = xStart + i * dx;
    const wobble = bottomWave
      ? Math.sin(i * freq * 3 + seed + 2) * amp +
        Math.sin(i * freq * 7 + seed * 2 + 1) * amp * 0.4
      : 0;
    bottomPoints.push(`${x},${yBottom + wobble}`);
  }

  return `M ${topPoints[0]} L ${topPoints.join(" L ")} L ${bottomPoints.join(" L ")} Z`;
}

/* ─── StrataBackground (Customized renderer) ───────────────────── */

function StrataBackground(props: Record<string, unknown>) {
  const { yAxisMap, offset } = props as {
    yAxisMap?: Record<string, { scale: (v: number) => number }>;
    offset?: { left: number; top: number; width: number; height: number };
  };
  if (!yAxisMap || !offset) return null;
  const yAxis = Object.values(yAxisMap)[0];
  if (!yAxis?.scale) return null;

  const xStart = offset.left;
  const xEnd = offset.left + offset.width;

  return (
    <g>
      {BAND_ZONES.map((zone, bandIndex) => {
        const yTop = yAxis.scale(zone.y2);
        const yBottom = yAxis.scale(zone.y1);
        const seed = bandIndex * 17;
        // Don't wave the very top edge (y2=100) or very bottom edge (y1=0)
        const topWave = zone.y2 < 100;
        const bottomWave = zone.y1 > 0;
        const d = wavyPath(xStart, xEnd, yTop, yBottom, topWave, bottomWave, seed);
        return (
          <path
            key={zone.label}
            d={d}
            fill={zone.color}
            fillOpacity={0.12}
            stroke="none"
          />
        );
      })}
    </g>
  );
}

/* ─── FaultLines (Customized renderer) ─────────────────────────── */

function FaultLines(props: Record<string, unknown>) {
  const { xAxisMap, offset } = props as {
    xAxisMap?: Record<string, { scale: (v: number) => number }>;
    offset?: { left: number; top: number; width: number; height: number };
  };
  if (!xAxisMap || !offset) return null;
  const xAxis = Object.values(xAxisMap)[0];
  if (!xAxis?.scale) return null;

  const yTop = offset.top;
  const yBottom = offset.top + offset.height;
  const xLeft = offset.left;
  const xRight = offset.left + offset.width;

  return (
    <g>
      {PSI_EVENTS.map((evt) => {
        const x = xAxis.scale(evt.date);
        // Skip events outside visible range
        if (x < xLeft || x > xRight) return null;

        const faultOffset = 4;
        const y30 = yTop + (yBottom - yTop) * 0.3;
        const y70 = yTop + (yBottom - yTop) * 0.7;
        const tickLen = 6;

        return (
          <g key={evt.label}>
            {/* Diagonal fault line with displacement */}
            <line
              x1={x - faultOffset}
              y1={yTop}
              x2={x + faultOffset}
              y2={yBottom}
              stroke={CHART_SLATE}
              strokeOpacity={0.25}
              strokeWidth={1.5}
              strokeDasharray="6 3"
            />
            {/* Displacement tick at 30% */}
            <line
              x1={x - faultOffset * 0.4 - tickLen}
              y1={y30}
              x2={x - faultOffset * 0.4 + tickLen}
              y2={y30}
              stroke={CHART_SLATE}
              strokeOpacity={0.2}
              strokeWidth={1}
            />
            {/* Displacement tick at 70% */}
            <line
              x1={x + faultOffset * 0.4 - tickLen}
              y1={y70}
              x2={x + faultOffset * 0.4 + tickLen}
              y2={y70}
              stroke={CHART_SLATE}
              strokeOpacity={0.2}
              strokeWidth={1}
            />
          </g>
        );
      })}
    </g>
  );
}

/* ─── PsiStrataChart ───────────────────────────────────────────── */

export function PsiStrataChart({ data }: { data: { ts: number; score: number }[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-psi-strata");
  }, []);
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Geological Record</CardTitle>
        <CardAction className="flex items-center gap-2">
          <TimeRangeButtons
            options={options}
            value={range}
            onChange={(r) => {
              trackEvent("time_range_changed", {
                page: "stability-index-alt-strata",
                range: r,
              });
              setRange(r);
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handlePngExport}
            title="Save chart as PNG"
          >
            <Camera className="h-4 w-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div ref={chartRef}>
            <div className="flex flex-wrap gap-4 mb-4">
              {BAND_ZONES.map((zone) => (
                <div
                  key={zone.label}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: zone.color }}
                  />
                  {zone.label}
                </div>
              ))}
            </div>
            <div
              className="psi-chart h-[250px] sm:h-[350px]"
              role="figure"
              aria-label={`PSI geological record chart showing ${filteredData.length} data points`}
            >
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                minHeight={0}
              >
                <AreaChart
                  data={filteredData}
                  margin={{ top: 30, right: 5, bottom: 20, left: 5 }}
                >
                  <defs>
                    <linearGradient
                      id="psiStrataGradient"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={CHART_BLUE}
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="95%"
                        stopColor={CHART_BLUE}
                        stopOpacity={0.05}
                      />
                    </linearGradient>
                  </defs>
                  <Customized component={StrataBackground} />
                  <Customized component={FaultLines} />
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                  />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tick={{
                      fontSize: 12,
                      fontFamily: "var(--font-mono, monospace)",
                      fill: "var(--color-muted-foreground)",
                    }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={72}
                    tickFormatter={(ts: number) =>
                      new Date(ts).toLocaleDateString("en-US", {
                        month: "short",
                        year: "2-digit",
                      })
                    }
                  />
                  <YAxis
                    tick={{
                      fontSize: 12,
                      fontFamily: "var(--font-mono, monospace)",
                      fill: "var(--color-muted-foreground)",
                    }}
                    tickLine={false}
                    axisLine={false}
                    domain={[0, 100]}
                  />
                  <Tooltip
                    formatter={(value) => [Number(value).toFixed(1), "Score"]}
                    labelFormatter={(label) =>
                      new Date(Number(label)).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    }
                    {...RECHARTS_TOOLTIP_STYLES}
                  />
                  <Area
                    type="monotone"
                    dataKey="score"
                    stroke={CHART_BLUE}
                    fill="url(#psiStrataGradient)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No geological record available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
