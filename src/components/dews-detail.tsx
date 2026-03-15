"use client";

import { useMemo } from "react";
import { AreaChart, Area } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { THREAT_BAND_COLORS, THREAT_BAND_LABELS, THREAT_BAND_HEX } from "@shared/lib/classification";
import type { ThreatBand } from "@shared/lib/classification";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { formatChartDate } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

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

function ProgressBar({ value, band }: { value: number; band: ThreatBand }) {
  const hex = THREAT_BAND_HEX[band] ?? THREAT_BAND_HEX.CALM;
  return (
    <div className="h-1.5 w-full rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.min(value, 100)}%`, backgroundColor: hex }}
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

interface DEWSDetailProps {
  stablecoinId: string;
}

export function DEWSDetail({ stablecoinId }: DEWSDetailProps) {
  const { data, isLoading, error, refetch } = useStressSignalDetail(stablecoinId);
  const history = data?.history;
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!history?.length) return [];
    return history.map((h) => ({
      ts: h.date * 1000,
      score: h.score,
      band: h.band,
    }));
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
          {Object.entries(SIGNAL_META).map(([key, meta]) => {
            const signal = signals[key];
            if (!signal) return null;
            const metricVal = signal[meta.metricKey];

            return (
              <div key={key} className="grid grid-cols-[1fr_auto] gap-x-3 items-center text-sm">
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className={signal.available ? "text-foreground" : "text-muted-foreground"}>{meta.name}</span>
                    <span className="font-mono text-xs tabular-nums">
                      {signal.available ? `${Math.round(signal.value)}/100` : "—"}
                    </span>
                  </div>
                  <ProgressBar value={signal.available ? signal.value : 0} band={typedBand} />
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right truncate" title={meta.metricLabel}>
                  {signal.available ? formatMetric(meta.metricKey, metricVal) : "\u2014"}
                </span>
              </div>
            );
          })}
        </div>

        {/* History chart */}
        {chartData.length > 1 && (
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
                <MonoYAxis domain={[0, 100]} width={30} />
                <DateTooltip formatter={(val) => [`${val}/100`, "DEWS"]} />
                <Area type="monotone" dataKey="score" stroke={bandHex} fill="url(#dewsGrad)" strokeWidth={2} />
              </AreaChart>
            ) : (
              <div className="h-full w-full animate-pulse rounded bg-muted" />
            )}
          </div>
        )}

        <MethodologyCardActions topic="dews" />
      </CardContent>
    </Card>
  );
}
