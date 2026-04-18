"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, ReferenceLine } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { THREAT_BAND_COLORS, THREAT_BAND_LABELS } from "@shared/lib/classification";
import { THREAT_BAND_HEX, SIGNAL_CHART_COLORS } from "@/lib/chart-colors";
import type { ThreatBand } from "@shared/lib/classification";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { formatChartDate } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";

const SIGNAL_META: Record<string, { name: string; metricKey: string; metricLabel: string }> = {
  supply: { name: "Supply Velocity", metricKey: "delta1d", metricLabel: "1d change" },
  pool: { name: "Pool Balance Drift", metricKey: "balanceRatio", metricLabel: "balance ratio" },
  liq: { name: "Liquidity Erosion", metricKey: "scoreDelta7d", metricLabel: "7d score \u0394" },
  price: { name: "Price Confidence", metricKey: "confidence", metricLabel: "confidence" },
  diverg: { name: "Price Divergence", metricKey: "spreadBps", metricLabel: "spread (bps)" },
  black: { name: "Blacklist Activity", metricKey: "events24h", metricLabel: "24h events" },
  flow: { name: "Mint/Burn Flow", metricKey: "burnSurge", metricLabel: "burn surge" },
  yield: { name: "Yield Anomaly", metricKey: "warnings", metricLabel: "warnings" },
};

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
      <h4 className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
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
            <span className="font-mono text-foreground">{key}</span>
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
    if (max <= 25) return 50;
    if (max <= 50) return 75;
    return 100;
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
    if (max <= 25) return 50;
    if (max <= 50) return 75;
    return 100;
  }, [history]);

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
            <MethodologyLabel topic="dews">DEWS: Depeg Early Warning System</MethodologyLabel>
          </CardTitle>
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
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
            <MethodologyLabel topic="dews">DEWS: Depeg Early Warning System</MethodologyLabel>
          </CardTitle>
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

  const unavailableSignalNames = Object.entries(SIGNAL_META)
    .filter(([key]) => signals[key] && !signals[key].available)
    .map(([, meta]) => meta.name);

  return (
    <Card className="animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
          <MethodologyLabel topic="dews">Depeg Early Warning</MethodologyLabel>
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-extrabold font-mono tabular-nums">{score}</span>
          <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${bandColor}`}>
            {THREAT_BAND_LABELS[typedBand]}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableCount < 4 && (
          <p className="text-xs text-muted-foreground">
            Limited data: only {availableCount} of 8 signals available. Score may be less reliable.
          </p>
        )}

        {/* Signal breakdown */}
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_auto] gap-x-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
            <div className="flex justify-between">
              <span>Signal</span>
              <span>Score</span>
            </div>
            <span className="w-20 text-right">Value</span>
          </div>

          {Object.entries(SIGNAL_META).map(([key, meta]) => {
            const signal = signals[key];
            if (!signal || !signal.available) return null;
            const metricVal = signal[meta.metricKey];
            const isInactive = Math.round(signal.value) === 0;

            return (
              <div
                key={key}
                className={cn(
                  "grid grid-cols-[1fr_auto] gap-x-3 items-center text-sm",
                  isInactive && "opacity-50",
                )}
              >
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-foreground">{meta.name}</span>
                    <span className="font-mono text-xs tabular-nums">
                      {Math.round(signal.value)}/100
                    </span>
                  </div>
                  <ProgressBar value={signal.value} />
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right truncate" title={meta.metricLabel}>
                  {formatMetric(meta.metricKey, metricVal)}
                </span>
              </div>
            );
          })}
        </div>

        {unavailableSignalNames.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {unavailableSignalNames.join(", ")} — not applicable
          </p>
        )}

        <DEWSFiringList signals={signals} />

        {/* History chart */}
        {chartData.length > 1 && (
          <>
            <div className="flex items-center justify-end">
              <button
                onClick={() => setShowBreakdown((v) => !v)}
                className="pharos-focus-ring min-h-11 rounded-md px-2 py-1 text-xs text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground lg:min-h-9"
              >
                {showBreakdown ? "Show composite" : "Show signal breakdown"}
              </button>
            </div>

            <div ref={chartContainerRef} className="h-[180px]" role="figure" aria-label="DEWS score history">
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={chartData}
                  margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
                >
                  <defs>
                    <linearGradient id="dewsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={bandHex} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={bandHex} stopOpacity={0.05} />
                    </linearGradient>
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
                    <Area type="monotone" dataKey="score" stroke={bandHex} fill="url(#dewsGrad)" strokeWidth={2} />
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

        <MethodologyCardActions topic="dews" />
      </CardContent>
    </Card>
  );
}
