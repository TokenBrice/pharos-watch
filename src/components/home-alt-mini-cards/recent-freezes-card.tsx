"use client";

import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { Skeleton } from "@/components/ui/skeleton";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { useLogos } from "@/hooks/use-logos";
import { formatCurrency } from "@shared/lib/format";
import { formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { DAY_SECONDS } from "@shared/lib/time-constants";

interface FreezeAggregate {
  count24h: number;
  count7d: number;
  amount24hUsd: number;
  amount7dUsd: number;
  daily: number[];
  recent: RecentFreezeEvent[];
}

interface RecentFreezeEvent {
  id: string;
  stablecoinId: string;
  symbol: string;
  amountUsdAtEvent: number | null;
  ageSec: number;
  eventType: "blacklist" | "destroy";
}

function aggregate(
  events: ReadonlyArray<{
    id: string;
    stablecoin: string;
    stablecoinId?: string;
    timestamp: number;
    eventType: string;
    amountUsdAtEvent: number | null;
  }>,
  nowSeconds: number,
  resolveId: (symbol: string) => string,
): FreezeAggregate {
  const cutoff24h = nowSeconds - DAY_SECONDS;
  const cutoff7d = nowSeconds - 7 * DAY_SECONDS;
  let count24h = 0;
  let count7d = 0;
  let amount24hUsd = 0;
  let amount7dUsd = 0;
  const dayBuckets = new Array<number>(7).fill(0);
  const recent: RecentFreezeEvent[] = [];
  for (const ev of events) {
    if (ev.eventType !== "blacklist" && ev.eventType !== "destroy") continue;
    if (ev.timestamp < cutoff7d) continue;
    count7d += 1;
    if (ev.amountUsdAtEvent !== null && Number.isFinite(ev.amountUsdAtEvent)) {
      amount7dUsd += ev.amountUsdAtEvent;
    }
    const dayIndex = Math.min(
      6,
      Math.max(0, Math.floor((nowSeconds - ev.timestamp) / DAY_SECONDS)),
    );
    dayBuckets[6 - dayIndex] += 1;
    if (ev.timestamp >= cutoff24h) {
      count24h += 1;
      if (ev.amountUsdAtEvent !== null && Number.isFinite(ev.amountUsdAtEvent)) {
        amount24hUsd += ev.amountUsdAtEvent;
      }
    }
    // Only surface recent rows that carry a known USD amount — events with a
    // null amountUsdAtEvent (older events where price/balance couldn't be
    // reconstructed) look broken in a discovery list. They still count toward
    // the 24h / 7d totals above; they just don't appear in the row list.
    if (
      recent.length < 3 &&
      ev.amountUsdAtEvent !== null &&
      Number.isFinite(ev.amountUsdAtEvent) &&
      ev.amountUsdAtEvent > 0
    ) {
      recent.push({
        id: ev.id,
        // Prefer the event's canonical stablecoinId; the symbol heuristic is a
        // fallback for older events that lack it (it returns the first
        // insertion-order id sharing the symbol prefix, which is ambiguous for
        // coins like usdt-tron / usdt-ethereum). [audit Q-260]
        stablecoinId: ev.stablecoinId ?? resolveId(ev.stablecoin),
        symbol: ev.stablecoin,
        amountUsdAtEvent: ev.amountUsdAtEvent,
        ageSec: Math.max(0, nowSeconds - ev.timestamp),
        eventType: ev.eventType,
      });
    }
  }
  return { count24h, count7d, amount24hUsd, amount7dUsd, daily: dayBuckets, recent };
}

function FreezeBars({ values }: { values: number[] }): React.JSX.Element | null {
  if (values.every((v) => v === 0)) return null;
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-full w-full items-end gap-1" aria-hidden="true">
      {values.map((v, i) => {
        const heightPct = v === 0 ? 4 : Math.max(10, (v / max) * 100);
        const isToday = i === values.length - 1;
        return (
          <div
            key={i}
            className={`flex-1 rounded-[3px] ${
              isToday
                ? "bg-red-600 dark:bg-red-500"
                : "bg-red-600/40 dark:bg-red-500/35"
            }`}
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </div>
  );
}

// Heuristic: the events endpoint returns events keyed by symbol enum
// (e.g. "USDC"). We map symbol → registry id by looking through logos which
// are keyed by stablecoin id (e.g. "usdc-circle"). Fallback is the lowercase
// symbol which usually still resolves the logo via filename convention.
function symbolToId(symbol: string, logoMap: Record<string, string>): string {
  const lower = symbol.toLowerCase();
  for (const id of Object.keys(logoMap)) {
    if (id.startsWith(`${lower}-`) || id === lower) return id;
  }
  return lower;
}

export function RecentFreezesCard(): React.JSX.Element {
  const eventsQuery = useBlacklistEventsPage({
    eventType: "all",
    sortBy: "date",
    sortDirection: "desc",
    limit: 200,
    offset: 0,
  });
  const { data: logos } = useLogos();
  const logoMap = useMemo(() => logos ?? {}, [logos]);

  const agg = useMemo(() => {
    const events = eventsQuery.data?.events ?? [];
    if (events.length === 0) return null;
    const refSec = eventsQuery.dataUpdatedAt
      ? Math.floor(eventsQuery.dataUpdatedAt / 1000)
      // eslint-disable-next-line react-hooks/purity -- Date.now() only used as a transient fallback before TanStack Query reports dataUpdatedAt; visible result is bounded by the query's refetchInterval.
      : Math.floor(Date.now() / 1000);
    return aggregate(events, refSec, (sym) => symbolToId(sym, logoMap));
  }, [eventsQuery.data, eventsQuery.dataUpdatedAt, logoMap]);

  const isLoading = eventsQuery.isLoading;

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="pharos-kicker">Recent Freezes</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          7d window
        </span>
      </div>

      {isLoading || !agg ? (
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 items-start gap-3">
            <div className="flex items-baseline gap-2">
              <span
                className={`font-mono text-5xl font-bold tabular-nums tracking-tight ${
                  agg.count24h > 0
                    ? "text-red-700 dark:text-red-400"
                    : "text-foreground"
                }`}
              >
                {agg.count24h.toLocaleString("en-US")}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                24h
              </span>
              {agg.amount24hUsd > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-foreground/85">
                  {formatCurrency(agg.amount24hUsd, 0)}
                </span>
              )}
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <span className="font-semibold text-foreground/85">
                  {agg.count7d.toLocaleString("en-US")}
                </span>{" "}
                events · 7d
              </div>
              <div className="mt-1 font-mono text-[11px] tabular-nums text-foreground/80">
                {agg.amount7dUsd > 0 ? formatCurrency(agg.amount7dUsd, 0) : "—"}
              </div>
            </div>
          </div>
          <div className="min-h-20 flex-1">
            {agg.count7d > 0 ? (
              <FreezeBars values={agg.daily} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="font-mono text-[11px] uppercase tracking-wider text-green-700 dark:text-green-400">
                  All quiet
                </span>
              </div>
            )}
          </div>
          {agg.recent.length > 0 && (
            <ul className="mt-auto flex flex-col divide-y divide-border/40 font-mono text-[13px]">
              {agg.recent.map((ev) => {
                const logoSrc = logoMap[ev.stablecoinId];
                return (
                  <li
                    key={ev.id}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-2 py-1.5 tabular-nums"
                  >
                    <CoinCell logoSrc={logoSrc} />
                    <span className="truncate uppercase tracking-tight text-foreground">
                      {ev.symbol}
                    </span>
                    <span className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                      {ev.amountUsdAtEvent && ev.amountUsdAtEvent > 0
                        ? formatCurrency(ev.amountUsdAtEvent, 0)
                        : "—"}
                    </span>
                    <span className="tabular-nums text-muted-foreground/80">
                      {formatRelativeDurationSeconds(ev.ageSec, { nowLabel: "now" })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
