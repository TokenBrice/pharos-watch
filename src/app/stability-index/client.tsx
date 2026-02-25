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
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { useStabilityIndexDetail } from "@/hooks/use-stability-index";
import { PsiLighthouse } from "@/components/stability-index";

/* ─── Constants ─────────────────────────────────────────────────── */

const BAND_COLORS: Record<string, string> = {
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
};

const HEX_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

const BAND_ZONES = [
  { y1: 90, y2: 100, color: "#22c55e", label: "BEDROCK" },
  { y1: 75, y2: 90, color: "#14b8a6", label: "STEADY" },
  { y1: 60, y2: 75, color: "#eab308", label: "TREMOR" },
  { y1: 40, y2: 60, color: "#f97316", label: "FRACTURE" },
  { y1: 20, y2: 40, color: "#ef4444", label: "CRISIS" },
  { y1: 0, y2: 20, color: "#991b1b", label: "MELTDOWN" },
];

const PSI_EVENTS = [
  { date: Date.UTC(2018, 9, 15), label: "Tether Scare", position: "top" as const },
  { date: Date.UTC(2020, 2, 12), label: "Black Thursday", position: "insideBottom" as const },
  { date: Date.UTC(2022, 4, 7), label: "UST Collapse", position: "top" as const },
  { date: Date.UTC(2023, 2, 10), label: "SVB Weekend", position: "insideBottom" as const },
];

const COMPONENT_COLORS = {
  severity: "#f97316",
  breadth: "#3b82f6",
  freezes: "#ef4444",
  trend: "#22c55e",
};

const COMPONENT_LEGEND = [
  { label: "Severity", color: COMPONENT_COLORS.severity },
  { label: "Breadth", color: COMPONENT_COLORS.breadth },
  { label: "Freezes", color: COMPONENT_COLORS.freezes },
  { label: "Trend", color: COMPONENT_COLORS.trend },
];

const COMPONENT_DETAIL = [
  { label: "Severity", sign: "−", color: "#f97316" },
  { label: "Breadth", sign: "−", color: "#3b82f6" },
  { label: "Freezes", sign: "−", color: "#ef4444" },
  { label: "Trend", sign: "+", color: "#22c55e" },
] as const;

/* ─── ScoreChart ────────────────────────────────────────────────── */

function ScoreChart({ data }: { data: { ts: number; score: number }[] }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Score History</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`PSI score history chart showing ${filteredData.length} data points`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredData} margin={{ top: 30, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="psiScoreGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                {BAND_ZONES.map((zone) => (
                  <ReferenceArea
                    key={zone.label}
                    y1={zone.y1}
                    y2={zone.y2}
                    fill={zone.color}
                    fillOpacity={0.06}
                    ifOverflow="extendDomain"
                  />
                ))}
                {PSI_EVENTS.map((evt) => (
                  <ReferenceLine
                    key={evt.label}
                    x={evt.date}
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                    label={{
                      value: evt.label,
                      position: evt.position,
                      fontSize: 11,
                      fill: "#94a3b8",
                    }}
                  />
                ))}
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    })
                  }
                />
                <YAxis
                  tick={{ fontSize: 12 }}
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
                  stroke="#3b82f6"
                  fill="url(#psiScoreGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No score history available
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── ComponentChart ────────────────────────────────────────────── */

function ComponentChart({
  data,
}: {
  data: { ts: number; severity: number; breadth: number; freezes: number; trend: number }[];
}) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Component Breakdown</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-4 mb-4">
          {COMPONENT_LEGEND.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </div>
          ))}
        </div>
        {filteredData.length > 0 ? (
          <div
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`PSI component breakdown chart showing ${filteredData.length} data points`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="psiSeverityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiBreadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiFreezesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.freezes} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.freezes} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiTrendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.trend} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.trend} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    })
                  }
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(value, name) => [Number(value).toFixed(1), String(name)]}
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
                  dataKey="severity"
                  name="Severity"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.severity}
                  fill="url(#psiSeverityGrad)"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="breadth"
                  name="Breadth"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.breadth}
                  fill="url(#psiBreadthGrad)"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="freezes"
                  name="Freezes"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.freezes}
                  fill="url(#psiFreezesGrad)"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="trend"
                  name="Trend"
                  stroke={COMPONENT_COLORS.trend}
                  fill="none"
                  strokeWidth={2}
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

/* ─── HistoryStats ──────────────────────────────────────────────── */

type HistoryPoint = { date: number; score: number; band: string };

function HistoryStats({ history }: { history: HistoryPoint[] }) {
  const stats = useMemo(() => {
    if (!history.length) return null;
    // history is newest-first
    const last30 = history.slice(0, 30);
    const scores = last30.map((p) => p.score);
    const high30 = Math.max(...scores);
    const low30 = Math.min(...scores);
    const avg30 = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    const avg30Band = BAND_ZONES.find((z) => avg30 >= z.y1)?.label ?? "";
    const high30Band = last30.find((p) => p.score === high30)?.band ?? "";
    const low30Band = last30.find((p) => p.score === low30)?.band ?? "";
    const worst = history.reduce((w, p) => (p.score < w.score ? p : w), history[0]);
    return { high30, high30Band, low30, low30Band, avg30, avg30Band, worst };
  }, [history]);

  if (!stats) return null;

  const items = [
    { label: "30d High", value: stats.high30.toFixed(1), band: stats.high30Band, sub: null },
    { label: "30d Low", value: stats.low30.toFixed(1), band: stats.low30Band, sub: null },
    { label: "30d Avg", value: stats.avg30.toFixed(1), band: stats.avg30Band, sub: null },
    {
      label: "All-time Low",
      value: stats.worst.score.toFixed(1),
      band: stats.worst.band,
      sub: new Date(stats.worst.date * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    },
  ];

  return (
    <div className="hidden lg:grid grid-cols-4 gap-3">
      {items.map((item) => {
        const color = BAND_COLORS[item.band] ?? "text-foreground";
        return (
          <Card key={item.label} className="rounded-xl">
            <CardContent className="py-4 px-4">
              <p className="text-xs text-muted-foreground mb-1">{item.label}</p>
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{item.value}</p>
              <p className={`text-xs font-medium uppercase tracking-wide mt-0.5 ${color}`}>{item.band}</p>
              {item.sub && <p className="text-xs text-muted-foreground mt-0.5">{item.sub}</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* ─── Methodology ───────────────────────────────────────────────── */

function Methodology() {
  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Methodology</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <p className="text-sm text-muted-foreground mb-2">
            The Pharos Stability Index (PSI) is a single 0-100 score reflecting overall stablecoin market health.
          </p>
          <code className="block rounded-lg bg-muted px-4 py-3 text-sm font-mono">
            Score = 100 &minus; severity &minus; breadth &minus; freezes + trend
          </code>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Components</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">Component</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">Range</th>
                  <th className="pb-2 font-medium text-muted-foreground">Description</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Severity</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 40</td>
                  <td className="py-2">Worst individual depeg magnitude, cap-weighted</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Breadth</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 30</td>
                  <td className="py-2">Share of tracked supply currently depegged</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Freezes</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 20</td>
                  <td className="py-2">Penalty for active blacklist freezes on major stablecoins</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-medium text-foreground">Trend</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 10</td>
                  <td className="py-2">Bonus when conditions are improving (7-day momentum)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Condition Bands</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">Range</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">Band</th>
                  <th className="pb-2 font-medium text-muted-foreground">Meaning</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b">
                  <td className="py-2 pr-4 tabular-nums">90 &ndash; 100</td>
                  <td className="py-2 pr-4 font-medium text-green-500">BEDROCK</td>
                  <td className="py-2">Exceptional stability across all tracked stablecoins</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 tabular-nums">75 &ndash; 89</td>
                  <td className="py-2 pr-4 font-medium text-teal-500">STEADY</td>
                  <td className="py-2">Normal conditions with minor deviations</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 tabular-nums">60 &ndash; 74</td>
                  <td className="py-2 pr-4 font-medium text-yellow-500">TREMOR</td>
                  <td className="py-2">Notable stress in parts of the market</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 tabular-nums">40 &ndash; 59</td>
                  <td className="py-2 pr-4 font-medium text-orange-500">FRACTURE</td>
                  <td className="py-2">Significant depegs affecting multiple assets</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 tabular-nums">20 &ndash; 39</td>
                  <td className="py-2 pr-4 font-medium text-red-500">CRISIS</td>
                  <td className="py-2">Severe market-wide instability</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 19</td>
                  <td className="py-2 pr-4 font-medium text-red-800">MELTDOWN</td>
                  <td className="py-2">Systemic failure across stablecoin markets</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Main Client Component ─────────────────────────────────────── */

export function StabilityIndexClient() {
  const { data, isLoading } = useStabilityIndexDetail();

  const daysInBand = useMemo(() => {
    if (!data?.current || !data.history.length) return 0;
    const currentBand = data.current.band;
    // History is newest-first; count consecutive days with same band
    let count = 0;
    for (const point of data.history) {
      if (point.band === currentBand) {
        count++;
      } else {
        break;
      }
    }
    // Add 1 for today (current)
    return count + 1;
  }, [data]);

  const chartData = useMemo(() => {
    if (!data?.current) return [];
    const reversed = [...data.history].reverse();
    return [
      ...reversed.map((p) => ({ ts: p.date * 1000, score: p.score })),
      { ts: data.current.computedAt * 1000, score: data.current.score },
    ];
  }, [data]);

  const componentData = useMemo(() => {
    if (!data?.current) return [];
    const reversed = [...data.history].reverse();
    return [
      ...reversed.map((p) => ({
        ts: p.date * 1000,
        severity: p.components.severity,
        breadth: p.components.breadth,
        freezes: p.components.freezes,
        trend: p.components.trend,
      })),
      {
        ts: data.current.computedAt * 1000,
        severity: data.current.components.severity,
        breadth: data.current.components.breadth,
        freezes: data.current.components.freezes,
        trend: data.current.components.trend,
      },
    ];
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card className="rounded-2xl">
          <CardContent className="flex items-center gap-6 py-8">
            <Skeleton className="h-20 w-20 rounded-full" />
            <div className="space-y-3">
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-6 w-48" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] sm:h-[350px] w-full" />
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] sm:h-[350px] w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data?.current) return null;

  const { score, band, components } = data.current;
  const yesterday = data.history.length > 0 ? data.history[0] : null;
  const delta = yesterday ? Math.round((score - yesterday.score) * 10) / 10 : null;
  const colorClass = BAND_COLORS[band] ?? "text-foreground";
  const hexColor = HEX_COLORS[band] ?? "#888";

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Hero */}
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col sm:flex-row items-center gap-6 py-8">
          <PsiLighthouse band={band} color={hexColor} size={80} />
          <div className="flex flex-col items-center sm:items-start gap-1">
            <div className="flex items-baseline gap-3">
              <span className={`text-5xl font-bold tabular-nums ${colorClass}`}>
                {score.toFixed(1)}
              </span>
              <span className={`text-xl font-bold uppercase tracking-wide ${colorClass}`}>
                {band}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {delta !== null && (
                <span className={`font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(1)} vs yesterday
                </span>
              )}
              <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {band}</span>
            </div>
          </div>
          {/* Component breakdown — desktop only */}
          <div className="hidden lg:flex items-center gap-6 ml-auto">
            <div className="h-14 w-px bg-border" />
            <div className="flex items-center gap-6">
              {COMPONENT_DETAIL.map((c) => (
                <div key={c.label} className="flex flex-col items-center gap-0.5">
                  <span className="text-xs text-muted-foreground">{c.label}</span>
                  <span className="text-xl font-bold tabular-nums" style={{ color: c.color }}>
                    {c.sign}{components[c.label.toLowerCase() as keyof typeof components].toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Historical stat strip — desktop only */}
      <HistoryStats history={data.history} />

      {/* Score History */}
      <ScoreChart data={chartData} />

      {/* Component Breakdown */}
      <ComponentChart data={componentData} />

      {/* Methodology */}
      <Methodology />
    </div>
  );
}
