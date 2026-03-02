"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignalDetail } from "@/hooks/use-stress-signals";
import {
  THREAT_BAND_COLORS,
  THREAT_BAND_LABELS,
  THREAT_BAND_HEX,
} from "@/lib/classification";
import type { ThreatBand } from "@/lib/classification";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";

const SIGNAL_META: Record<
  string,
  { name: string; metricKey: string; metricLabel: string }
> = {
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
  if (val === null || val === undefined) return "n/a";
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
  const { data, isLoading } = useStressSignalDetail(stablecoinId);

  const chartData = useMemo(() => {
    if (!data?.history?.length) return [];
    return data.history.map((h) => ({
      ts: h.date * 1000,
      score: h.score,
      band: h.band,
    }));
  }, [data?.history]);

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.current) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">DEWS: Depeg Early Warning System</CardTitle>
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
        <CardTitle as="h2">Depeg Early Warning</CardTitle>
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
                    <span className={signal.available ? "text-foreground" : "text-muted-foreground"}>
                      {meta.name}
                    </span>
                    <span className="font-mono text-xs tabular-nums">
                      {signal.available ? `${Math.round(signal.value)}/100` : "n/a"}
                    </span>
                  </div>
                  <ProgressBar
                    value={signal.available ? signal.value : 0}
                    band={typedBand}
                  />
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
          <div className="h-[180px]" role="figure" aria-label="DEWS score history">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <defs>
                  <linearGradient id="dewsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={bandHex} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={bandHex} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono)", fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  }
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono)", fill: "var(--color-muted-foreground)" }}
                  width={30}
                />
                <Tooltip
                  {...RECHARTS_TOOLTIP_STYLES}
                  labelFormatter={(ts) =>
                    new Date(Number(ts)).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  }
                  formatter={(val) => [`${val}/100`, "DEWS"]}
                />
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke={bandHex}
                  fill="url(#dewsGrad)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
