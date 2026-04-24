"use client";

import { useCallback, useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ScoreChart } from "@/components/psi-history-chart";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { trackEvent } from "@/lib/analytics";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { formatRangeTickDate } from "@/lib/chart-time-range";
import { MethodologyLabel } from "@/components/methodology-hint";
import { formatScore } from "@shared/lib/format";
import {
  buildPsiChartData,
  getDisplayedPsi,
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
  StabilityIndexHero,
  StabilityIndexLoadingState,
  STABILITY_COMPONENT_COLORS,
  STABILITY_COMPONENT_DETAIL,
  type StabilityComponentScores,
} from "./presentational";
import { PsiBeamDimmers } from "./psi-beam-dimmers";

type ComponentChartPoint = { ts: number } & StabilityComponentScores;

function ComponentChart({ data }: { data: ComponentChartPoint[] }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const formatTimestamp = useCallback((ts: number) => formatRangeTickDate(ts, range), [range]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle as="h2" className="pharos-kicker">Component Breakdown</CardTitle>
        <TimeRangeButtons
          options={options}
          value={range}
          onChange={(nextRange) => {
            trackEvent("time_range_changed", { page: "stability-index-components", range: nextRange });
            setRange(nextRange);
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-4 mb-4">
          {STABILITY_COMPONENT_DETAIL.map((component) => (
            <div key={component.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: component.color }} />
              <MethodologyLabel topic={component.topic}>{component.label}</MethodologyLabel>
            </div>
          ))}
        </div>
        {filteredData.length > 0 ? (
          <div
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`PSI component breakdown chart showing ${filteredData.length} data points`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="psiSeverityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={STABILITY_COMPONENT_COLORS.severity} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={STABILITY_COMPONENT_COLORS.severity} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiBreadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={STABILITY_COMPONENT_COLORS.breadth} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={STABILITY_COMPONENT_COLORS.breadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiStressBreadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={STABILITY_COMPONENT_COLORS.stressBreadth} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={STABILITY_COMPONENT_COLORS.stressBreadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiTrendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={STABILITY_COMPONENT_COLORS.trend} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={STABILITY_COMPONENT_COLORS.trend} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <TimeGrid />
                <TimeXAxis dataKey="ts" minTickGap={72} tickFormatter={formatTimestamp} />
                <MonoYAxis />
                <DateTooltip
                  formatter={(value, name) => [formatScore(Number(value)), String(name)]}
                />
                <Area
                  type="monotone"
                  dataKey="severity"
                  name="Severity"
                  stackId="penalties"
                  stroke={STABILITY_COMPONENT_COLORS.severity}
                  fill="url(#psiSeverityGrad)"
                  strokeWidth={1.5}
                  onAnimationEnd={handleAnimationEnd}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="breadth"
                  name="Breadth"
                  stackId="penalties"
                  stroke={STABILITY_COMPONENT_COLORS.breadth}
                  fill="url(#psiBreadthGrad)"
                  strokeWidth={1.5}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="stressBreadth"
                  name="Stress Breadth"
                  stackId="penalties"
                  stroke={STABILITY_COMPONENT_COLORS.stressBreadth}
                  fill="url(#psiStressBreadthGrad)"
                  strokeWidth={1.5}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="trend"
                  name="Trend"
                  stroke={STABILITY_COMPONENT_COLORS.trend}
                  fill="none"
                  strokeWidth={2}
                  {...animProps}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
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

  const heroComponents = useMemo<StabilityComponentScores>(() => ({
    severity: current?.components.severity ?? 0,
    breadth: current?.components.breadth ?? 0,
    stressBreadth: current?.components.stressBreadth ?? 0,
    trend: current?.components.trend ?? 0,
  }), [current?.components]);

  const displayPsi = useMemo(() => (current ? getDisplayedPsi(current) : null), [current]);

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

      <StabilityIndexHero
        band={displayPsi.band}
        score={displayPsi.score}
        delta={delta}
        daysInBand={daysInBand}
        components={heroComponents}
        historyStats={historyStats}
      />

      <PsiBeamDimmers lanes={beamDimmerLanes} />

      <ScoreChart data={chartData} />

      <div className="border-t border-border/40 pt-2" />

      <PsiEventTimelineCard rows={eventTimelineRows} />

      {current.contributors && current.contributors.length > 0 && (
        <PsiContributorsTableCard rows={contributorRows} logos={logos} />
      )}

      <ComponentChart data={componentData} />

      <PsiMethodologyCard methodology={methodology} />
    </div>
  );
}
