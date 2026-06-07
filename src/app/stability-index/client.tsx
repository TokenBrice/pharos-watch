"use client";

import { useCallback, useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { DateTooltip, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ScoreChart } from "@/components/psi-history-chart";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { trackEvent } from "@/lib/analytics";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { CHART_RED } from "@/lib/chart-colors";
import { formatRangeTickDate } from "@/lib/chart-time-range";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { formatScore } from "@shared/lib/format";
import {
  buildPsiChartData,
  getDisplayedPsi,
  getDisplayedPsiBasis,
  getPsiBandStreak,
  getPsiCompletedDayPoint,
} from "@shared/lib/psi-view-model";
import {
  buildPsiComponentData,
  buildPsiBeamDimmers,
  buildPsiContributorRows,
  buildPsiEventTimelineRows,
  buildPsiHistoryStats,
} from "./view-model";
import {
  PsiContributorsTableCard,
  PsiEventTimelineCard,
  PsiMethodologyCard,
  StabilityIndexEmptyState,
  StabilityIndexLoadingState,
  StabilityIndexPanel,
  STABILITY_COMPONENT_DETAIL,
} from "./presentational";

type ComponentChartPoint = { ts: number; severity: number; breadth: number; stressBreadth: number; trend: number };

// Small-multiples companion to the hero's Beam Dimmers: one mini area chart per
// component, sharing the dimmer color language so the snapshot and the trend
// read as the same four signals. Panels scale independently — a shared y-axis
// would flatten Stress Breadth and Trend against Severity's much larger range.
function ComponentTrends({ data }: { data: ComponentChartPoint[] }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const formatTimestamp = useCallback((ts: number) => formatRangeTickDate(ts, range), [range]);
  const latest = filteredData[filteredData.length - 1];

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">Beam Dimmers Over Time</CardTitle>
        <CardDescription className="text-[11px] leading-snug">
          The four dimmers tracked across the window. Each panel scales independently — read the shape, not the height.
        </CardDescription>
        <CardAction>
          <TimeRangeButtons
            options={options}
            value={range}
            onChange={(nextRange) => {
              trackEvent("time_range_changed", { page: "stability-index-components", range: nextRange });
              setRange(nextRange);
            }}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {STABILITY_COMPONENT_DETAIL.map((component, index) => {
              const value = latest?.[component.key] ?? 0;
              const isTrend = component.key === "trend";
              const color = isTrend && value < 0 ? CHART_RED : component.color;
              const gradientId = `psi-dimmer-grad-${component.key}`;
              const signPrefix = isTrend ? (value >= 0 ? "+" : "−") : "−";
              return (
                <div key={component.key} className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <MethodologyLabel topic={component.topic}>{component.label}</MethodologyLabel>
                    <span className="font-mono text-sm font-bold tabular-nums" style={{ color }}>
                      {signPrefix}
                      {formatScore(Math.abs(value))}
                    </span>
                  </div>
                  <div
                    className="mt-2 h-24 sm:h-28"
                    role="figure"
                    aria-label={`${component.label} across ${filteredData.length} samples`}
                  >
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                      <AreaChart data={filteredData} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
                        <defs>
                          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={color} stopOpacity={0.04} />
                          </linearGradient>
                        </defs>
                        <TimeGrid />
                        <TimeXAxis dataKey="ts" minTickGap={56} tickFormatter={formatTimestamp} />
                        <DateTooltip formatter={(v) => [formatScore(Number(v)), component.label]} />
                        <Area
                          type="monotone"
                          dataKey={component.key}
                          name={component.label}
                          stroke={color}
                          fill={`url(#${gradientId})`}
                          strokeWidth={1.5}
                          {...(index === 0 ? { onAnimationEnd: handleAnimationEnd } : {})}
                          {...animProps}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-[200px] items-center justify-center text-muted-foreground">
            No component data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StabilityIndexClient() {
  const { data, isLoading, isError, error, dataUpdatedAt, refetch, meta } = useStabilityIndexDetail();
  const { data: logos } = useLogos();
  const history = data?.history;
  const current = data?.current ?? null;
  const methodology = data?.methodology ?? null;

  const daysInBand = useMemo(() => {
    if (!current || !history?.length) return 0;
    return getPsiBandStreak(history, current.computedAt, getDisplayedPsi(current).band);
  }, [current, history]);

  const chartData = useMemo(() => buildPsiChartData(history ?? [], current), [current, history]);

  const componentData = useMemo(() => buildPsiComponentData(history ?? [], current), [current, history]);

  const beamDimmerLanes = useMemo(() => buildPsiBeamDimmers(componentData), [componentData]);

  const historyStats = useMemo(() => buildPsiHistoryStats(history ?? []), [history]);

  const eventTimelineRows = useMemo(() => buildPsiEventTimelineRows(chartData), [chartData]);

  const contributorRows = useMemo(
    () => buildPsiContributorRows(current?.contributors ?? [], current?.totalMcapUsd ?? 0),
    [current?.contributors, current?.totalMcapUsd],
  );

  const displayPsi = useMemo(() => (current ? getDisplayedPsi(current) : null), [current]);
  const displayBasis = useMemo(() => (current ? getDisplayedPsiBasis(current) : "raw instant"), [current]);

  const delta = useMemo(() => {
    if (!current || !displayPsi) return null;
    const yesterday = getPsiCompletedDayPoint(history ?? [], current.computedAt, 1);
    return yesterday ? Math.round((displayPsi.score - yesterday.score) * 10) / 10 : null;
  }, [current, displayPsi, history]);

  if (isLoading) {
    return <StabilityIndexLoadingState />;
  }

  if (isError || (!isLoading && !current)) {
    const uiError = error ?? new Error("Stability Index data is temporarily unavailable.");
    return (
      <QueryErrorNotice
        error={uiError}
        hasData={false}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!current || !displayPsi || !methodology) {
    return <StabilityIndexEmptyState />;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <StaleDataBanner
        queries={[{ preset: "stabilityIndex", dataUpdatedAt, error, hasData: !!current, meta }]}
      />

      <StabilityIndexPanel
        band={displayPsi.band}
        score={displayPsi.score}
        scoreBasis={displayBasis}
        delta={delta}
        daysInBand={daysInBand}
        historyStats={historyStats}
        lanes={beamDimmerLanes}
      />

      <ShowYourWorkPanel kind="psi" current={current} />

      {current.contributors && current.contributors.length > 0 && (
        <PsiContributorsTableCard rows={contributorRows} logos={logos} />
      )}

      <div className="border-t border-border/40 pt-2" />

      <div className="space-y-3">
        <ScoreChart data={chartData} />
        <ComponentTrends data={componentData} />
      </div>

      <PsiEventTimelineCard rows={eventTimelineRows} />

      <PsiMethodologyCard methodology={methodology} />
    </div>
  );
}
