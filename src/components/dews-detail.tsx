"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, ReferenceLine } from "recharts";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@shared/lib/classification";
import { THREAT_BAND_HEX, SIGNAL_CHART_COLORS } from "@/lib/chart-colors";
import type { ThreatBand } from "@shared/lib/classification";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { ChartAreaGradient, DateTooltip, MonoYAxis, TimeGrid, TimeXAxis, useSvgId } from "@/components/chart-primitives/axes";
import { formatChartDate } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { cn } from "@/lib/utils";
import { getDewsAmplifiers, getDewsSignalLabel } from "@/lib/dews-signal-utils";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { DewsBandStrip } from "@/components/dews-badge";

const SIGNAL_META: Record<string, { name: string; metricKey: string; metricLabel: string }> = {
  supply: { name: getDewsSignalLabel("supply"), metricKey: "delta1d", metricLabel: "1d change" },
  pool: { name: getDewsSignalLabel("pool"), metricKey: "balanceRatio", metricLabel: "balance ratio" },
  liq: { name: getDewsSignalLabel("liq"), metricKey: "scoreDelta7d", metricLabel: "7d score \u0394" },
  price: { name: getDewsSignalLabel("price"), metricKey: "confidence", metricLabel: "confidence" },
  diverg: { name: getDewsSignalLabel("diverg"), metricKey: "spreadBps", metricLabel: "spread (bps)" },
  black: { name: getDewsSignalLabel("black"), metricKey: "events24h", metricLabel: "24h events" },
  flow: { name: getDewsSignalLabel("flow"), metricKey: "burnSurge", metricLabel: "burn surge" },
  yield: { name: getDewsSignalLabel("yield"), metricKey: "warnings", metricLabel: "warnings" },
};

/** Snap a max value up to the next chart Y-axis ceiling (50 / 75 / 100) */
function snapDewsYMax(max: number): number {
  if (max <= 25) return 50;
  if (max <= 50) return 75;
  return 100;
}

/** Map a signal score to its severity color (per-signal, not composite band) */
function signalBarHex(value: number): string {
  if (value < 25) return THREAT_BAND_HEX.CALM;
  if (value < 50) return THREAT_BAND_HEX.WATCH;
  if (value < 75) return THREAT_BAND_HEX.ALERT;
  if (value < 90) return THREAT_BAND_HEX.WARNING;
  return THREAT_BAND_HEX.DANGER;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.min(value, 100)}%`, backgroundColor: signalBarHex(value) }}
      />
    </div>
  );
}

function formatMetric(key: string, val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (Array.isArray(val)) return `${val.length} active`;
  if (typeof val === "number") {
    if (key === "delta1d" || key === "delta7d" || key === "scoreDelta7d" || key === "tvlDelta7d") {
      return `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
    }
    if (key === "spreadBps" || key === "primaryDevBps" || key === "dexDevBps") {
      return `${val.toFixed(0)} bps`;
    }
    if (key === "burnSurge" || key === "burnToMintRatio") {
      return `${val.toFixed(1)}x`;
    }
    return String(val);
  }
  return String(val);
}

interface DEWSFiringSignal {
  value: number;
  available: boolean;
}

export function DEWSFiringList({ signals }: { signals: Record<string, DEWSFiringSignal> }) {
  const firing = Object.entries(signals)
    .filter(([, s]) => s.available && s.value > 0)
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 5);

  return (
    <div className="space-y-1">
      <h4 className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70">
        Signals firing
      </h4>
      {firing.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stress signals firing</p>
      ) : (
        firing.map(([key, s]) => (
          <div
            key={key}
            data-testid="dews-firing-signal"
            className="flex items-center justify-between text-xs"
          >
            <span className="text-foreground">{getDewsSignalLabel(key)}</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {Math.round(s.value)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

interface DEWSDetailProps {
  stablecoinId: string;
}

export function DEWSDetail({ stablecoinId }: DEWSDetailProps) {
  const dewsGradientId = useSvgId("dews");
  const { data, isLoading, error, refetch } = useStressSignalDetail(stablecoinId);
  const history = data?.history;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Include per-signal values in chart data for breakdown mode
  const chartData = useMemo(() => {
    if (!history?.length) return [];
    return history.map((h) => {
      const point: Record<string, unknown> = {
        ts: h.date * 1000,
        score: h.score,
        band: h.band,
      };
      for (const key of Object.keys(SIGNAL_META)) {
        const sig = h.signals?.[key];
        point[key] = sig?.available ? sig.value : 0;
      }
      return point;
    });
  }, [history]);

  // Dynamic Y-axis for composite view
  const chartYMax = useMemo(() => {
    if (!chartData.length) return 100;
    const max = Math.max(...chartData.map((d) => d.score as number));
    return snapDewsYMax(max);
  }, [chartData]);

  // Dynamic Y-axis for breakdown view (max of any individual signal)
  const signalYMax = useMemo(() => {
    if (!history?.length) return 100;
    let max = 0;
    for (const h of history) {
      for (const key of Object.keys(SIGNAL_META)) {
        const sig = h.signals?.[key];
        if (sig?.available && sig.value > max) max = sig.value;
      }
    }
    return snapDewsYMax(max);
  }, [history]);

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <DetailSectionTitle>
            <MethodologyLabel topic="dews">DEWS: Depeg Early Warning System</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return <QueryErrorNotice error={error} onRetry={() => void refetch()} />;
  }

  if (!data?.current) {
    return (
      <Card>
        <CardHeader>
          <DetailSectionTitle>
            <MethodologyLabel topic="dews">DEWS: Depeg Early Warning System</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No DEWS data available yet. Score will appear after the next computation cycle.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { score, band, signals } = data.current;
  const typedBand = band as ThreatBand;
  const bandColor = THREAT_BAND_COLORS[typedBand] ?? "";
  const bandHex = THREAT_BAND_HEX[typedBand] ?? THREAT_BAND_HEX.CALM;
  const availableCount = Object.values(signals).filter((s) => s.available).length;
  const amplifiers = getDewsAmplifiers(data.current);
  // 24h-ago score for the ghost notch on the band strip. `history` is
  // chronological (oldest first), so the entry preceding the latest is the
  // closest daily comparison point.
  const prevScore = history && history.length >= 2 ? history[history.length - 2].score : undefined;

  const sortedSignals = Object.entries(SIGNAL_META)
    .flatMap(([key, meta]) => {
      const signal = signals[key];
      if (!signal || !signal.available) return [];
      return [{ key, meta, signal }];
    })
    .sort((a, b) => b.signal.value - a.signal.value);

  const unavailableSignalNames = Object.entries(SIGNAL_META)
    .filter(([key]) => signals[key] && !signals[key].available)
    .map(([, meta]) => meta.name);

  return (
    <Card className="animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <DetailSectionTitle>
          <MethodologyLabel topic="dews">Depeg Early Warning</MethodologyLabel>
        </DetailSectionTitle>
        <ScoreBadgeWrapper topic="dews" variant="tooltip-only">
          <span className="flex items-center gap-2">
            <span className="text-2xl font-extrabold font-mono tabular-nums">{score}</span>
            <DewsBandStrip score={score} prevScore={prevScore} className="hidden sm:block" />
            <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${bandColor}`}>
              {THREAT_BAND_LABELS[typedBand]}
            </span>
          </span>
        </ScoreBadgeWrapper>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableCount < 4 && (
          <p className="text-xs text-muted-foreground">
            Limited data: only {availableCount} of 8 signals available. Score may be less reliable.
          </p>
        )}

        {amplifiers.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {amplifiers.map((amp) => (
              <span
                key={amp.key}
                className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
              >
                {amp.label} {amp.value.toFixed(2)}x
              </span>
            ))}
          </div>
        )}

        {/* Signal breakdown, sorted by descending score. Single column below xl, two columns at xl+. */}
        {(() => {
          const rowGrid =
            "grid grid-cols-[minmax(0,8.5rem)_1fr_auto_auto] items-center gap-x-2 sm:grid-cols-[minmax(0,11rem)_1fr_auto_auto] sm:gap-x-3";
          const renderHeader = () => (
            <div className={cn(rowGrid, "text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70")}>
              <span className="col-span-2">Signal</span>
              <span className="text-right">Score</span>
              <span className="w-16 text-right sm:w-20">Value</span>
            </div>
          );
          const renderRow = ({ key, meta, signal }: (typeof sortedSignals)[number]) => {
            const metricVal = signal[meta.metricKey];
            const isInactive = Math.round(signal.value) === 0;
            return (
              <div key={key} className={cn(rowGrid, "text-sm", isInactive && "opacity-50")}>
                <span className="truncate text-foreground" title={meta.name}>{meta.name}</span>
                <ProgressBar value={signal.value} />
                <span className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                  {Math.round(signal.value)}/100
                </span>
                <span
                  className="w-16 truncate text-right text-xs text-muted-foreground sm:w-20"
                  title={meta.metricLabel}
                >
                  {formatMetric(meta.metricKey, metricVal)}
                </span>
              </div>
            );
          };
          const half = Math.ceil(sortedSignals.length / 2);
          const leftSignals = sortedSignals.slice(0, half);
          const rightSignals = sortedSignals.slice(half);
          return (
            <>
              <div className="space-y-1.5 xl:hidden">
                {renderHeader()}
                {sortedSignals.map(renderRow)}
              </div>
              <div className="hidden xl:grid xl:grid-cols-2 xl:gap-x-6">
                <div className="space-y-1.5">
                  {renderHeader()}
                  {leftSignals.map(renderRow)}
                </div>
                <div className="space-y-1.5">
                  {renderHeader()}
                  {rightSignals.map(renderRow)}
                </div>
              </div>
            </>
          );
        })()}

        {unavailableSignalNames.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {unavailableSignalNames.join(", ")} — not applicable
          </p>
        )}

        {/* History chart */}
        {chartData.length > 1 && (
          <>
            <div ref={chartContainerRef} className="h-[140px]" role="figure" aria-label="DEWS score history">
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={chartData}
                  margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
                >
                  <defs>
                    <ChartAreaGradient id={dewsGradientId} color={bandHex} />
                  </defs>
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    tickFormatter={(ts: number) => formatChartDate(ts, "short")}
                  />
                  <MonoYAxis domain={[0, showBreakdown ? signalYMax : chartYMax]} width={30} />
                  {(showBreakdown ? signalYMax : chartYMax) >= 50 && (
                    <ReferenceLine y={25} stroke={THREAT_BAND_HEX.WATCH} strokeDasharray="4 4" strokeOpacity={0.25} />
                  )}
                  <DateTooltip
                    formatter={(val, name) => [
                      `${Math.round(val as number)}/100`,
                      showBreakdown ? (SIGNAL_META[name as string]?.name ?? name) : "DEWS",
                    ]}
                    {...(showBreakdown && {
                      itemStyle: { fontFamily: "var(--font-mono)", fontSize: "0.875rem" },
                    })}
                  />
                  {showBreakdown ? (
                    Object.keys(SIGNAL_META).map((key) => (
                      <Area
                        key={key}
                        type="monotone"
                        dataKey={key}
                        stroke={SIGNAL_CHART_COLORS[key]}
                        fill={SIGNAL_CHART_COLORS[key]}
                        fillOpacity={0.12}
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))
                  ) : (
                    <Area type="monotone" dataKey="score" stroke={bandHex} fill={`url(#${dewsGradientId})`} strokeWidth={2} />
                  )}
                </AreaChart>
              ) : (
                <div className="h-full w-full animate-pulse rounded bg-muted" />
              )}
            </div>

            {/* Breakdown legend */}
            {showBreakdown && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {Object.entries(SIGNAL_META).map(([key, meta]) => (
                  <div key={key} className="flex items-center gap-1">
                    <div className="h-2 w-2 rounded-full" style={{ backgroundColor: SIGNAL_CHART_COLORS[key] }} />
                    <span>{meta.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <ShowYourWorkPanel kind="dews" current={data.current} stablecoinId={stablecoinId} />

        <MethodologyCardActions
          topic="dews"
          showWorkToggle
          trailing={
            chartData.length > 1 ? (
              <button
                type="button"
                onClick={() => setShowBreakdown((v) => !v)}
                className="pharos-focus-ring min-h-11 rounded-sm py-2 text-xs text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground sm:min-h-0 sm:py-0"
              >
                {showBreakdown ? "Show composite" : "Show signal breakdown"}
              </button>
            ) : null
          }
        />
      </CardContent>
    </Card>
  );
}
