"use client";

import { useId, type ReactNode } from "react";
import { Area, AreaChart } from "recharts";
import { ChevronDown } from "lucide-react";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { Skeleton } from "@/components/ui/skeleton";
import { DAY_MS } from "@/lib/constants";
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
// Scenario size enforced by `npm run check:telegram-load`; this is evidence from
// selected modeled workloads, not a fixed subscriber capacity.
const TELEGRAM_LOAD_TEST_SCENARIO_WATCHERS = 5_000;

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

function formatDayTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return DAY_TICK_FORMATTER.format(new Date(timestamp));
}

function formatUpdatedAt(value: number | undefined): string {
  if (!value) return "every 5m";
  return PULSE_UPDATED_FORMATTER.format(new Date(value * 1000));
}

function formatSnapshotAt(value: number | null | undefined): string | null {
  if (!value) return null;
  return PULSE_UPDATED_FORMATTER.format(new Date(value * 1000));
}

function formatShare(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function lifecycleRangeDays(data: TelegramWatcherHistoryPoint[]): number {
  const first = data[0]?.timestamp;
  const last = data.at(-1)?.timestamp;
  if (!first || !last) return 0;
  return Math.max(0, Math.round((last - first) / DAY_MS));
}

function TelegramWatcherGrowthChart({ data }: { data: TelegramWatcherHistoryPoint[] }) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();
  const rawGradientId = useId();
  const gradientId = `telegram-watcher-growth-${rawGradientId.replace(/:/g, "")}`;
  const rangeDays = lifecycleRangeDays(data);
  const tickFormatter = rangeDays > 120 ? formatMonthTick : formatDayTick;
  const singlePointTimestamp = data.length === 1 ? data[0]?.timestamp : undefined;
  const domain = singlePointTimestamp
    ? ([singlePointTimestamp - 14 * DAY_MS, singlePointTimestamp + 14 * DAY_MS] as [number, number])
    : (["dataMin", "dataMax"] as const);

  return (
    <div
      ref={ref}
      className="mt-4 h-[210px] sm:h-[260px]"
      role="figure"
      aria-label={`Full Telegram chat lifecycle chart with ${data.length} daily points`}
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
          <TimeXAxis dataKey="timestamp" domain={domain} minTickGap={56} tickFormatter={tickFormatter} />
          <MonoYAxis width={42} allowDecimals={false} tickFormatter={(value) => formatCompactCount(Number(value))} />
          <DateTooltip formatter={(value, name) => [formatCount(Number(value)), String(name)]} />
          <Area
            type="monotone"
            dataKey="activeWatchers"
            name="Active Telegram chats"
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

type PulseStat = {
  label: string;
  value: number;
  detail?: string;
  shareTotal?: number;
};

function isPulseStat(item: { value: unknown }): item is PulseStat {
  return typeof item.value === "number";
}

function PulseStatGroup({
  title,
  items,
}: {
  title: string;
  items: PulseStat[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl bg-background/42 p-3.5">
      <p className="pharos-kicker">
        {title}
      </p>
      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const sharePercent = item.shareTotal ? Math.max(3, Math.min(100, (item.value / item.shareTotal) * 100)) : 0;
          return (
            <div key={item.label} className="space-y-1.5">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 text-xs leading-tight text-muted-foreground">{item.label}</span>
                <span className="shrink-0 pharos-numeric text-sm font-semibold text-foreground">
                  {formatCount(item.value)}
                </span>
              </div>
              {item.detail ? <p className="text-[11px] leading-snug text-muted-foreground">{item.detail}</p> : null}
              {item.shareTotal ? (
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  aria-label={`${item.label} is ${formatShare(item.value, item.shareTotal)}`}
                >
                  <div
                    className="h-full rounded-full bg-[var(--brand-accent)]"
                    style={{ width: `${sharePercent}%` }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TelegramPulseStrip() {
  const { data, isLoading, isError } = useTelegramPulse();
  let content: ReactNode;

  if (isLoading) {
    content = (
      <>
        <Skeleton className="h-3.5 w-20 sm:w-24" />
        <Skeleton className="h-3.5 w-24 sm:w-28" />
        <Skeleton className="hidden h-3.5 w-28 sm:block" />
      </>
    );
  } else if (!data || isError) {
    content = (
      <p>
        Telegram adoption metrics unavailable; commands still work.
      </p>
    );
  } else {
    content = (
      <>
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground pharos-numeric">{formatCount(data.activeWatchers)}</span> active
          Telegram chats
        </span>
        <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground pharos-numeric">
            {formatCount(TELEGRAM_LOAD_TEST_SCENARIO_WATCHERS)}
          </span>{" "}
          watcher load scenarios tested
        </span>
        <span className="hidden text-border sm:inline" aria-hidden="true">&middot;</span>
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground pharos-numeric">{formatCount(data.coinSubscriptions)}</span> alert
          links (incl. presets)
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
      </>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground tabular-nums"
      aria-live="polite"
      aria-busy={isLoading ? "true" : "false"}
    >
      {content}
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
        aria-live="polite"
        aria-busy="true"
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
      <section
        className={cn("space-y-3", className)}
        aria-label="Telegram adoption metrics unavailable"
        aria-live="polite"
        aria-busy="false"
      >
        <div className="flex items-center gap-3 border-b border-border/55 pb-4">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-muted-foreground/40" />
          <h2 className="pharos-section-title">Telegram pulse</h2>
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
  const latestHistoryLabel = formatSnapshotAt(data.lifecycleHistoryUpdatedAt);
  const explicitFollows = data.explicitCoinSubscriptions ?? data.coinSubscriptions;
  const presetImpliedFollows = data.presetImpliedCoinSubscriptions ?? 0;
  const followStats = [
    { label: "Explicit coin follows", value: explicitFollows, shareTotal: data.coinSubscriptions },
    { label: "Preset-implied follows", value: presetImpliedFollows, shareTotal: data.coinSubscriptions },
    { label: "Chats using presets", value: data.activePresetFollowers },
  ].filter(isPulseStat);
  const lifecycleStats = [
    { label: "New today", value: data.newWatchersToday },
    { label: "Reactivated today", value: data.reactivatedWatchersToday },
    { label: "Churned today", value: data.churnedWatchersToday },
  ].filter(isPulseStat);
  const deliveryStats = [
    { label: "Queued deliveries", value: data.pendingDeliveries },
  ].filter(isPulseStat);
  const miniAppStats = [
    { label: "Sessions today", value: data.miniAppSessionsToday },
    { label: "Mutations today", value: data.miniAppMutationsToday },
    { label: "Denied today", value: data.miniAppDeniedToday },
    {
      label: "Open → first mutation (P50)",
      value: data.miniAppOpenToFirstMutationP50Sec,
      detail: "seconds",
    },
  ].filter(isPulseStat);

  return (
    <section
      className={cn(
        "pharos-card-shell relative overflow-hidden p-4 sm:p-5 lg:p-6",
        className,
      )}
      aria-label="Live Telegram adoption metrics"
      aria-live="polite"
      aria-busy="false"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border/55 pb-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="relative flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-[var(--brand-accent)]/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand-accent)]" />
          </span>
          <h2 className="pharos-section-title">Telegram pulse</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:text-[11px]">
          current pulse {formatUpdatedAt(data.currentSnapshotAt ?? data.updatedAt)}
        </span>
      </div>

      {data.quality?.status === "partial" ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          Some public Telegram telemetry is temporarily unavailable. Counts shown here keep working where source data is
          complete.
        </p>
      ) : null}

      <div className="grid gap-5 pt-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:gap-6">
        <div className="rounded-2xl bg-background/60 p-4 sm:p-5">
          <p className="pharos-kicker">
            Active Telegram chats
          </p>
          <p className="mt-4 pharos-numeric leading-none text-foreground">
            <span className="text-[3.5rem] font-semibold tracking-normal sm:text-[4.5rem] lg:text-[6rem]">
              {formatCount(data.activeWatchers)}
            </span>
          </p>
          <p className="mt-4 max-w-[48ch] text-xs leading-relaxed text-muted-foreground">
            Selected load scenarios are tested at {formatCount(TELEGRAM_LOAD_TEST_SCENARIO_WATCHERS)} watchers. This is
            not a fixed capacity limit.
          </p>
        </div>

        <div className="grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-xl bg-background/42 p-3.5">
            <p className="pharos-kicker">
              Alert follows
            </p>
            <p className="mt-3 pharos-numeric text-4xl font-semibold leading-none text-foreground sm:text-5xl">
              {formatCount(data.coinSubscriptions)}
            </p>
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs text-muted-foreground">
              <span>
                <span className="block pharos-numeric text-sm font-semibold text-foreground">
                  {formatCount(explicitFollows)}
                </span>
                explicit
              </span>
              <span>
                <span className="block pharos-numeric text-sm font-semibold text-foreground">
                  {formatCount(presetImpliedFollows)}
                </span>
                preset-implied
              </span>
            </div>
          </div>

          <div className="rounded-xl bg-background/42 p-3.5">
            <p className="pharos-kicker">
              Most followed
            </p>
            {topCoins.length > 0 ? (
              <ol className="mt-3 flex flex-wrap items-center gap-1.5">
                {topCoins.map((coin, index) => (
                  <li
                    key={coin}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 pharos-numeric text-[13px] font-semibold text-foreground"
                  >
                    <span aria-hidden="true" className="text-[10px] font-medium text-muted-foreground">
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
      </div>

      <div className="mt-6 rounded-2xl bg-background/46 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="pharos-kicker">
              Telegram chat lifecycle
            </p>
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

      <details className="group mt-5 border-t border-border/60">
        <summary className="pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-4 py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block">More information</span>
            <span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground">
              Follow composition, lifecycle deltas, delivery controls, and Mini App activity
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-border/60 pt-4 sm:pt-5" aria-label="Additional Telegram pulse details">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Telegram aggregate alert telemetry">
            <PulseStatGroup title="Follow composition" items={followStats} />
            <PulseStatGroup title="Daily lifecycle" items={lifecycleStats} />
            <PulseStatGroup title="Delivery controls" items={deliveryStats} />
            <PulseStatGroup title="Mini App today" items={miniAppStats} />
          </div>
        </div>
      </details>
    </section>
  );
}
