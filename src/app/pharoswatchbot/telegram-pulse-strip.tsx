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
            dot={false}
            activeDot={{ r: 4 }}
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
        <span className="font-semibold text-foreground font-mono">{formatCount(data.coinSubscriptions)}</span> per-coin
        alert follows
      </span>
      <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
      <span className="text-muted-foreground">updated every 5m</span>
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
      <div
        className={cn("grid grid-cols-3 gap-2 sm:gap-3", className)}
        aria-label="Loading Telegram adoption metrics"
      >
        <Skeleton className="h-14 rounded-xl sm:h-[86px]" />
        <Skeleton className="h-14 rounded-xl sm:h-[86px]" />
        <Skeleton className="h-14 rounded-xl sm:h-[86px]" />
      </div>
    );
  }

  if (!data || isError) {
    return (
      <div className={cn("rounded-xl border border-border/60 bg-muted/25 px-4 py-3", className)}>
        <p className="text-xs text-muted-foreground">
          Live Telegram adoption metrics are temporarily unavailable. They retry automatically; bot links and setup
          commands still work.
        </p>
      </div>
    );
  }

  const topCoins = data.topCoins.slice(0, 5);
  const watcherHistory = data.watcherHistory ?? [];
  const latestHistoryPoint = watcherHistory.at(-1) ?? null;

  return (
    <section className={cn("space-y-3", className)} aria-label="Live Telegram adoption metrics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="pharos-kicker">Telegram pulse</p>
        <p className="text-xs text-muted-foreground">Updated every 5m</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
          <p className="pharos-kicker">Active Telegram chats</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {formatCount(data.activeWatchers)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">chats with at least one alert enabled</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
          <p className="pharos-kicker">Per-coin alert follows</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {formatCount(data.coinSubscriptions)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">explicit coin-level follows across chats</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
          <p className="pharos-kicker">Most followed</p>
          {topCoins.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {topCoins.map((coin) => (
                <span
                  key={coin}
                  className="rounded-md border border-frost-blue/25 bg-frost-blue/10 px-2 py-1 font-mono text-xs font-semibold text-sky-800 dark:text-sky-200"
                >
                  {coin}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">No ranked follows yet.</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="pharos-kicker">All-time Telegram chat growth</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Cumulative current active chats by the day each chat first subscribed.
            </p>
          </div>
          {latestHistoryPoint ? (
            <div className="font-mono text-xs text-muted-foreground">
              current{" "}
              <span className="font-semibold text-foreground">{formatCount(latestHistoryPoint.activeWatchers)}</span>
            </div>
          ) : null}
        </div>
        {watcherHistory.length > 1 ? (
          <TelegramWatcherGrowthChart data={watcherHistory} />
        ) : (
          <div className="mt-4 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
            Historical watcher points will appear once multiple subscription days are available.
          </div>
        )}
      </div>
    </section>
  );
}
