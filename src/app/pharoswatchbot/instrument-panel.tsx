"use client";

import { useId, useMemo } from "react";
import Link from "next/link";
import { Area, AreaChart } from "recharts";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis, useNiceValueAxis } from "@/components/chart-primitives/axes";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useCountUp } from "@/hooks/use-count-up";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { Skeleton } from "@/components/ui/skeleton";
import { DAY_MS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { formatChartDate, formatDecimal } from "@shared/lib/format";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";
import type { TelegramWatcherHistoryPoint } from "@shared/types/status";

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
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

function isTelegramPulseAvailable(query: { data?: unknown; isLoading: boolean; isError: boolean }): boolean {
  return !query.isLoading && !query.isError && query.data != null;
}

function formatCount(value: number): string {
  return formatDecimal(value, 0, 3);
}

function formatMonthTick(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isFinite(timestamp) ? formatChartDate(timestamp, "compact") : "";
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
  const watcherCounts = useMemo(() => data.map((point) => point.activeWatchers), [data]);
  const valueAxis = useNiceValueAxis(watcherCounts, { kind: "count" });
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
            {...valueAxis}
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
    <div role="status" aria-label="Loading Telegram adoption metrics" aria-live="polite" aria-busy="true" className="p-5 sm:p-6 lg:p-7">
      <Skeleton className="h-[260px]" />
    </div>
  );
}

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

/**
 * The page hero: live, aggregate adoption counts from the bot itself on the
 * shared feature-hero split. Active watchers is the One Beam figure; follows,
 * today's lifecycle and the most-followed coins support it; the lifecycle
 * chart is the visual. Public adoption metrics only — no operational counts,
 * no per-chat anything (privacy contract).
 */
export function InstrumentPanel() {
  const query = useTelegramPulse();
  const { data, isLoading } = query;
  const available = isTelegramPulseAvailable(query);
  const watchers = useCountUp(available ? data?.activeWatchers ?? null : null);
  const follows = useCountUp(available ? data?.coinSubscriptions ?? null : null);
  const rankingUnavailable = data?.quality?.unavailableFields.includes("topCoins") ?? false;
  const historyUnavailable = data?.quality?.unavailableFields.includes("watcherHistory") ?? false;
  const live = available && data ? data : null;
  const todayDeltas = live
    ? [
        { label: "New today", value: live.newWatchersToday },
        { label: "Reactivated today", value: live.reactivatedWatchersToday },
        { label: "Churned today", value: live.churnedWatchersToday },
      ].filter((item): item is { label: string; value: number } => typeof item.value === "number")
    : [];

  return (
    <section id="panel" className="scroll-mt-24" aria-labelledby="panel-title">
      <h2 id="panel-title" className="sr-only">
        Live adoption
      </h2>
      <FeatureHeroSplit
        ariaLabel="Live Telegram adoption metrics"
        beamLabel={
          <span title={TELEGRAM_METRIC_SEMANTICS.activeWatchers.description}>
            {TELEGRAM_METRIC_SEMANTICS.activeWatchers.label}
          </span>
        }
        beamValue={
          <>
            {/* useCountUp keeps its last display on null; availability gates the beam too (R1). */}
            <span aria-hidden="true">{live ? watchers.display ?? "—" : "—"}</span>
            {live && watchers.value != null ? (
              <span className="sr-only">{formatCount(watchers.value)} active watchers</span>
            ) : null}
          </>
        }
        sub={
          live ? (
            <dl className="space-y-5">
              <div>
                <dt className="pharos-kicker" title={TELEGRAM_METRIC_SEMANTICS.coinFollows.description}>
                  {TELEGRAM_METRIC_SEMANTICS.coinFollows.label}
                </dt>
                <dd className="mt-2 pharos-numeric text-2xl font-semibold leading-none text-foreground">
                  {follows.display ?? "—"}
                </dd>
                {typeof live.explicitCoinSubscriptions === "number" &&
                typeof live.presetImpliedCoinSubscriptions === "number" ? (
                  <dd className="mt-2 text-xs text-muted-foreground">
                    {formatCount(live.explicitCoinSubscriptions)} explicit ·{" "}
                    {formatCount(live.presetImpliedCoinSubscriptions)} preset-implied
                  </dd>
                ) : null}
                {typeof live.activePresetFollowers === "number" ? (
                  <dd className="mt-0.5 text-xs text-muted-foreground">
                    {formatCount(live.activePresetFollowers)} chats using presets
                  </dd>
                ) : null}
              </div>
              {todayDeltas.length > 0 ? (
                <div>
                  <dt className="sr-only">Today</dt>
                  <dd className="flex flex-wrap gap-x-5 gap-y-2">
                    {todayDeltas.map((item) => (
                      <span key={item.label} className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                        <span className="pharos-numeric text-sm font-semibold text-foreground">{formatCount(item.value)}</span>
                        {item.label}
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="pharos-kicker">Most followed</dt>
                <dd className="mt-2">
                  {rankingUnavailable ? (
                    <p className="text-xs text-muted-foreground">Follow rankings are temporarily unavailable.</p>
                  ) : live.topCoins.length > 0 ? (
                    <ol className="flex flex-wrap items-center gap-1.5">
                      {live.topCoins.slice(0, 5).map((coin, index) => (
                        <li
                          key={coin}
                          className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 pharos-numeric text-xs font-semibold text-foreground"
                        >
                          <span aria-hidden="true" className="text-3xs font-medium text-muted-foreground">
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
            </dl>
          ) : null
        }
        footer={
          live ? (
            <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
              <span
                className={cn(
                  "inline-flex w-fit items-center rounded-md px-2 py-0.5 font-medium",
                  live.quality?.status === "complete"
                    ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                    : "bg-amber-500/10 text-amber-800 dark:text-amber-200",
                )}
              >
                {live.quality?.status === "complete"
                  ? "Complete telemetry"
                  : live.quality?.status === "partial"
                    ? "Partial telemetry"
                    : "Unknown telemetry"}
              </span>
              <span>
                Snapshot{" "}
                <span className="font-mono text-foreground">
                  {formatSnapshotAt(live.currentSnapshotAt ?? live.updatedAt) ?? "every 5m"}
                </span>{" "}
                · refreshed every {Math.round((live.updatedEverySeconds ?? 300) / 60)} minutes · aggregate counts; small
                daily changes are hidden to protect individual chats. Service health lives on the{" "}
                <Link href="/status/" className={PROSE_LINK_CLASS}>
                  status page
                </Link>
                .
              </span>
            </div>
          ) : null
        }
      >
        {isLoading ? <PanelLoading /> : null}
        {!isLoading && !live ? (
          <div
            role="status"
            aria-label="Telegram adoption metrics unavailable"
            aria-live="polite"
            aria-busy="false"
            className="flex h-full min-h-[200px] items-center p-5 sm:p-6 lg:p-7"
          >
            <p className="max-w-md text-sm text-muted-foreground">
              Public Telegram adoption metrics are temporarily unavailable. They retry automatically; bot links and
              setup commands keep working.
            </p>
          </div>
        ) : null}
        {live ? (
          <div className="p-5 sm:p-6 lg:p-7">
            {live.quality?.status === "partial" ? (
              <p className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                Some public Telegram telemetry is temporarily unavailable. Counts shown here keep working where source
                data is complete.
              </p>
            ) : null}
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <p className="text-sm font-medium text-muted-foreground">Telegram chat lifecycle</p>
              {!historyUnavailable && live.watcherHistory.length > 0 ? (
                <p className="font-mono text-xs text-muted-foreground">
                  latest daily snapshot{" "}
                  <span className="font-semibold text-foreground">
                    {formatCount(live.watcherHistory.at(-1)?.activeWatchers ?? 0)}
                  </span>
                  {formatSnapshotAt(live.lifecycleHistoryUpdatedAt) ? (
                    <span> · {formatSnapshotAt(live.lifecycleHistoryUpdatedAt)}</span>
                  ) : null}
                </p>
              ) : null}
            </div>
            {historyUnavailable ? (
              <div className="mt-4 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
                Watcher history is temporarily unavailable.
              </div>
            ) : live.watcherHistory.length > 0 ? (
              <WatcherGrowthChart data={live.watcherHistory} />
            ) : (
              <div className="mt-4 flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
                Historical watcher points will appear once subscription telemetry is available.
              </div>
            )}
          </div>
        ) : null}
      </FeatureHeroSplit>
    </section>
  );
}
