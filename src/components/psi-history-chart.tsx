"use client";

import { useMemo, useRef, useCallback } from "react";
import { AreaChart, Area, ReferenceArea, ReferenceLine } from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { BAND_ZONES, PSI_EVENTS, buildVisiblePsiChartEvents } from "@/lib/psi-history-events";
import { trackEvent } from "@/lib/analytics";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { buildPsiChartData } from "@shared/lib/psi-view-model";
import { formatRangeTickDate } from "@/lib/chart-time-range";

/* ─── Constants ─────────────────────────────────────────────────── */

const PSI_EVENT_LABEL_CLASS =
  "[fill:var(--text-secondary)] [paint-order:stroke] [stroke:var(--surface-overlay)] [stroke-width:4px] font-medium";

/* ─── ScoreChart (reusable, data passed in) ────────────────────── */

export function ScoreChart({
  data,
  excludeEvents,
  showHeader = true,
}: {
  data: { ts: number; score: number }[];
  excludeEvents?: string[];
  showHeader?: boolean;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-psi-history");
  }, []);
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const isMobile = useIsMobile();
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } = useChartShell<HTMLDivElement>();
  const formatTimestamp = useCallback((ts: number) => formatRangeTickDate(ts, range), [range]);

  /* Hide overlapping event labels when zoomed into a tight range */
  const visibleEvents = useMemo(() => {
    const events = excludeEvents ? PSI_EVENTS.filter((e) => !excludeEvents.includes(e.label)) : PSI_EVENTS;
    const min = filteredData[0]?.ts;
    const max = filteredData[filteredData.length - 1]?.ts;
    return buildVisiblePsiChartEvents(events, min, max);
  }, [filteredData, excludeEvents]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      {showHeader && (
        <CardHeader>
          <CardTitle as="h2" className="min-w-0">
            Pharos Stability Index History
          </CardTitle>
          <CardAction className="flex min-w-0 items-center gap-2">
            <TimeRangeButtons
              options={options}
              value={range}
              onChange={(r) => {
                trackEvent("time_range_changed", { page: "stability-index-score", range: r });
                setRange(r);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={handlePngExport}
              title="Save chart as PNG"
              aria-label="Save chart as PNG"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </CardAction>
        </CardHeader>
      )}
      <CardContent className={showHeader ? undefined : "px-4 pt-4 pb-2"}>
        {(() => {
          const chartHeight = showHeader ? "h-[250px] sm:h-[350px]" : "h-[250px] sm:h-[336px]";
          return filteredData.length > 0 ? (
          <div ref={chartRef}>
            <div className={showHeader ? "mb-4 flex flex-wrap gap-4" : "mb-3 flex flex-wrap gap-4"}>
              {BAND_ZONES.map((zone) => (
                <div key={zone.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: zone.color }} />
                  {zone.label}
                </div>
              ))}
            </div>
            <div
              ref={chartContainerRef}
              className={`psi-chart ${chartHeight}`}
              role="figure"
              aria-label={`PSI score history chart showing ${filteredData.length} data points`}
            >
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={filteredData}
                  margin={{ top: showHeader ? 30 : 26, right: 5, bottom: showHeader ? 20 : 8, left: 5 }}
                >
                  <defs>
                    <linearGradient id="psiScoreGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  {BAND_ZONES.map((zone) => (
                    <ReferenceArea
                      key={zone.label}
                      y1={zone.y1}
                      y2={zone.y2}
                      fill={zone.color}
                      ifOverflow="extendDomain"
                    />
                  ))}
                  {visibleEvents.map((evt) =>
                    evt.dateEnd ? (
                      <ReferenceArea
                        key={evt.label}
                        x1={evt.date}
                        x2={evt.dateEnd}
                        fill={CHART_SLATE}
                        fillOpacity={0.1}
                        stroke={CHART_SLATE}
                        strokeOpacity={0.3}
                        strokeDasharray="4 4"
                        label={
                          isMobile || evt.hideLabel
                            ? undefined
                            : {
                                value: evt.label,
                                position: evt.position === "top" ? "insideTop" : "insideBottomLeft",
                                fontSize: 11,
                                className: PSI_EVENT_LABEL_CLASS,
                                ...(evt.position === "top" ? { dy: -20 } : {}),
                              }
                        }
                      />
                    ) : (
                      <ReferenceLine
                        key={evt.label}
                        x={evt.date}
                        stroke={CHART_SLATE}
                        strokeDasharray="4 4"
                        label={
                          isMobile || evt.hideLabel
                            ? undefined
                            : {
                                value: evt.label,
                                position: evt.position,
                                fontSize: 11,
                                className: PSI_EVENT_LABEL_CLASS,
                              }
                        }
                      />
                    ),
                  )}
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    minTickGap={72}
                    tickFormatter={formatTimestamp}
                  />
                  <MonoYAxis domain={[0, 100]} />
                  <DateTooltip
                    formatter={(value) => [Number(value).toFixed(1), "Score"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="score"
                    stroke={CHART_BLUE}
                    fill="url(#psiScoreGradient)"
                    strokeWidth={2}
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                </AreaChart>
              ) : (
                <ChartSkeleton className="h-full w-full" />
              )}
            </div>
          </div>
        ) : (
          <div className={`flex ${chartHeight} flex-col items-center justify-center text-muted-foreground`}>
            <p>No score history available</p>
            <p className="mt-1 text-xs text-muted-foreground/70">Score history builds over time as data is collected.</p>
          </div>
        );
        })()}
      </CardContent>
    </Card>
  );
}

/* ─── Self-contained wrapper (fetches its own data) ────────────── */

export function PsiHistoryChart({
  excludeEvents,
  showHeader = true,
}: {
  excludeEvents?: string[];
  showHeader?: boolean;
} = {}) {
  const { data, isLoading } = useStabilityIndexDetail();
  const history = data?.history;
  const current = data?.current;

  const chartData = useMemo(() => {
    return buildPsiChartData(history, current);
  }, [current, history]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Pharos Stability Index History</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return <ScoreChart data={chartData} excludeEvents={excludeEvents} showHeader={showHeader} />;
}
