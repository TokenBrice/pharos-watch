"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, ReferenceLine } from "recharts";
import { Table2 } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { THREAT_BAND_LABELS, THREAT_BAND_STYLES } from "@shared/lib/classification";
import { CHART_PALETTE, THREAT_BAND_HEX, SIGNAL_CHART_COLORS } from "@/lib/chart-colors";

/* Figma coin template: the DEWS history chart renders in the frost/teal
 * chart-primary hue regardless of the current threat band. */
const DEWS_CHART_HEX = CHART_PALETTE[0];
import type { ThreatBand } from "@shared/lib/classification";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  ChartAreaGradient,
  DateTooltip,
  MonoYAxis,
  TimeGrid,
  TimeXAxis,
  useSvgId,
} from "@/components/chart-primitives/axes";
import { formatChartDate } from "@shared/lib/format";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { cn } from "@/lib/utils";
import { getDewsAmplifiers, getDewsSignalLabel } from "@/lib/dews-signal-utils";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";

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

/* Only `available` signals reach a bar at all (unavailable ones are named in the
 * "not applicable" line instead), so every value here is a real reading. A
 * measured zero therefore keeps a visible cap at the origin rather than an
 * empty track, which would read as a bar that failed to render. */
function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-3 w-full rounded-[3px] border border-border/50 bg-muted/45">
      <div
        className="h-full rounded-[3px] transition-all"
        style={{ width: `${Math.min(value, 100)}%`, minWidth: "3px", backgroundColor: signalBarHex(value) }}
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
      <h4 className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70">Signals firing</h4>
      {firing.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stress signals firing</p>
      ) : (
        firing.map(([key, s]) => (
          <div key={key} data-testid="dews-firing-signal" className="flex items-center justify-between text-xs">
            <span className="text-foreground">{getDewsSignalLabel(key)}</span>
            <span className="font-mono tabular-nums text-muted-foreground">{Math.round(s.value)}</span>
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
  const bandColor = THREAT_BAND_STYLES[typedBand]?.cls ?? "";
  const availableCount = Object.values(signals).filter((s) => s.available).length;
  const amplifiers = getDewsAmplifiers(data.current);
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
    <Card className="pharos-card-shell animate-in gap-0 overflow-hidden py-0 fade-in duration-300">
      {/* Figma coin template: title row with the Composite/Signal-Breakdown
          segmented toggle at the right; the big composite score + band chip
          lead beneath the title. */}
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5">
        <div className="min-w-0 space-y-4">
          <DetailSectionTitle className="text-sm font-semibold tracking-normal text-muted-foreground">
            Depeg Early Warning
          </DetailSectionTitle>
          <ScoreBadgeWrapper topic="dews" variant="tooltip-only">
            <span className="flex items-center gap-2.5">
              <span className="pharos-numeric text-3xl font-extrabold leading-none tabular-nums">{score}</span>
              <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${bandColor}`}>
                {THREAT_BAND_LABELS[typedBand]}
              </span>
            </span>
          </ScoreBadgeWrapper>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {chartData.length > 1 ? (
            <div
              className="inline-flex items-center rounded-md border border-border/50 bg-muted/35 p-0.5"
              role="group"
              aria-label="DEWS chart mode"
            >
              <button
                type="button"
                aria-pressed={!showBreakdown}
                onClick={() => setShowBreakdown(false)}
                className={cn(
                  "pharos-focus-ring min-h-11 rounded-[4px] px-3 py-2 text-[11px] font-medium leading-none transition-colors md:min-h-0 md:px-2 md:py-1",
                  !showBreakdown ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Composite
              </button>
              <button
                type="button"
                aria-pressed={showBreakdown}
                onClick={() => setShowBreakdown(true)}
                className={cn(
                  "pharos-focus-ring min-h-11 rounded-[4px] px-3 py-2 text-[11px] font-medium leading-none transition-colors md:min-h-0 md:px-2 md:py-1",
                  showBreakdown ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Signal Breakdown
              </button>
            </div>
          ) : null}
          <span className="text-muted-foreground/50" aria-hidden="true">
            ·
          </span>
          <MethodologyHint
            topic="dews"
            buttonClassName="!h-11 !min-h-11 !w-11 rounded-md !border-border/60 !bg-muted/50 !text-muted-foreground hover:!border-border hover:!bg-muted hover:!text-foreground dark:!border-border/60 dark:!bg-muted/50 dark:!text-muted-foreground md:!h-5 md:!w-5 md:!min-h-0"
          />
          <ShowYourWorkToggle className="pharos-focus-ring inline-flex h-11 min-h-11 w-11 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground md:h-5 md:min-h-0 md:w-5">
            <Table2 className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">Show inputs</span>
          </ShowYourWorkToggle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-4 py-5 sm:px-5">
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

        {/* Signal breakdown, sorted by descending score (Figma coin template):
            mono uppercase label · score line with the metric stat right-aligned,
            full-width severity bar beneath; two columns at lg+. */}
        {(() => {
          const renderRow = ({ key, meta, signal }: (typeof sortedSignals)[number]) => {
            const metricVal = signal[meta.metricKey];
            const isInactive = Math.round(signal.value) === 0;
            return (
              <div key={key} className={cn("space-y-2", isInactive && "opacity-60")}>
                <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                  <span className="min-w-0 truncate" title={meta.name}>
                    <span className="text-foreground">{meta.name}</span>
                    <span className="text-muted-foreground"> · {Math.round(signal.value)} / 100</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground" title={meta.metricLabel}>
                    {meta.metricLabel} ·{" "}
                    <span className="text-foreground">{formatMetric(meta.metricKey, metricVal)}</span>
                  </span>
                </div>
                <ProgressBar value={signal.value} />
              </div>
            );
          };
          const half = Math.ceil(sortedSignals.length / 2);
          const leftSignals = sortedSignals.slice(0, half);
          const rightSignals = sortedSignals.slice(half);
          return (
            <>
              <div className="space-y-4 lg:hidden">{sortedSignals.map(renderRow)}</div>
              <div className="hidden lg:grid lg:grid-cols-2 lg:gap-x-8">
                <div className="space-y-4">{leftSignals.map(renderRow)}</div>
                <div className="space-y-4">{rightSignals.map(renderRow)}</div>
              </div>
            </>
          );
        })()}

        {/* The bars render in both chart modes, so the unmeasured signals are
            named in both — otherwise a signal with no reading is indistinguishable
            from one that was never listed. */}
        {unavailableSignalNames.length > 0 && (
          <p className="text-[11px] text-muted-foreground">{unavailableSignalNames.join(", ")} — not applicable</p>
        )}

        {/* History chart */}
        {chartData.length > 1 && (
          <>
            <div ref={chartContainerRef} className="h-[240px]" role="figure" aria-label="DEWS score history">
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={chartData}
                  margin={{ top: 8, right: 12, bottom: 6, left: 0 }}
                >
                  <defs>
                    <ChartAreaGradient id={dewsGradientId} color={DEWS_CHART_HEX} />
                  </defs>
                  <TimeGrid />
                  <TimeXAxis dataKey="ts" tickFormatter={(ts: number) => formatChartDate(ts, "short")} />
                  <MonoYAxis domain={[0, showBreakdown ? signalYMax : chartYMax]} width={40} />
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
                    <Area
                      type="monotone"
                      dataKey="score"
                      stroke={DEWS_CHART_HEX}
                      fill={`url(#${dewsGradientId})`}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
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
      </CardContent>
    </Card>
  );
}
