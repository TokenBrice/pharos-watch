"use client";

import { Area, AreaChart } from "recharts";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { TelegramWatcherHistoryPoint } from "@shared/types/status";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const MONTH_TICK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});
const PULSE_UPDATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const TELEGRAM_ESTIMATED_CAPACITY_WATCHERS = 5_000;

function formatCount(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatCompactCount(value: number): string {
  return COMPACT_NUMBER_FORMATTER.format(value);
}

function formatMonthTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return MONTH_TICK_FORMATTER.format(new Date(timestamp));
}

function formatUpdatedAt(value: number | undefined): string {
  if (!value) return "updated every 5m";
  return `updated ${PULSE_UPDATED_FORMATTER.format(new Date(value * 1000))}`;
}

function formatSnapshotAt(value: number | null | undefined): string | null {
  if (!value) return null;
  return PULSE_UPDATED_FORMATTER.format(new Date(value * 1000));
}

function formatCapacityUsage(activeWatchers: number): string {
  return `${Math.round((activeWatchers / TELEGRAM_ESTIMATED_CAPACITY_WATCHERS) * 100)}% used`;
}

function TelegramWatcherGrowthChart({ data }: { data: TelegramWatcherHistoryPoint[] }) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className="mt-4 h-[180px] sm:h-[220px]"
      role="figure"
      aria-label={`All-time Telegram watcher growth chart with ${data.length} daily points`}
    >
      {ready ? (
        <AreaChart width={width} height={height} data={data} margin={{ top: 8, right: 8, bottom: 18, left: 0 }}>
          <defs>
            <linearGradient id="telegramWatcherGrowthGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--brand-accent)" stopOpacity={0.28} />
              <stop offset="95%" stopColor="var(--brand-accent)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <TimeGrid />
          <TimeXAxis dataKey="timestamp" minTickGap={64} tickFormatter={formatMonthTick} />
          <MonoYAxis width={42} allowDecimals={false} tickFormatter={(value) => formatCompactCount(Number(value))} />
          <DateTooltip formatter={(value, name) => [formatCount(Number(value)), String(name)]} />
          <Area
            type="monotone"
            dataKey="activeWatchers"
            name="Active Telegram chats"
            stroke="var(--brand-accent)"
            fill="url(#telegramWatcherGrowthGrad)"
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

export function TelegramPulseStrip() {
  const { data, isLoading, isError } = useTelegramPulse();

  if (isLoading) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <Skeleton className="h-3.5 w-20 sm:w-24" />
        <Skeleton className="h-3.5 w-24 sm:w-28" />
        <Skeleton className="hidden h-3.5 w-28 sm:block" />
      </div>
    );
  }

  if (!data || isError) {
    return <p className="text-xs text-muted-foreground">Telegram adoption metrics unavailable; commands still work.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs tabular-nums">
      <span className="text-muted-foreground">
        <span className="font-semibold text-foreground font-mono">{formatCount(data.activeWatchers)}</span> active
        Telegram chats
      </span>
      <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
      <span className="text-muted-foreground">
        <span className="font-semibold text-foreground font-mono">
          {formatCount(TELEGRAM_ESTIMATED_CAPACITY_WATCHERS)}
        </span>{" "}
        estimated capacity
      </span>
      <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
      <span className="text-muted-foreground">
        <span className="font-semibold text-foreground font-mono">{formatCount(data.coinSubscriptions)}</span> alert
        follows
      </span>
      <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
      <span className="text-muted-foreground">
        updated every {Math.round((data.updatedEverySeconds ?? 300) / 60)}m
      </span>
      {data.topCoins.length > 0 && (
        <>
          <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
          <span className="text-muted-foreground">
            most followed:{" "}
            <span className="font-medium text-foreground">{data.topCoins.slice(0, 3).join(", ")}</span>
          </span>
        </>
      )}
    </div>
  );
}

export function TelegramPulseBoard({ className }: { className?: string }) {
  const { data, isLoading, isError } = useTelegramPulse();

  if (isLoading) {
    return (
      <section
        className={cn("space-y-6", className)}
        aria-label="Loading Telegram adoption metrics"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border/55 pb-4">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-border" aria-hidden="true" />
            <Skeleton className="h-6 w-32 sm:h-7 sm:w-40" />
          </div>
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-x-8">
          <Skeleton className="h-24 sm:h-28" />
          <Skeleton className="h-24 sm:h-28" />
          <Skeleton className="h-24 sm:h-28" />
        </div>
      </section>
    );
  }

  if (!data || isError) {
    return (
      <section className={cn("space-y-3", className)} aria-label="Telegram adoption metrics unavailable">
        <div className="flex items-center gap-3 border-b border-border/55 pb-4">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-muted-foreground/40" />
          <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Telegram pulse</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Live Telegram adoption metrics are temporarily unavailable. They retry automatically; bot links and setup
          commands still work.
        </p>
      </section>
    );
  }

  const topCoins = data.topCoins.slice(0, 5);
  const watcherHistory = data.watcherHistory ?? [];
  const latestHistoryPoint = watcherHistory.at(-1) ?? null;
  const latestHistoryLabel = data.historySource === "snapshot"
    ? formatSnapshotAt(data.lifecycleHistoryUpdatedAt)
    : null;
  const alertTypeChats = data.alertTypeChats;
  const telemetryItems = [
    {
      label: "Explicit follows",
      value: data.explicitCoinSubscriptions,
    },
    {
      label: "Preset-implied",
      value: data.presetImpliedCoinSubscriptions,
    },
    {
      label: "Preset followers",
      value: data.activePresetFollowers,
    },
    {
      label: "New today",
      value: data.newWatchersToday,
    },
    {
      label: "Reactivated today",
      value: data.reactivatedWatchersToday,
    },
    {
      label: "Churned today",
      value: data.churnedWatchersToday,
    },
    {
      label: "DEWS chats",
      value: alertTypeChats?.dews,
    },
    {
      label: "Depeg chats",
      value: alertTypeChats?.depeg,
    },
    {
      label: "Safety chats",
      value: alertTypeChats?.safety,
    },
    {
      label: "Launch chats",
      value: alertTypeChats?.launch,
    },
    {
      label: "All alert families",
      value: alertTypeChats?.allTypes,
    },
    {
      label: "Quiet hours enabled",
      value: data.quietHoursEnabledChats,
    },
    {
      label: "Queued deliveries",
      value: data.pendingDeliveries,
    },
  ].filter((item): item is { label: string; value: number } => typeof item.value === "number");

  return (
    <section className={cn("space-y-6", className)} aria-label="Live Telegram adoption metrics">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border/55 pb-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="relative flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand-accent)]" />
          </span>
          <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Telegram pulse</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:text-[11px]">
          current pulse {formatUpdatedAt(data.currentSnapshotAt ?? data.updatedAt).replace(/^updated /, "")}
        </span>
      </div>

      {data.quality?.status === "partial" ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          Some public Telegram telemetry is temporarily unavailable. Counts shown here keep working where source data is
          complete.
        </p>
      ) : null}

      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="border-b border-border/55 pb-5 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-6">
          <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
            Active Telegram chats
          </p>
          <p className="mt-3 font-mono text-[3.25rem] font-semibold leading-[0.9] tabular-nums text-foreground sm:text-[4rem] lg:text-[4.75rem]">
            {formatCount(data.activeWatchers)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
            chats with at least one alert enabled
          </p>
        </div>
        <div className="border-b border-border/55 pb-5 sm:border-b-0 sm:pb-0 lg:border-r lg:pr-6">
          <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
            Estimated capacity
          </p>
          <p className="mt-3 font-mono text-4xl font-semibold leading-[0.95] tabular-nums text-foreground sm:text-5xl lg:text-[3.5rem]">
            {formatCount(TELEGRAM_ESTIMATED_CAPACITY_WATCHERS)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
            <span className="block">active watcher target</span>
            <span className="block">{formatCapacityUsage(data.activeWatchers)}</span>
          </p>
        </div>
        <div className="border-b border-border/55 pb-5 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-6">
          <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
            Alert follows
          </p>
          <p className="mt-3 font-mono text-4xl font-semibold leading-[0.95] tabular-nums text-foreground sm:text-5xl lg:text-[3.5rem]">
            {formatCount(data.coinSubscriptions)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
            {(data.explicitCoinSubscriptions ?? data.coinSubscriptions).toLocaleString("en-US")} explicit,{" "}
            {(data.presetImpliedCoinSubscriptions ?? 0).toLocaleString("en-US")} preset-implied
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
            Most followed
          </p>
          {topCoins.length > 0 ? (
            <ol className="mt-3 flex flex-wrap items-center gap-1.5">
              {topCoins.map((coin, index) => (
                <li
                  key={coin}
                  className="inline-flex items-center gap-1.5 rounded-md border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-1.5 font-mono text-[13px] font-semibold tabular-nums text-sky-800 dark:text-sky-200"
                >
                  <span aria-hidden="true" className="text-[10px] font-medium text-sky-700/60 dark:text-sky-300/60">
                    {index + 1}
                  </span>
                  {coin}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">No ranked follows yet.</p>
          )}
        </div>
      </div>

      {telemetryItems.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Telegram aggregate alert telemetry">
          {telemetryItems.map((item) => (
            <div key={item.label} className="rounded-lg border border-border/55 bg-muted/25 px-3 py-2.5">
              <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.16em] text-muted-foreground">
                {item.label}
              </p>
              <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground">
                {formatCount(item.value)}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.2em] text-muted-foreground sm:text-[11px]">
              Telegram chat lifecycle
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {data.historySource === "snapshot"
                ? "Daily active watcher snapshots. Past points stay fixed when chats churn; the chart is lifecycle history, not the live pulse."
                : "Cumulative current active chats by the day each chat first subscribed."}
            </p>
            {(data.privacy?.suppressedFields.length ?? 0) > 0 ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Low-cardinality deltas below {data.privacy?.lowCardinalityThreshold ?? 5} are hidden in public
                telemetry.
              </p>
            ) : null}
          </div>
          {latestHistoryPoint ? (
            <div className="font-mono text-xs text-muted-foreground">
              latest daily snapshot{" "}
              <span className="font-semibold text-foreground">{formatCount(latestHistoryPoint.activeWatchers)}</span>
              {latestHistoryLabel ? <span> · {latestHistoryLabel}</span> : null}
            </div>
          ) : null}
        </div>
        {watcherHistory.length > 0 ? (
          <TelegramWatcherGrowthChart data={watcherHistory} />
        ) : (
          <div className="mt-4 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
            Historical watcher points will appear once subscription telemetry is available.
          </div>
        )}
      </div>
    </section>
  );
}
