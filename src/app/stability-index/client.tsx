"use client";

import { useMemo, useState, useEffect } from "react";
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
import type { StabilityContributor } from "@/hooks/use-stability-index";
import { PsiLighthouse } from "@/components/stability-index";
import { PSI_BAND_CLASSES, PSI_HEX_COLORS } from "@/lib/psi-colors";
import { trackEvent } from "@/lib/analytics";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";

/* ─── Constants ─────────────────────────────────────────────────── */

const BAND_ZONES = [
  { y1: 90, y2: 100, color: "#22c55e", label: "BEDROCK" },
  { y1: 75, y2: 90, color: "#14b8a6", label: "STEADY" },
  { y1: 60, y2: 75, color: "#eab308", label: "TREMOR" },
  { y1: 40, y2: 60, color: "#f97316", label: "FRACTURE" },
  { y1: 20, y2: 40, color: "#ef4444", label: "CRISIS" },
  { y1: 0, y2: 20, color: "#991b1b", label: "MELTDOWN" },
];

const PSI_EVENTS = [
  {
    date: Date.UTC(2018, 9, 14),
    dateEnd: Date.UTC(2018, 9, 26),
    label: "Tether Scare",
    position: "top" as const,
    links: [
      { title: "USDT dropped to $0.90 on some exchanges amid Bitfinex withdrawal concerns", url: "https://www.coindesk.com/markets/2018/10/15/tether-crypto-usd-stablecoin-drops-to-96-cents" },
    ],
  },
  {
    date: Date.UTC(2019, 1, 3),
    dateEnd: Date.UTC(2019, 1, 9),
    label: "QuadrigaCX Collapse",
    position: "insideBottom" as const,
    links: [
      { title: "QuadrigaCX filed for creditor protection after founder's death left C$260M inaccessible", url: "https://www.osc.ca/quadrigacxreport/" },
      { title: "Flight-to-quality panic: USDC hit +6.25% premium while sUSD crashed 25%", url: "https://www.nortonrosefulbright.com/en/knowledge/publications/168bc350/quadriga-bankruptcy" },
    ],
  },
  {
    date: Date.UTC(2021, 6, 20),
    dateEnd: Date.UTC(2021, 7, 5),
    label: "EIP-1559 Rally",
    position: "top" as const,
    links: [
      { title: "Pre-London hard fork rally saw traders dump stablecoins for ETH/BTC, pushing several below peg", url: "https://www.coindesk.com/markets/2021/07/25/countdown-to-ethereums-london-hard-fork-what-you-need-to-know" },
    ],
  },
  {
    date: Date.UTC(2022, 0, 21),
    dateEnd: Date.UTC(2022, 1, 8),
    label: "Fed Crash",
    position: "insideBottom" as const,
    links: [
      { title: "BTC crashed from $43K to $35K as Fed signaled aggressive rate hikes", url: "https://www.washingtonpost.com/business/2022/01/22/crypto-crash-bitcoin-fed/" },
      { title: "Chicago Fed retrospective on the crypto runs of 2022", url: "https://www.chicagofed.org/publications/chicago-fed-letter/2023/479" },
    ],
  },
  {
    date: Date.UTC(2022, 4, 7),
    dateEnd: Date.UTC(2022, 6, 1),
    label: "UST Collapse",
    position: "top" as const,
    links: [
      { title: "Terra/Luna algorithmic stablecoin death spiral wiped $45B", url: "https://www.coindesk.com/learn/the-fall-of-terra-a-timeline-of-the-meteoric-rise-and-crash-of-ust-and-luna/" },
    ],
  },
  {
    date: Date.UTC(2023, 2, 10),
    dateEnd: Date.UTC(2023, 2, 16),
    label: "SVB Weekend",
    position: "insideBottom" as const,
    links: [
      { title: "USDC depegged to $0.88 after $3.3B stuck in collapsed Silicon Valley Bank", url: "https://www.coindesk.com/markets/2023/03/11/usdc-depegs-from-dollar-stablecoin-drops-below-090/" },
    ],
  },
];

const COMPONENT_COLORS = {
  severity: "#f97316",
  breadth: "#3b82f6",
  trend: "#22c55e",
};

const COMPONENT_LEGEND = [
  { label: "Severity", color: COMPONENT_COLORS.severity },
  { label: "Breadth", color: COMPONENT_COLORS.breadth },
  { label: "Trend", color: COMPONENT_COLORS.trend },
];

const COMPONENT_DETAIL = [
  { label: "Severity", sign: "−", color: "#f97316" },
  { label: "Breadth", sign: "−", color: "#3b82f6" },
  { label: "Trend", sign: "+", color: "#22c55e" },
] as const;

/* ─── Helpers ──────────────────────────────────────────────────── */

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

/* ─── ScoreChart ────────────────────────────────────────────────── */

function ScoreChart({ data }: { data: { ts: number; score: number }[] }) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const isMobile = useIsMobile();

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Score History</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-score", range: r }); setRange(r); }} />
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
                {PSI_EVENTS.map((evt) =>
                  evt.dateEnd ? (
                    <ReferenceArea
                      key={evt.label}
                      x1={evt.date}
                      x2={evt.dateEnd}
                      fill="#94a3b8"
                      fillOpacity={0.1}
                      stroke="#94a3b8"
                      strokeOpacity={0.3}
                      strokeDasharray="4 4"
                      label={isMobile ? undefined : {
                        value: evt.label,
                        position: evt.position === "top" ? "insideTop" : "insideBottomLeft",
                        fontSize: 11,
                        fill: "#94a3b8",
                        ...(evt.position === "top" ? { dy: -20 } : {}),
                      }}
                    />
                  ) : (
                    <ReferenceLine
                      key={evt.label}
                      x={evt.date}
                      stroke="#94a3b8"
                      strokeDasharray="4 4"
                      label={isMobile ? undefined : {
                        value: evt.label,
                        position: evt.position,
                        fontSize: 11,
                        fill: "#94a3b8",
                      }}
                    />
                  )
                )}
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

/* ─── EventTimeline ─────────────────────────────────────────────── */

function EventTimeline({ data }: { data: { ts: number; score: number }[] }) {
  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Notable Events</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {PSI_EVENTS.map((evt) => {
          const d = new Date(evt.date);
          const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
          const dateStr = evt.dateEnd
            ? (() => {
                const dEnd = new Date(evt.dateEnd);
                const sameYear = d.getFullYear() === dEnd.getFullYear();
                const start = d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : opts);
                const end = dEnd.toLocaleDateString("en-US", opts);
                return `${start} – ${end}`;
              })()
            : d.toLocaleDateString("en-US", opts);
          // Find the worst (lowest) score within the event window
          const rangeEnd = evt.dateEnd ?? evt.date + 3 * 86400000;
          const SLACK = 3 * 86400000;
          const nearby = data.filter((p) => p.ts >= evt.date - SLACK && p.ts <= rangeEnd + SLACK);
          const worst = nearby.length > 0
            ? nearby.reduce((w, p) => (p.score < w.score ? p : w))
            : null;
          const psi = worst ? worst.score : null;
          const psiBand = psi !== null ? BAND_ZONES.find((z) => psi >= z.y1)?.label ?? "" : "";
          const psiColor = psiBand ? PSI_BAND_CLASSES[psiBand] ?? "text-muted-foreground" : "text-muted-foreground";
          return (
            <div key={evt.label} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
              <span className="text-sm tabular-nums text-muted-foreground shrink-0">{dateStr}</span>
              <span className="text-sm font-semibold">{evt.label}</span>
              {psi !== null && (
                <span className={`text-sm tabular-nums font-medium ${psiColor}`}>
                  PSI {psi.toFixed(1)}
                </span>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {evt.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-500 hover:underline inline-flex items-center gap-1"
                  >
                    {link.title}
                    <svg className="h-3 w-3 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3.5 1.5h7v7M10.5 1.5 1.5 10.5" />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/* ─── ComponentChart ────────────────────────────────────────────── */

function ComponentChart({
  data,
}: {
  data: { ts: number; severity: number; breadth: number; trend: number }[];
}) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Component Breakdown</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-components", range: r }); setRange(r); }} />
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

function useHistoryStats(history: HistoryPoint[]) {
  return useMemo(() => {
    if (!history.length) return null;
    const last30 = history.slice(0, 30);
    const scores = last30.map((p) => p.score);
    const high30 = Math.max(...scores);
    const low30 = Math.min(...scores);
    const avg30 = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    const avg30Band = BAND_ZONES.find((z) => avg30 >= z.y1)?.label ?? "";
    const high30Band = last30.find((p) => p.score === high30)?.band ?? "";
    const low30Band = last30.find((p) => p.score === low30)?.band ?? "";
    const worst = history.reduce((w, p) => (p.score < w.score ? p : w), history[0]);
    return [
      { label: "30d High", value: high30.toFixed(1), band: high30Band, sub: null },
      { label: "30d Low", value: low30.toFixed(1), band: low30Band, sub: null },
      { label: "30d Avg", value: avg30.toFixed(1), band: avg30Band, sub: null },
      {
        label: "ATL",
        value: worst.score.toFixed(1),
        band: worst.band,
        sub: new Date(worst.date * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      },
    ] as const;
  }, [history]);
}

function HistoryStats({ history }: { history: HistoryPoint[] }) {
  const items = useHistoryStats(history);
  if (!items) return null;

  return (
    <>
      <div className="h-10 w-px bg-border" />
      {items.map((item) => {
        const color = PSI_BAND_CLASSES[item.band] ?? "text-foreground";
        return (
          <div key={item.label} className="flex flex-col items-center gap-0.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">{item.label}</span>
            <span className={`text-lg font-bold tabular-nums ${color}`}>{item.value}</span>
            {item.sub && <span className="text-xs text-muted-foreground">{item.sub}</span>}
          </div>
        );
      })}
    </>
  );
}

function HistoryStatsMobile({ history }: { history: HistoryPoint[] }) {
  const items = useHistoryStats(history);
  if (!items) return null;

  return (
    <div className="lg:hidden grid grid-cols-4 gap-3 w-full border-t pt-4">
      {items.map((item) => {
        const color = PSI_BAND_CLASSES[item.band] ?? "text-foreground";
        return (
          <div key={item.label} className="flex flex-col items-center gap-0.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">{item.label}</span>
            <span className={`text-base font-bold tabular-nums ${color}`}>{item.value}</span>
            {item.sub && <span className="text-xs text-muted-foreground">{item.sub}</span>}
          </div>
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
            Score = 100 &minus; severity &minus; breadth + trend
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
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 68</td>
                  <td className="py-2">Depeg magnitude weighted by market cap significance</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Breadth</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 17</td>
                  <td className="py-2">Number of depegging coins, weighted so micro-caps barely register</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-medium text-foreground">Trend</td>
                  <td className="py-2 pr-4 tabular-nums">&minus;5 to +5</td>
                  <td className="py-2">7-day total market cap momentum</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Depreciation</h3>
          <p className="text-sm text-muted-foreground mb-2">
            Chronically depegged coins have their impact reduced over time to prevent zombie stablecoins
            from permanently dominating the score. Fresh depegs (under 30 days) have full impact. After 30 days,
            both severity and breadth contributions decay linearly, reaching a 25% floor at 150 days.
          </p>
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

/* ─── Contributors Table ───────────────────────────────────────── */

function ContributorsTable({
  contributors,
  totalMcapUsd,
}: {
  contributors: StabilityContributor[];
  totalMcapUsd: number;
}) {
  const { data: logos } = useLogos();

  const rows = useMemo(() => {
    if (!contributors.length) return [];
    return contributors
      .map((c) => {
        const share = totalMcapUsd > 0 ? c.mcapUsd / totalMcapUsd : 0;
        const amplifier = Math.log2(1 + c.mcapUsd / 1e9);
        const severity = (Math.abs(c.bps) / 100) * share * amplifier * 60 * c.factor;
        const breadth = Math.sqrt(c.mcapUsd / 1e9) * 3 * c.factor;
        return { ...c, severity, breadth, total: severity + breadth };
      })
      .sort((a, b) => b.total - a.total);
  }, [contributors, totalMcapUsd]);

  if (!rows.length) return null;

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Top Contributors</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          Which stablecoins are currently pushing the score below 100, ranked by total impact.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Coin</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Deviation</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">MCap</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">Severity</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">Breadth</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Total</th>
                <th className="pb-2 font-medium text-muted-foreground text-right">Age</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    <a
                      href={`/stablecoin/${r.id}`}
                      className="flex items-center gap-2 font-medium text-foreground hover:text-blue-500 transition-colors"
                    >
                      <StablecoinLogo src={logos[r.id]} name={r.symbol} size={20} />
                      {r.symbol}
                    </a>
                  </td>
                  <td className={`py-2 pr-4 text-right tabular-nums ${r.bps < 0 ? "text-red-500" : "text-amber-500"}`}>
                    {r.bps > 0 ? "+" : ""}{(r.bps / 100).toFixed(2)}%
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">
                    ${r.mcapUsd >= 1e9 ? `${(r.mcapUsd / 1e9).toFixed(1)}B` : `${(r.mcapUsd / 1e6).toFixed(0)}M`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">{r.severity.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">{r.breadth.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums font-medium text-foreground">{r.total.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.ageDays < 1 ? "<1d" : `${Math.round(r.ageDays)}d`}
                    {r.factor < 1 && (
                      <span className="ml-1 text-xs text-muted-foreground/60">({Math.round(r.factor * 100)}%)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Main Client Component ─────────────────────────────────────── */

export function StabilityIndexClient() {
  const { data, isLoading, isError } = useStabilityIndexDetail();

  const daysInBand = useMemo(() => {
    if (!data?.current || !data.history.length) return 0;
    const currentBand = data.current.avg24hBand ?? data.current.band;
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
    const reversed = [...data.history].filter((p) => p.components).reverse();
    return [
      ...reversed.map((p) => ({
        ts: p.date * 1000,
        severity: p.components.severity,
        breadth: p.components.breadth,
        trend: p.components.trend,
      })),
      {
        ts: data.current.computedAt * 1000,
        severity: data.current.components.severity,
        breadth: data.current.components.breadth,
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

  if (isError || (!isLoading && !data?.current)) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="py-12 text-center space-y-2">
          <p className="text-sm font-medium">Unable to load Stability Index data</p>
          <p className="text-sm text-muted-foreground">
            Please try refreshing the page. If the problem persists, data may be temporarily unavailable.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.current) return null;

  const { score, band, avg24h, avg24hBand, components } = data.current;
  const displayScore = avg24h ?? score;
  const displayBand = avg24hBand ?? band;
  const yesterday = data.history.length > 0 ? data.history[0] : null;
  const delta = yesterday ? Math.round((displayScore - yesterday.score) * 10) / 10 : null;
  const colorClass = PSI_BAND_CLASSES[displayBand] ?? "text-foreground";
  const hexColor = PSI_HEX_COLORS[displayBand] ?? "#888";

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Hero — score + components + history stats in one card */}
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col lg:flex-row items-center gap-4 lg:gap-6 py-6">
          {/* Score + delta */}
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
            <PsiLighthouse band={displayBand} color={hexColor} size={72} />
            <div className="flex flex-col items-center sm:items-start gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className={`text-4xl font-bold tabular-nums ${colorClass}`}>
                  {displayScore.toFixed(1)}
                </span>
                <span className={`text-lg font-bold uppercase tracking-wide ${colorClass}`}>
                  {displayBand}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {delta !== null && (
                  <span className={`font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {delta >= 0 ? "+" : ""}{delta.toFixed(1)} vs yesterday
                  </span>
                )}
                <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {displayBand}</span>
              </div>
            </div>
          </div>
          {/* Component breakdown — desktop, next to score */}
          <div className="hidden lg:flex items-center gap-5">
            <div className="h-10 w-px bg-border" />
            {COMPONENT_DETAIL.map((c) => (
              <div key={c.label} className="flex flex-col items-center gap-0.5">
                <span className="text-xs text-muted-foreground">{c.label}</span>
                <span className="text-lg font-bold tabular-nums" style={{ color: c.color }}>
                  {c.sign}{components[c.label.toLowerCase() as keyof typeof components].toFixed(1)}
                </span>
              </div>
            ))}
          </div>
          {/* History stats — desktop, right-aligned */}
          <div className="hidden lg:flex items-center gap-5 ml-auto">
            <HistoryStats history={data.history} />
          </div>
          {/* History stats — mobile only */}
          <HistoryStatsMobile history={data.history} />
        </CardContent>
      </Card>

      {/* Score History */}
      <ScoreChart data={chartData} />

      {/* Notable Events */}
      <EventTimeline data={chartData} />

      {/* Top Contributors */}
      {data.current.contributors && data.current.contributors.length > 0 && (
        <ContributorsTable
          contributors={data.current.contributors}
          totalMcapUsd={data.current.totalMcapUsd ?? 0}
        />
      )}

      {/* Component Breakdown */}
      <ComponentChart data={componentData} />

      {/* Methodology */}
      <Methodology />
    </div>
  );
}
