"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
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
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES, PSI_BAND_COLORS, CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { useStabilityIndexDetail } from "@/hooks/use-stability-index";
import { trackEvent } from "@/lib/analytics";

/* ─── Constants ─────────────────────────────────────────────────── */

export const BAND_ZONES = [
  { y1: 90, y2: 100, color: PSI_BAND_COLORS.BEDROCK, label: "BEDROCK" },
  { y1: 75, y2: 90, color: PSI_BAND_COLORS.STEADY, label: "STEADY" },
  { y1: 60, y2: 75, color: PSI_BAND_COLORS.TREMOR, label: "TREMOR" },
  { y1: 40, y2: 60, color: PSI_BAND_COLORS.FRACTURE, label: "FRACTURE" },
  { y1: 20, y2: 40, color: PSI_BAND_COLORS.CRISIS, label: "CRISIS" },
  { y1: 0, y2: 20, color: PSI_BAND_COLORS.MELTDOWN, label: "MELTDOWN" },
];

export const PSI_EVENTS = [
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
    date: Date.UTC(2021, 5, 16),
    dateEnd: Date.UTC(2021, 5, 21),
    label: "IRON Finance",
    position: "top" as const,
    links: [
      { title: "Crypto's first large-scale bank run: TITAN went from $65 to zero, dragging IRON to $0.75", url: "https://www.coindesk.com/markets/2021/06/17/in-token-crash-postmortem-iron-finance-says-it-suffered-cryptos-first-large-scale-bank-run" },
      { title: "Federal Reserve analysis of the algorithmic stablecoin run mechanism", url: "https://www.federalreserve.gov/econres/notes/feds-notes/runs-on-algorithmic-stablecoins-evidence-from-iron-titan-and-steel-20220602.html" },
    ],
  },
  {
    date: Date.UTC(2021, 6, 26),
    dateEnd: Date.UTC(2021, 7, 1),
    label: "Tether DOJ Probe",
    position: "insideBottom" as const,
    links: [
      { title: "DOJ opened criminal investigation into Tether executives for bank fraud", url: "https://www.cnbc.com/2021/07/26/doj-reportedly-probes-crypto-company-tether-for-possible-bank-fraud.html" },
      { title: "Broad stablecoin depeg: 10 coins depegged simultaneously as market panicked", url: "https://fortune.com/2021/07/26/tether-crypto-bank-fraud-doj-investigation/" },
    ],
  },
  {
    date: Date.UTC(2022, 0, 21),
    dateEnd: Date.UTC(2022, 1, 8),
    label: "Fed Crash",
    position: "top" as const,
    links: [
      { title: "BTC crashed from $43K to $35K as Fed signaled aggressive rate hikes", url: "https://www.washingtonpost.com/business/2022/01/22/crypto-crash-bitcoin-fed/" },
      { title: "Chicago Fed retrospective on the crypto runs of 2022", url: "https://www.chicagofed.org/publications/chicago-fed-letter/2023/479" },
    ],
  },
  {
    date: Date.UTC(2022, 4, 7),
    dateEnd: Date.UTC(2022, 6, 1),
    label: "UST Collapse",
    position: "insideBottom" as const,
    links: [
      { title: "Terra/Luna algorithmic stablecoin death spiral wiped $45B", url: "https://www.coindesk.com/learn/the-fall-of-terra-a-timeline-of-the-meteoric-rise-and-crash-of-ust-and-luna/" },
    ],
  },
  {
    date: Date.UTC(2023, 2, 10),
    dateEnd: Date.UTC(2023, 2, 16),
    label: "SVB Weekend",
    position: "top" as const,
    links: [
      { title: "USDC depegged to $0.88 after $3.3B stuck in collapsed Silicon Valley Bank", url: "https://www.coindesk.com/markets/2023/03/11/usdc-depegs-from-dollar-stablecoin-drops-below-090/" },
    ],
  },
];

/* ─── Helpers ──────────────────────────────────────────────────── */

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  });
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

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

  /* Hide overlapping event labels when zoomed into a tight range */
  const visibleEvents = useMemo(() => {
    const events = excludeEvents ? PSI_EVENTS.filter((e) => !excludeEvents.includes(e.label)) : PSI_EVENTS;
    const min = filteredData[0]?.ts;
    const max = filteredData[filteredData.length - 1]?.ts;
    if (!min || !max) return events.map((e) => ({ ...e, hideLabel: false }));

    const rangeMs = max - min;
    const threshold = rangeMs * 0.05; // 5% of visible range

    const sorted = [...events]
      .filter((e) => e.date <= max && (e.dateEnd ?? e.date) >= min)
      .sort((a, b) => a.date - b.date);

    const result: (typeof sorted[number] & { hideLabel: boolean })[] = [];
    const lastShownEndByPos: Record<string, number> = {};
    for (const evt of sorted) {
      const pos = evt.position ?? "insideBottom";
      const lastEnd = lastShownEndByPos[pos] ?? -Infinity;
      if (evt.date - lastEnd < threshold) {
        result.push({ ...evt, hideLabel: true });
      } else {
        result.push({ ...evt, hideLabel: false });
        lastShownEndByPos[pos] = evt.dateEnd ?? evt.date;
      }
    }

    // Events outside the visible range stay hidden
    return events.map(
      (e) => result.find((r) => r.label === e.label) ?? { ...e, hideLabel: true },
    );
  }, [filteredData, excludeEvents]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      {showHeader && (
        <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle as="h2" className="min-w-0">Pharos Stability Index History</CardTitle>
          <CardAction className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-score", range: r }); setRange(r); }} />
            <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={handlePngExport} title="Save chart as PNG" aria-label="Save chart as PNG">
              <Camera className="h-4 w-4" />
            </Button>
          </CardAction>
        </CardHeader>
      )}
      <CardContent className={showHeader ? undefined : "px-4 pt-4 pb-2"}>
        {filteredData.length > 0 ? (
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
            className={showHeader ? "psi-chart h-[250px] sm:h-[350px]" : "psi-chart h-[250px] sm:h-[336px]"}
            role="figure"
            aria-label={`PSI score history chart showing ${filteredData.length} data points`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart
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
                      label={isMobile || evt.hideLabel ? undefined : {
                        value: evt.label,
                        position: evt.position === "top" ? "insideTop" : "insideBottomLeft",
                        fontSize: 11,
                        fill: CHART_SLATE,
                        ...(evt.position === "top" ? { dy: -20 } : {}),
                      }}
                    />
                  ) : (
                    <ReferenceLine
                      key={evt.label}
                      x={evt.date}
                      stroke={CHART_SLATE}
                      strokeDasharray="4 4"
                      label={isMobile || evt.hideLabel ? undefined : {
                        value: evt.label,
                        position: evt.position,
                        fontSize: 11,
                        fill: CHART_SLATE,
                      }}
                    />
                  )
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={72}
                  tickFormatter={(ts: number) =>
                    new Date(ts).toLocaleDateString("en-US", {
                      month: "short",
                      year: "2-digit",
                    })
                  }
                />
                <YAxis
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
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
                  stroke={CHART_BLUE}
                  fill="url(#psiScoreGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          </div>
        ) : (
          <div className={showHeader ? "flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground" : "flex h-[250px] sm:h-[336px] items-center justify-center text-muted-foreground"}>
            No score history available
          </div>
        )}
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
    if (!current || !history) return [];
    const reversed = [...history].reverse();
    return [
      ...reversed.map((p) => ({ ts: p.date * 1000, score: p.score })),
      { ts: current.computedAt * 1000, score: current.score },
    ];
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

  return (
    <ScoreChart
      data={chartData}
      excludeEvents={excludeEvents}
      showHeader={showHeader}
    />
  );
}
