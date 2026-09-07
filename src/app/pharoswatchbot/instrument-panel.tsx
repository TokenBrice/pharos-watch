"use client";

import { useId } from "react";
import Link from "next/link";
import { Area, AreaChart } from "recharts";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useCountUp } from "@/hooks/use-count-up";
import { Skeleton } from "@/components/ui/skeleton";
import { DAY_MS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";
import type { TelegramWatcherHistoryPoint } from "@shared/types/status";

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const MONTH_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});
const MONTH_ONLY_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
});
const DAY_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const PULSE_UPDATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatCount(value: number): string {
  return formatDecimal(value, 0, 3);
}

function formatMonthTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? MONTH_TICK_FORMATTER.format(new Date(timestamp)) : "";
}

function formatMonthOnlyTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? MONTH_ONLY_TICK_FORMATTER.format(new Date(timestamp)) : "";
}

function formatDayTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? DAY_TICK_FORMATTER.format(new Date(timestamp)) : "";
}

function formatSnapshotAt(value: number | null | undefined): string | null {
  if (!value) return null;
  return PULSE_UPDATED_FORMATTER.format(new Date(value * 1000));
}

function lifecycleRangeDays(data: TelegramWatcherHistoryPoint[]): number {
  const first = data[0]?.timestamp;
  const last = data.at(-1)?.timestamp;
  if (!first || !last) return 0;
  return Math.max(0, Math.round((last - first) / DAY_MS));
}

/** First-of-month tick positions across the series, at UTC noon so the label
    renders the intended month in every timezone. */
function monthBoundaryTicks(data: TelegramWatcherHistoryPoint[]): number[] | undefined {
  const first = data[0]?.timestamp;
  const last = data.at(-1)?.timestamp;
  if (!first || !last) return undefined;
  const cursor = new Date(first);
  cursor.setUTCDate(1);
  cursor.setUTCHours(12, 0, 0, 0);
  if (cursor.getTime() < first) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  const ticks: number[] = [];
  while (cursor.getTime() <= last) {
    ticks.push(cursor.getTime());
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks.length > 1 ? ticks : undefined;
}

function WatcherGrowthChart({ data }: { data: TelegramWatcherHistoryPoint[] }) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();
  const rawGradientId = useId();
  const gradientId = `night-watch-growth-${rawGradientId.replace(/:/g, "")}`;
  const rangeDays = lifecycleRangeDays(data);
  // Month-boundary ticks when the series spans ~4+ months: explicit monthly
  // positions (no duplicate month labels), month-only text when the whole
  // series sits in one calendar year, year suffix when it crosses years.
  const monthMode = rangeDays > 120;
  const monthTicks = monthMode ? monthBoundaryTicks(data) : undefined;
  const spansYears =
    data.length > 1 &&
    new Date(data[0].timestamp).getUTCFullYear() !==
      new Date(data[data.length - 1].timestamp).getUTCFullYear();
  const tickFormatter = monthMode ? (spansYears ? formatMonthTick : formatMonthOnlyTick) : formatDayTick;
  const singlePointTimestamp = data.length === 1 ? data[0]?.timestamp : undefined;
  const domain = singlePointTimestamp
    ? ([singlePointTimestamp - 14 * DAY_MS, singlePointTimestamp + 14 * DAY_MS] as [number, number])
    : (["dataMin", "dataMax"] as const);

  return (
    <div
      ref={ref}
      className="mt-4 h-[210px] sm:h-[260px]"
      role="figure"
      aria-label={`Telegram chat lifecycle chart with ${data.length} daily points`}
    >
      {ready ? (
        <AreaChart width={width} height={height} data={data} margin={{ top: 10, right: 10, bottom: 22, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--brand-accent)" stopOpacity={0.34} />
              <stop offset="95%" stopColor="var(--brand-accent)" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <TimeGrid />
          <TimeXAxis dataKey="timestamp" domain={domain} minTickGap={56} tickFormatter={tickFormatter} ticks={monthTicks} />
          <MonoYAxis
            width={42}
            allowDecimals={false}
            tickFormatter={(value) => COMPACT_NUMBER_FORMATTER.format(Number(value))}
          />
          <DateTooltip formatter={(value, name) => [formatCount(Number(value)), String(name)]} />
          <Area
            type="monotone"
            dataKey="activeWatchers"
            name={TELEGRAM_METRIC_SEMANTICS.activeWatchers.label}
            stroke="var(--brand-accent)"
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            dot={data.length === 1 ? { r: 3, strokeWidth: 2 } : false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      ) : null}
    </div>
  );
}

function PanelLoading() {
  return (
    <div role="status" aria-label="Loading Telegram adoption metrics" aria-live="polite" aria-busy="true" className="mt-10 space-y-8">
      <div className="grid gap-x-8 gap-y-10 lg:grid-cols-3">
        <Skeleton className="h-28 lg:col-span-2" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-[260px]" />
    </div>
  );
}

/**
 * Act III — 02:13, live adoption. Aggregate counts from the bot itself,
 * presented as a watch-floor board: one dominant figure, supporting reads,
 * the lifecycle chart. Public adoption metrics only — no operational counts,
 * no per-chat anything (privacy contract).
 */
export function InstrumentPanel() {
  const { data, isLoading, isError } = useTelegramPulse();
  const watchers = useCountUp(data?.activeWatchers ?? null);
  const follows = useCountUp(data?.coinSubscriptions ?? null);

  return (
    <section id="panel" className="pharos-night-slate scroll-mt-20" aria-labelledby="panel-title">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24 lg:px-5 xl:px-9">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="max-w-2xl">
            <h2 id="panel-title" className="pharos-display text-foreground">
              Live adoption
            </h2>
            <p className="pharos-lead mt-3">
              Live, aggregate counts from the bot itself, refreshed every five minutes. Adoption telemetry only —
              nothing operational, nothing individual.
            </p>
          </div>
          {data ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
                data.quality?.status === "partial"
                  ? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
                  : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
              )}
            >
              {data.quality?.status === "partial" ? "Partial telemetry" : "Complete telemetry"}
            </span>
          ) : null}
        </div>

        {isLoading ? <PanelLoading /> : null}

        {!isLoading && (!data || isError) ? (
          <div role="status" aria-label="Telegram adoption metrics unavailable" aria-live="polite" aria-busy="false" className="mt-10">
            <p className="border-t border-border/55 pt-6 text-sm text-muted-foreground">
              Public Telegram adoption metrics are temporarily unavailable. They retry automatically; bot links and
              setup commands keep working.
            </p>
          </div>
        ) : null}

        {!isLoading && data ? (
          <>
            {data.quality?.status === "partial" ? (
              <p className="mt-6 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                Some public Telegram telemetry is temporarily unavailable. Counts shown here keep working where source
                data is complete.
              </p>
            ) : null}

            <dl className="mt-10 grid gap-x-8 gap-y-10 lg:grid-cols-3">
              <div className="border-t border-border/55 pt-5 lg:col-span-2">
                <dt className="pharos-kicker !tracking-normal" title={TELEGRAM_METRIC_SEMANTICS.activeWatchers.description}>
                  {TELEGRAM_METRIC_SEMANTICS.activeWatchers.label}
                </dt>
                <dd className="mt-3 flex items-baseline gap-3">
                  <span aria-hidden="true" className="relative flex h-2.5 w-2.5 self-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand-accent)]" />
                  </span>
                  <span aria-hidden="true" className="pharos-numeric text-5xl font-semibold leading-none tracking-tight text-frost-blue">
                    {watchers.display ?? "—"}
                  </span>
                  {watchers.value != null ? (
                    <span className="sr-only">{formatCount(watchers.value)} active watchers</span>
                  ) : null}
                </dd>
                <dd className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                  {[
                    { label: "New today", value: data.newWatchersToday },
                    { label: "Reactivated today", value: data.reactivatedWatchersToday },
                    { label: "Churned today", value: data.churnedWatchersToday },
                  ]
                    .filter((item): item is { label: string; value: number } => typeof item.value === "number")
                    .map((item) => (
                      <span key={item.label} className="flex items-baseline gap-2 text-xs text-muted-foreground">
                        <span className="pharos-numeric text-sm font-semibold text-foreground">
                          {formatCount(item.value)}
                        </span>
                        {item.label}
                      </span>
                    ))}
                </dd>
              </div>

              <div className="border-t border-border/55 pt-5">
                <dt className="pharos-kicker !tracking-normal" title={TELEGRAM_METRIC_SEMANTICS.coinFollows.description}>
                  {TELEGRAM_METRIC_SEMANTICS.coinFollows.label}
                </dt>
                <dd className="mt-3 pharos-numeric text-3xl font-semibold leading-none text-foreground">
                  {follows.display ?? "—"}
                </dd>
                <dd className="mt-3 text-xs text-muted-foreground">
                  {formatCount(data.explicitCoinSubscriptions ?? data.coinSubscriptions)} explicit ·{" "}
                  {formatCount(data.presetImpliedCoinSubscriptions ?? 0)} preset-implied
                </dd>
                {typeof data.activePresetFollowers === "number" ? (
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {formatCount(data.activePresetFollowers)} chats using presets
                  </dd>
                ) : null}
              </div>

              <div className="border-t border-border/55 pt-5">
                <dt className="pharos-kicker !tracking-normal">Most followed</dt>
                <dd className="mt-3">
                  {data.topCoins.length > 0 ? (
                    <ol className="flex flex-wrap items-center gap-1.5">
                      {data.topCoins.slice(0, 5).map((coin, index) => (
                        <li
                          key={coin}
                          className="inline-flex items-center gap-1.5 rounded-md bg-muted/45 px-2.5 py-1.5 pharos-numeric text-[13px] font-semibold text-foreground"
                        >
                          <span aria-hidden="true" className="text-[10px] font-medium text-muted-foreground">
                            {index + 1}
                          </span>
                          {coin}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-xs text-muted-foreground">No ranked follows yet.</p>
                  )}
                </dd>
              </div>

              <div className="border-t border-border/55 pt-5 lg:col-span-2">
                <dt className="pharos-kicker !tracking-normal">Current snapshot</dt>
                <dd className="mt-3 font-mono text-sm font-semibold text-foreground">
                  {formatSnapshotAt(data.currentSnapshotAt ?? data.updatedAt) ?? "every 5m"}
                </dd>
                <dd className="mt-2 text-xs text-muted-foreground">
                  Refresh target: every {Math.round((data.updatedEverySeconds ?? 300) / 60)} minutes · Aggregate
                  counts; small daily changes are hidden to protect individual chats.
                </dd>
              </div>
            </dl>

            <div className="mt-12 border-t border-border/55 pt-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <p className="pharos-kicker !tracking-normal">Telegram chat lifecycle</p>
                {data.watcherHistory.length > 0 ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    latest daily snapshot{" "}
                    <span className="font-semibold text-foreground">
                      {formatCount(data.watcherHistory.at(-1)?.activeWatchers ?? 0)}
                    </span>
                    {formatSnapshotAt(data.lifecycleHistoryUpdatedAt) ? (
                      <span> · {formatSnapshotAt(data.lifecycleHistoryUpdatedAt)}</span>
                    ) : null}
                  </p>
                ) : null}
              </div>
              {data.watcherHistory.length > 0 ? (
                <WatcherGrowthChart data={data.watcherHistory} />
              ) : (
                <div className="mt-4 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
                  Historical watcher points will appear once subscription telemetry is available.
                </div>
              )}
              <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
                Operational service health lives on the{" "}
                <Link
                  href="/status/"
                  className="pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  status page
                </Link>
                .
              </p>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
