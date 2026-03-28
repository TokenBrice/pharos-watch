"use client";

import { useMemo, useState, useRef, useCallback } from "react";
import { CHART_DRAW_IN } from "@/lib/chart-animation";
import { AreaChart, Area, ReferenceArea, ReferenceLine } from "recharts";
import { Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadChartPng } from "@/lib/chart-export";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { trackEvent } from "@/lib/analytics";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { PSI_HEX_COLORS } from "@shared/lib/psi-colors";
import { useIsMobile } from "@/hooks/use-is-mobile";

/* ─── Constants ─────────────────────────────────────────────────── */

export const BAND_ZONES = [
  { y1: 90, y2: 100, color: PSI_HEX_COLORS.BEDROCK, label: "BEDROCK" },
  { y1: 75, y2: 90, color: PSI_HEX_COLORS.STEADY, label: "STEADY" },
  { y1: 60, y2: 75, color: PSI_HEX_COLORS.TREMOR, label: "TREMOR" },
  { y1: 40, y2: 60, color: PSI_HEX_COLORS.FRACTURE, label: "FRACTURE" },
  { y1: 20, y2: 40, color: PSI_HEX_COLORS.CRISIS, label: "CRISIS" },
  { y1: 0, y2: 20, color: PSI_HEX_COLORS.MELTDOWN, label: "MELTDOWN" },
];

export const PSI_EVENTS = [
  {
    date: Date.UTC(2018, 9, 14),
    dateEnd: Date.UTC(2018, 9, 26),
    label: "Tether Scare",
    position: "top" as const,
    links: [
      {
        title: "USDT dropped to $0.90 on some exchanges amid Bitfinex withdrawal concerns",
        url: "https://www.coindesk.com/markets/2018/10/15/tether-crypto-usd-stablecoin-drops-to-96-cents",
      },
    ],
  },
  {
    date: Date.UTC(2019, 1, 3),
    dateEnd: Date.UTC(2019, 1, 9),
    label: "QuadrigaCX Collapse",
    position: "insideBottom" as const,
    links: [
      {
        title: "QuadrigaCX filed for creditor protection after founder's death left C$260M inaccessible",
        url: "https://www.osc.ca/quadrigacxreport/",
      },
      {
        title: "Flight-to-quality panic: USDC hit +6.25% premium while sUSD crashed 25%",
        url: "https://www.nortonrosefulbright.com/en/knowledge/publications/168bc350/quadriga-bankruptcy",
      },
    ],
  },
  {
    date: Date.UTC(2021, 5, 16),
    dateEnd: Date.UTC(2021, 5, 21),
    label: "IRON Finance",
    position: "top" as const,
    links: [
      {
        title: "Crypto's first large-scale bank run: TITAN went from $65 to zero, dragging IRON to $0.75",
        url: "https://www.coindesk.com/markets/2021/06/17/in-token-crash-postmortem-iron-finance-says-it-suffered-cryptos-first-large-scale-bank-run",
      },
      {
        title: "Federal Reserve analysis of the algorithmic stablecoin run mechanism",
        url: "https://www.federalreserve.gov/econres/notes/feds-notes/runs-on-algorithmic-stablecoins-evidence-from-iron-titan-and-steel-20220602.html",
      },
    ],
  },
  {
    date: Date.UTC(2021, 6, 26),
    dateEnd: Date.UTC(2021, 7, 1),
    label: "Tether DOJ Probe",
    position: "insideBottom" as const,
    links: [
      {
        title: "DOJ opened criminal investigation into Tether executives for bank fraud",
        url: "https://www.cnbc.com/2021/07/26/doj-reportedly-probes-crypto-company-tether-for-possible-bank-fraud.html",
      },
      {
        title: "Broad stablecoin depeg: 10 coins depegged simultaneously as market panicked",
        url: "https://fortune.com/2021/07/26/tether-crypto-bank-fraud-doj-investigation/",
      },
    ],
  },
  {
    date: Date.UTC(2022, 0, 21),
    dateEnd: Date.UTC(2022, 1, 8),
    label: "Fed Crash",
    position: "top" as const,
    links: [
      {
        title: "BTC crashed from $43K to $35K as Fed signaled aggressive rate hikes",
        url: "https://www.washingtonpost.com/business/2022/01/22/crypto-crash-bitcoin-fed/",
      },
      {
        title: "Chicago Fed retrospective on the crypto runs of 2022",
        url: "https://www.chicagofed.org/publications/chicago-fed-letter/2023/479",
      },
    ],
  },
  {
    date: Date.UTC(2022, 4, 7),
    dateEnd: Date.UTC(2022, 6, 1),
    label: "UST Collapse",
    position: "insideBottom" as const,
    links: [
      {
        title: "Terra/Luna algorithmic stablecoin death spiral wiped $45B",
        url: "https://www.coindesk.com/learn/the-fall-of-terra-a-timeline-of-the-meteoric-rise-and-crash-of-ust-and-luna/",
      },
    ],
  },
  {
    date: Date.UTC(2023, 2, 10),
    dateEnd: Date.UTC(2023, 2, 16),
    label: "SVB Weekend",
    position: "top" as const,
    links: [
      {
        title: "USDC depegged to $0.88 after $3.3B stuck in collapsed Silicon Valley Bank",
        url: "https://www.coindesk.com/markets/2023/03/11/usdc-depegs-from-dollar-stablecoin-drops-below-090/",
      },
    ],
  },
];

const PSI_EVENT_LABEL_CLASS =
  "[fill:var(--text-secondary)] [paint-order:stroke] [stroke:var(--surface-overlay)] [stroke-width:4px] font-medium";

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
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : { isAnimationActive: false };
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const handlePngExport = useCallback(() => {
    downloadChartPng(chartRef, "pharos-psi-history");
  }, []);
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const isMobile = useIsMobile();
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

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

    const result: ((typeof sorted)[number] & { hideLabel: boolean })[] = [];
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
    return events.map((e) => result.find((r) => r.label === e.label) ?? { ...e, hideLabel: true });
  }, [filteredData, excludeEvents]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      {showHeader && (
        <CardHeader>
          <CardTitle as="h2" className="min-w-0">
            Pharos Stability Index History
          </CardTitle>
          <CardAction className="flex min-w-0 items-center gap-2">
            <TimeRangeButtons
              options={options}
              value={range}
              onChange={(r) => {
                trackEvent("time_range_changed", { page: "stability-index-score", range: r });
                setRange(r);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={handlePngExport}
              title="Save chart as PNG"
              aria-label="Save chart as PNG"
            >
              <Camera className="h-4 w-4" />
            </Button>
          </CardAction>
        </CardHeader>
      )}
      <CardContent className={showHeader ? undefined : "px-4 pt-4 pb-2"}>
        {(() => {
          const chartHeight = showHeader ? "h-[250px] sm:h-[350px]" : "h-[250px] sm:h-[336px]";
          return filteredData.length > 0 ? (
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
              ref={chartContainerRef}
              className={`psi-chart ${chartHeight}`}
              role="figure"
              aria-label={`PSI score history chart showing ${filteredData.length} data points`}
            >
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
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
                        label={
                          isMobile || evt.hideLabel
                            ? undefined
                            : {
                                value: evt.label,
                                position: evt.position === "top" ? "insideTop" : "insideBottomLeft",
                                fontSize: 11,
                                className: PSI_EVENT_LABEL_CLASS,
                                ...(evt.position === "top" ? { dy: -20 } : {}),
                              }
                        }
                      />
                    ) : (
                      <ReferenceLine
                        key={evt.label}
                        x={evt.date}
                        stroke={CHART_SLATE}
                        strokeDasharray="4 4"
                        label={
                          isMobile || evt.hideLabel
                            ? undefined
                            : {
                                value: evt.label,
                                position: evt.position,
                                fontSize: 11,
                                className: PSI_EVENT_LABEL_CLASS,
                              }
                        }
                      />
                    ),
                  )}
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    minTickGap={72}
                  />
                  <MonoYAxis domain={[0, 100]} />
                  <DateTooltip
                    formatter={(value) => [Number(value).toFixed(1), "Score"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="score"
                    stroke={CHART_BLUE}
                    fill="url(#psiScoreGradient)"
                    strokeWidth={2}
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                </AreaChart>
              ) : (
                <ChartSkeleton className="h-full w-full" />
              )}
            </div>
          </div>
        ) : (
          <div className={`flex ${chartHeight} flex-col items-center justify-center text-muted-foreground`}>
            <p>No score history available</p>
            <p className="mt-1 text-xs text-muted-foreground/70">Score history builds over time as data is collected.</p>
          </div>
        );
        })()}
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

  return <ScoreChart data={chartData} excludeEvents={excludeEvents} showHeader={showHeader} />;
}
