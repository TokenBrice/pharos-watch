"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  AreaChart,
  Area,
  ReferenceDot,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { ChartLegendChip } from "@/components/chart-primitives/axes";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { CAUSE_META, CAUSE_HEX } from "@shared/lib/dead-stablecoins";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CHART_RED, CHART_BLUE, CHART_SLATE, CHART_HEIGHT } from "@/lib/chart-colors";
import { PharosChartTooltip } from "@/components/pharos-chart-tooltip";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import type { CauseOfDeath } from "@shared/types";

/* ── Custom tooltip shell ── */

function ChartTooltip({ active, children }: { active?: boolean; children: ReactNode }) {
  return (
    <PharosChartTooltip active={active}>
      {children}
    </PharosChartTooltip>
  );
}

function CemeteryChartCard({ title, ariaLabel, children }: { title: string; ariaLabel?: string; children: ReactNode }) {
  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={CHART_HEIGHT} role={ariaLabel ? "figure" : undefined} aria-label={ariaLabel}>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

type CauseOfDeathDonutDatum = {
  name: string;
  value: number;
  cause: CauseOfDeath;
};

type CemeteryEntries = readonly CemeteryEntry[];

function CauseOfDeathDonutChart({
  title,
  ariaLabel,
  data,
  total,
  formatValue,
}: {
  title: string;
  ariaLabel: string;
  data: CauseOfDeathDonutDatum[];
  total: number;
  formatValue: (datum: CauseOfDeathDonutDatum, total: number) => ReactNode;
}) {
  return (
    <CemeteryChartCard title={title} ariaLabel={ariaLabel}>
      <div className="flex h-full flex-col">
        <div className="mb-2 flex flex-wrap gap-2">
          {data.map((datum) => (
            <ChartLegendChip key={datum.cause} markerStyle={{ backgroundColor: CAUSE_HEX[datum.cause] }}>
              {datum.name}
            </ChartLegendChip>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius="35%"
                outerRadius="60%"
                dataKey="value"
                nameKey="name"
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((datum) => (
                  <Cell key={datum.cause} fill={CAUSE_HEX[datum.cause]} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!payload?.[0]) return null;
                  const datum = payload[0].payload as CauseOfDeathDonutDatum;
                  return (
                    <ChartTooltip active={active}>
                      <p className="font-semibold" style={{ color: CAUSE_HEX[datum.cause] }}>
                        {datum.name}
                      </p>
                      <div className="font-mono tabular-nums">{formatValue(datum, total)}</div>
                    </ChartTooltip>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </CemeteryChartCard>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   1a. Cause of Death (by Count) — Donut Chart
   ══════════════════════════════════════════════════════════════════════ */

function CauseOfDeathByCountChart({ entries }: { entries: CemeteryEntries }) {
  const { data, total } = useMemo(() => {
    const counts = new Map<CauseOfDeath, number>();
    for (const coin of entries) {
      counts.set(coin.causeOfDeath, (counts.get(coin.causeOfDeath) ?? 0) + 1);
    }
    return {
      data: Array.from(counts.entries()).map(([cause, count]) => ({
        name: CAUSE_META[cause].label,
        value: count,
        cause,
      })),
      total: entries.length,
    };
  }, [entries]);

  return (
    <CauseOfDeathDonutChart
      title="Cause of Death (by Count)"
      ariaLabel="Cause of death distribution by count"
      data={data}
      total={total}
      formatValue={(datum, countTotal) => (
        <>
          {datum.value} stablecoin{datum.value !== 1 ? "s" : ""}{" "}
          <span className="text-muted-foreground">({((datum.value / countTotal) * 100).toFixed(0)}%)</span>
        </>
      )}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════
   1b. Cause of Death (by Peak Mcap) — Donut Chart
   ══════════════════════════════════════════════════════════════════════ */

function CauseOfDeathByMcapChart({ entries }: { entries: CemeteryEntries }) {
  const { data, total } = useMemo(() => {
    const mcaps = new Map<CauseOfDeath, number>();
    for (const coin of entries) {
      if (coin.peakMcap) {
        mcaps.set(coin.causeOfDeath, (mcaps.get(coin.causeOfDeath) ?? 0) + coin.peakMcap);
      }
    }
    return {
      data: Array.from(mcaps.entries()).map(([cause, mcap]) => ({
        name: CAUSE_META[cause].label,
        value: mcap,
        cause,
      })),
      total: Array.from(mcaps.values()).reduce((sum, value) => sum + value, 0),
    };
  }, [entries]);

  return (
    <CauseOfDeathDonutChart
      title="Cause of Death (by Peak Mcap)"
      ariaLabel="Cause of death distribution by peak market cap"
      data={data}
      total={total}
      formatValue={(datum, mcapTotal) => (
        <>
          {formatCurrency(datum.value, 1)}{" "}
          <span className="text-muted-foreground">({((datum.value / mcapTotal) * 100).toFixed(0)}%)</span>
        </>
      )}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════
   2. Deaths per Year — Grouped Bar Chart (count + peak mcap)
   ══════════════════════════════════════════════════════════════════════ */

function DeathsByYearChart({ entries }: { entries: CemeteryEntries }) {
  const data = useMemo(() => {
    const byYear = new Map<number, { count: number; mcap: number }>();
    for (const coin of entries) {
      const year = Number(coin.deathDate.split("-")[0]);
      const entry = byYear.get(year) ?? { count: 0, mcap: 0 };
      entry.count += 1;
      if (coin.peakMcap) entry.mcap += coin.peakMcap;
      byYear.set(year, entry);
    }
    return Array.from(byYear.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([year, d]) => ({ year: String(year), count: d.count, mcap: d.mcap }));
  }, [entries]);

  return (
    <CemeteryChartCard title="Deaths per Year" ariaLabel="Stablecoin deaths per year">
      <div className="flex h-full flex-col">
        <div className="mb-2 flex flex-wrap gap-2">
          <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_RED }}>
            Deaths
          </ChartLegendChip>
          <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm" markerStyle={{ backgroundColor: CHART_BLUE }}>
            Peak Mcap
          </ChartLegendChip>
        </div>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <BarChart data={data} barGap={4} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="year"
                tick={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatCurrency(v, 0)}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!payload?.length) return null;
                  return (
                    <ChartTooltip active={active}>
                      <p className="font-semibold mb-1">{label}</p>
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART_RED }} />
                          <span>Deaths</span>
                        </div>
                        <span className="font-mono tabular-nums">{payload[0]?.value}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART_BLUE }} />
                          <span>Peak Mcap</span>
                        </div>
                        <span className="font-mono tabular-nums">{formatCurrency(Number(payload[1]?.value ?? 0), 1)}</span>
                      </div>
                    </ChartTooltip>
                  );
                }}
              />
              <Bar yAxisId="left" dataKey="count" name="Deaths" fill={CHART_RED} radius={[3, 3, 0, 0]} />
              <Bar yAxisId="right" dataKey="mcap" name="Peak Mcap" fill={CHART_BLUE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </CemeteryChartCard>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   3. Top 10 Largest Failures — Horizontal Bar Chart
   ══════════════════════════════════════════════════════════════════════ */

function TopFailuresChart({ entries }: { entries: CemeteryEntries }) {
  const data = useMemo(() => {
    return entries.filter((c) => c.peakMcap != null)
      .sort((a, b) => (b.peakMcap ?? 0) - (a.peakMcap ?? 0))
      .slice(0, 10)
      .map((c) => ({
        name: c.symbol,
        mcap: c.peakMcap!,
        cause: c.causeOfDeath,
      }));
  }, [entries]);

  return (
    <CemeteryChartCard title="Largest Failures by Peak Mcap" ariaLabel="Top 10 largest stablecoin failures">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{
              fontSize: 12,
              fontFamily: "var(--font-mono, monospace)",
              fill: "var(--color-muted-foreground)",
            }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatCurrency(v, 0)}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={60}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!payload?.[0]) return null;
              const d = payload[0].payload as (typeof data)[0];
              return (
                <ChartTooltip active={active}>
                  <p className="font-semibold">{d.name}</p>
                  <p className="font-mono tabular-nums">{formatCurrency(d.mcap, 1)}</p>
                  <p style={{ color: CAUSE_HEX[d.cause] }}>{CAUSE_META[d.cause].label}</p>
                </ChartTooltip>
              );
            }}
          />
          <Bar dataKey="mcap" radius={[0, 4, 4, 0]}>
            {data.map((d) => (
              <Cell key={d.name} fill={CAUSE_HEX[d.cause]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </CemeteryChartCard>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   4. Cumulative Value Destroyed — Area Chart
   ══════════════════════════════════════════════════════════════════════ */

type CumulativePoint = {
  date: string;
  cumulative: number;
  symbol: string;
  added: number;
  index: number;
};

/**
 * Filter inflection labels so they don't overlap when projected onto the
 * x-axis. Mirrors the `buildVisiblePsiChartEvents` collision pattern: walk
 * candidates in priority order, drop any whose index falls within
 * `minIndexGap` of an already-shown label.
 */
function filterCollidingInflections(
  candidates: readonly CumulativePoint[],
  total: number,
  minIndexGap: number,
): CumulativePoint[] {
  const shown: CumulativePoint[] = [];
  // Walk in array order (already priority-sorted by `added` desc).
  for (const point of candidates) {
    const collides = shown.some((s) => Math.abs(s.index - point.index) < minIndexGap);
    if (!collides) shown.push(point);
    if (shown.length >= 6) break;
  }
  // Always ensure the very last point gets a label if it isn't already shown,
  // to anchor the "today" total.
  if (total > 0) {
    const last = candidates.find((c) => c.index === total - 1);
    if (last && !shown.some((s) => s.index === last.index)) {
      const collides = shown.some((s) => Math.abs(s.index - last.index) < minIndexGap);
      if (!collides) shown.push(last);
    }
  }
  return shown.sort((a, b) => a.index - b.index);
}

function CumulativeDestroyedChart({ entries }: { entries: CemeteryEntries }) {
  const [logScale, setLogScale] = useState(false);

  const data = useMemo<CumulativePoint[]>(() => {
    const sorted = entries.filter((c) => c.peakMcap != null).sort((a, b) => {
      // Sort by date, then by mcap descending for same date
      if (a.deathDate === b.deathDate) return (b.peakMcap ?? 0) - (a.peakMcap ?? 0);
      return a.deathDate.localeCompare(b.deathDate);
    });

    return sorted.reduce<CumulativePoint[]>((acc, c, index) => {
      const cumulative = (acc[acc.length - 1]?.cumulative ?? 0) + c.peakMcap!;
      const [y, m] = c.deathDate.split("-");
      const date = new Date(Number(y), Number(m || 1) - 1);
      const label = formatChartDate(date.getTime(), "compact");
      acc.push({ date: label, cumulative, symbol: c.symbol, added: c.peakMcap!, index });
      return acc;
    }, []);
  }, [entries]);

  // Inflection labels: top-N points by `added` (the size of the jump), then
  // collision-filtered so labels don't pile on top of each other on the
  // x-axis. Min gap scales with series length so dense periods stay readable.
  const inflectionPoints = useMemo<CumulativePoint[]>(() => {
    if (data.length === 0) return [];
    const byAdded = [...data].sort((a, b) => b.added - a.added);
    const minIndexGap = Math.max(2, Math.floor(data.length / 10));
    return filterCollidingInflections(byAdded, data.length, minIndexGap);
  }, [data]);

  // For log scale, replace zero/negative cumulative values (none expected
  // here but defensive) with 1 so the axis stays well-defined.
  const chartData = useMemo<CumulativePoint[]>(() => {
    if (!logScale) return data;
    return data.map((d) => ({ ...d, cumulative: Math.max(d.cumulative, 1) }));
  }, [data, logScale]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
        <CardTitle as="h2" className="pharos-kicker">
          Cumulative Peak Value Destroyed
        </CardTitle>
        <CardAction>
          <ScaleToggle value={logScale ? "log" : "lin"} onChange={(v) => setLogScale(v === "log")} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div
          className={CHART_HEIGHT}
          role="figure"
          aria-label="Cumulative peak value destroyed over time"
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <AreaChart data={chartData} margin={{ top: 24, right: 12, bottom: 20, left: 5 }}>
              <defs>
                <linearGradient id="destroyedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_RED} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_RED} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
                interval={Math.max(0, Math.floor(chartData.length / 8))}
              />
              <YAxis
                scale={logScale ? "log" : "linear"}
                domain={logScale ? [1, "dataMax"] : [0, "auto"]}
                allowDataOverflow={logScale}
                tick={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatCurrency(v, 0)}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!payload?.[0]) return null;
                  const d = payload[0].payload as CumulativePoint;
                  return (
                    <ChartTooltip active={active}>
                      <p className="font-semibold">{d.symbol}</p>
                      <p className="text-muted-foreground text-xs">{d.date}</p>
                      <p className="font-mono tabular-nums">+{formatCurrency(d.added, 1)}</p>
                      <p className="font-mono tabular-nums text-red-700 dark:text-red-400">
                        Total: {formatCurrency(d.cumulative, 1)}
                      </p>
                    </ChartTooltip>
                  );
                }}
              />
              <Area
                type="stepAfter"
                dataKey="cumulative"
                stroke={CHART_RED}
                strokeWidth={2}
                fill="url(#destroyedGradient)"
              />
              {inflectionPoints.map((p) => (
                <ReferenceDot
                  key={`${p.symbol}-${p.index}`}
                  x={p.date}
                  y={logScale ? Math.max(p.cumulative, 1) : p.cumulative}
                  r={3}
                  fill={CHART_SLATE}
                  stroke="var(--surface-overlay)"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                  label={{
                    value: p.symbol,
                    position: "top",
                    fontSize: 11,
                    className:
                      "[fill:var(--text-secondary)] [paint-order:stroke] [stroke:var(--surface-overlay)] [stroke-width:4px] font-medium",
                    dy: -4,
                  }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ScaleToggle({ value, onChange }: { value: "lin" | "log"; onChange: (v: "lin" | "log") => void }) {
  const baseBtn =
    "pharos-focus-ring h-7 min-w-8 rounded-sm px-2 text-[11px] font-mono uppercase tracking-wide transition-colors";
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5">
      {(["lin", "log"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
          className={cn(
            baseBtn,
            value === opt
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Combined export
   ══════════════════════════════════════════════════════════════════════ */

export function CemeteryCharts({ entries }: { entries: CemeteryEntries }) {
  const mounted = useHydrated();

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">
        {Array.from({ length: 4 }, (_, index) => (
          <CemeteryChartCard key={index} title="Loading chart">
            <ChartSkeleton className="h-full w-full" />
          </CemeteryChartCard>
        ))}
        <div className="sm:col-span-2">
          <CemeteryChartCard title="Loading chart">
            <ChartSkeleton className="h-full w-full" />
          </CemeteryChartCard>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">
      <CauseOfDeathByCountChart entries={entries} />
      <CauseOfDeathByMcapChart entries={entries} />
      <DeathsByYearChart entries={entries} />
      <TopFailuresChart entries={entries} />
      <div className="sm:col-span-2">
        <CumulativeDestroyedChart entries={entries} />
      </div>
    </div>
  );
}
