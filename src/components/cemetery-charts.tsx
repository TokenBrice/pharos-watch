"use client";

import { useMemo } from "react";
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
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { DEAD_STABLECOINS, CAUSE_META, CAUSE_HEX } from "@shared/lib/dead-stablecoins";
import { CHART_RED, CHART_BLUE, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { formatCurrency } from "@shared/lib/format";
import type { CauseOfDeath } from "@shared/types";

/* ── Custom tooltip shell ── */

function ChartTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-md text-sm"
      style={{
        backgroundColor: RECHARTS_TOOLTIP_STYLES.contentStyle.backgroundColor,
        borderColor: "var(--color-border)",
        borderRadius: RECHARTS_TOOLTIP_STYLES.contentStyle.borderRadius,
        fontFamily: RECHARTS_TOOLTIP_STYLES.contentStyle.fontFamily,
      }}
    >
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   1a. Cause of Death (by Count) — Donut Chart
   ══════════════════════════════════════════════════════════════════════ */

function CauseOfDeathByCountChart() {
  const data = useMemo(() => {
    const counts = new Map<CauseOfDeath, number>();
    for (const coin of DEAD_STABLECOINS) {
      counts.set(coin.causeOfDeath, (counts.get(coin.causeOfDeath) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([cause, count]) => ({
      name: CAUSE_META[cause].label,
      value: count,
      cause,
    }));
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cause of Death (by Count)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            aria-label="Cause of death distribution by count"
          >
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={95}
                dataKey="value"
                nameKey="name"
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((d) => (
                  <Cell key={d.cause} fill={CAUSE_HEX[d.cause]} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as (typeof data)[0];
                  return (
                    <ChartTooltip>
                      <p className="font-semibold" style={{ color: CAUSE_HEX[d.cause] }}>
                        {d.name}
                      </p>
                      <p className="font-mono tabular-nums">
                        {d.value} stablecoin{d.value !== 1 ? "s" : ""}{" "}
                        <span className="text-muted-foreground">
                          ({((d.value / DEAD_STABLECOINS.length) * 100).toFixed(0)}%)
                        </span>
                      </p>
                    </ChartTooltip>
                  );
                }}
              />
              <Legend iconType="circle" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   1b. Cause of Death (by Peak Mcap) — Donut Chart
   ══════════════════════════════════════════════════════════════════════ */

function CauseOfDeathByMcapChart() {
  const { data, total } = useMemo(() => {
    const mcaps = new Map<CauseOfDeath, number>();
    for (const coin of DEAD_STABLECOINS) {
      if (coin.peakMcap) {
        mcaps.set(coin.causeOfDeath, (mcaps.get(coin.causeOfDeath) ?? 0) + coin.peakMcap);
      }
    }
    const total = Array.from(mcaps.values()).reduce((s, v) => s + v, 0);
    const data = Array.from(mcaps.entries()).map(([cause, mcap]) => ({
      name: CAUSE_META[cause].label,
      value: mcap,
      cause,
    }));
    return { data, total };
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cause of Death (by Peak Mcap)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            aria-label="Cause of death distribution by peak market cap"
          >
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={95}
                dataKey="value"
                nameKey="name"
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((d) => (
                  <Cell key={d.cause} fill={CAUSE_HEX[d.cause]} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as (typeof data)[0];
                  return (
                    <ChartTooltip>
                      <p className="font-semibold" style={{ color: CAUSE_HEX[d.cause] }}>
                        {d.name}
                      </p>
                      <p className="font-mono tabular-nums">
                        {formatCurrency(d.value, 1)}{" "}
                        <span className="text-muted-foreground">({((d.value / total) * 100).toFixed(0)}%)</span>
                      </p>
                    </ChartTooltip>
                  );
                }}
              />
              <Legend iconType="circle" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   2. Deaths per Year — Grouped Bar Chart (count + peak mcap)
   ══════════════════════════════════════════════════════════════════════ */

function DeathsByYearChart() {
  const data = useMemo(() => {
    const byYear = new Map<number, { count: number; mcap: number }>();
    for (const coin of DEAD_STABLECOINS) {
      const year = Number(coin.deathDate.split("-")[0]);
      const entry = byYear.get(year) ?? { count: 0, mcap: 0 };
      entry.count += 1;
      if (coin.peakMcap) entry.mcap += coin.peakMcap;
      byYear.set(year, entry);
    }
    return Array.from(byYear.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([year, d]) => ({ year: String(year), count: d.count, mcap: d.mcap }));
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Deaths per Year
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            aria-label="Stablecoin deaths per year"
          >
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
                  if (!active || !payload?.length) return null;
                  return (
                    <ChartTooltip>
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
                        <span className="font-mono tabular-nums">
                          {formatCurrency(Number(payload[1]?.value ?? 0), 1)}
                        </span>
                      </div>
                    </ChartTooltip>
                  );
                }}
              />
              <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="left" dataKey="count" name="Deaths" fill={CHART_RED} radius={[3, 3, 0, 0]} />
              <Bar yAxisId="right" dataKey="mcap" name="Peak Mcap" fill={CHART_BLUE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   3. Top 10 Largest Failures — Horizontal Bar Chart
   ══════════════════════════════════════════════════════════════════════ */

function TopFailuresChart() {
  const data = useMemo(() => {
    return DEAD_STABLECOINS.filter((c) => c.peakMcap != null)
      .sort((a, b) => (b.peakMcap ?? 0) - (a.peakMcap ?? 0))
      .slice(0, 10)
      .map((c) => ({
        name: c.symbol,
        mcap: c.peakMcap!,
        cause: c.causeOfDeath,
      }));
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Largest Failures by Peak Mcap
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            aria-label="Top 10 largest stablecoin failures"
          >
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
                tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)" }}
                tickLine={false}
                axisLine={false}
                width={60}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as (typeof data)[0];
                  return (
                    <ChartTooltip>
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
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   4. Cumulative Value Destroyed — Area Chart
   ══════════════════════════════════════════════════════════════════════ */

function CumulativeDestroyedChart() {
  const data = useMemo(() => {
    const sorted = DEAD_STABLECOINS.filter((c) => c.peakMcap != null).sort((a, b) => {
      // Sort by date, then by mcap descending for same date
      if (a.deathDate === b.deathDate) return (b.peakMcap ?? 0) - (a.peakMcap ?? 0);
      return a.deathDate.localeCompare(b.deathDate);
    });

    return sorted.reduce<{ date: string; cumulative: number; symbol: string; added: number }[]>((acc, c) => {
      const cumulative = (acc[acc.length - 1]?.cumulative ?? 0) + c.peakMcap!;
      const [y, m] = c.deathDate.split("-");
      const date = new Date(Number(y), Number(m || 1) - 1);
      const label = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      return [...acc, { date: label, cumulative, symbol: c.symbol, added: c.peakMcap! }];
    }, []);
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cumulative Peak Value Destroyed
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            aria-label="Cumulative peak value destroyed over time"
          >
            <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
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
                interval={Math.max(0, Math.floor(data.length / 8))}
              />
              <YAxis
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
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as (typeof data)[0];
                  return (
                    <ChartTooltip>
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
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Combined export
   ══════════════════════════════════════════════════════════════════════ */

export function CemeteryCharts() {
  const mounted = useHydrated();

  if (!mounted) {
    return (
      <div className="grid grid-cols-2 gap-3 md:gap-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} className="rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Loading chart
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ChartSkeleton className="h-[250px] sm:h-[350px]" />
            </CardContent>
          </Card>
        ))}
        <Card className="col-span-2 rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Loading chart
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartSkeleton className="h-[250px] sm:h-[350px]" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:gap-4">
      <CauseOfDeathByCountChart />
      <CauseOfDeathByMcapChart />
      <DeathsByYearChart />
      <TopFailuresChart />
      <div className="col-span-2">
        <CumulativeDestroyedChart />
      </div>
    </div>
  );
}
