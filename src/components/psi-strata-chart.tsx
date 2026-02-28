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
  usePlotArea,
  useXAxisDomain,
} from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
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

/* ─── StrataBackground (hooks-based) ───────────────────────────── */

/** Map a Y data value (0–100) to SVG pixel Y (inverted: 100→top, 0→bottom). */
function yScale(value: number, plotY: number, plotH: number): number {
  return plotY + plotH * (1 - value / 100);
}

function StrataBackground() {
  const plotArea = usePlotArea();
  if (!plotArea) return null;

  const xStart = plotArea.x;
  const xEnd = plotArea.x + plotArea.width;

  return (
    <g className="strata-bands">
      {BAND_ZONES.map((zone, i) => {
        const yTop = yScale(zone.y2, plotArea.y, plotArea.height);
        const yBottom = yScale(zone.y1, plotArea.y, plotArea.height);
        const isTopEdge = i === 0;
        const isBottomEdge = i === BAND_ZONES.length - 1;

        return (
          <path
            key={zone.label}
            d={wavyPath(
              xStart, xEnd,
              yTop, yBottom,
              !isTopEdge,
              !isBottomEdge,
              i * 17,
            )}
            fill={zone.color}
            fillOpacity={0.12}
            stroke="none"
          />
        );
      })}
    </g>
  );
}

/* ─── FaultLines (hooks-based) ──────────────────────────────────── */

function FaultLines() {
  const plotArea = usePlotArea();
  const xDomain = useXAxisDomain();
  if (!plotArea || !xDomain || xDomain.length < 2) return null;

  const domainMin = Number(xDomain[0]);
  const domainMax = Number(xDomain[xDomain.length - 1]);
  if (domainMax <= domainMin) return null;

  const yTop = plotArea.y;
  const yBottom = plotArea.y + plotArea.height;

  return (
    <g className="fault-lines">
      {PSI_EVENTS.map((evt) => {
        const t = (evt.date - domainMin) / (domainMax - domainMin);
        const x = plotArea.x + t * plotArea.width;
        if (x < plotArea.x || x > plotArea.x + plotArea.width) return null;

        const faultOffset = 4;
        const y30 = yTop + (yBottom - yTop) * 0.3;
        const y70 = yTop + (yBottom - yTop) * 0.7;

        return (
          <g key={evt.label}>
            <line
              x1={x - faultOffset}
              y1={yTop}
              x2={x + faultOffset}
              y2={yBottom}
              stroke={CHART_SLATE}
              strokeWidth={1.5}
              strokeOpacity={0.25}
              strokeDasharray="6 3"
            />
            <line
              x1={x - faultOffset - 3}
              y1={y30}
              x2={x - faultOffset + 3}
              y2={y30}
              stroke={CHART_SLATE}
              strokeWidth={1}
              strokeOpacity={0.2}
            />
            <line
              x1={x + faultOffset - 3}
              y1={y70}
              x2={x + faultOffset + 3}
              y2={y70}
              stroke={CHART_SLATE}
              strokeWidth={1}
              strokeOpacity={0.2}
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
                  <StrataBackground />
                  <FaultLines />
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
