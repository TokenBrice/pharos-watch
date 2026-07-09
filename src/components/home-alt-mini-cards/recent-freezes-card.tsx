"use client";

import { useMemo, useState } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { QueryStateNotice } from "@/components/query-state-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { useLogos } from "@/hooks/use-logos";
import { formatCurrency } from "@shared/lib/format";
import { formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { resolveQueryViewState } from "@/lib/query-view-state";

// How many recent freeze rows to surface beneath the headline.
const MAX_RECENT = 4;

type WindowKey = "24h" | "7d";

interface FreezeAggregate {
  count24h: number;
  count7d: number;
  amount24hUsd: number;
  amount7dUsd: number;
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
  const recent: RecentFreezeEvent[] = [];
  for (const ev of events) {
    if (ev.eventType !== "blacklist" && ev.eventType !== "destroy") continue;
    if (ev.timestamp < cutoff7d) continue;
    count7d += 1;
    if (ev.amountUsdAtEvent !== null && Number.isFinite(ev.amountUsdAtEvent)) {
      amount7dUsd += ev.amountUsdAtEvent;
    }
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
      recent.length < MAX_RECENT &&
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
  return { count24h, count7d, amount24hUsd, amount7dUsd, recent };
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
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");

  const agg = useMemo(() => {
    if (!eventsQuery.data) return null;
    const events = eventsQuery.data.events;
    const refSec = eventsQuery.dataUpdatedAt
      ? Math.floor(eventsQuery.dataUpdatedAt / 1000)
      : // eslint-disable-next-line react-hooks/purity -- Date.now() only used as a transient fallback before TanStack Query reports dataUpdatedAt; visible result is bounded by the query's refetchInterval.
        Math.floor(Date.now() / 1000);
    return aggregate(events, refSec, (sym) => symbolToId(sym, logoMap));
  }, [eventsQuery.data, eventsQuery.dataUpdatedAt, logoMap]);

  const isLoading = eventsQuery.isLoading;
  const state = resolveQueryViewState({
    hasData: eventsQuery.data !== undefined,
    isLoading,
    error: eventsQuery.error,
    isEmpty: (eventsQuery.data?.events.length ?? 0) === 0,
  });
  const amount = windowKey === "24h" ? (agg?.amount24hUsd ?? 0) : (agg?.amount7dUsd ?? 0);
  const count = windowKey === "24h" ? (agg?.count24h ?? 0) : (agg?.count7d ?? 0);

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 overflow-hidden p-4">
      <PulseCardHeader
        href="/freezewatch/"
        expandLabel="Open FreezeWatch"
        label="Recent Freezes"
        aside={
          <div role="group" aria-label="Freeze window" className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setWindowKey("24h")}
              aria-pressed={windowKey === "24h"}
              data-state={windowKey === "24h" ? "on" : "off"}
              className="pharos-toggle-pill pharos-focus-ring min-h-6 justify-center px-2 py-1 font-mono text-[11px] leading-none"
            >
              24h
            </button>
            <button
              type="button"
              onClick={() => setWindowKey("7d")}
              aria-pressed={windowKey === "7d"}
              data-state={windowKey === "7d" ? "on" : "off"}
              className="pharos-toggle-pill pharos-focus-ring min-h-6 justify-center px-2 py-1 font-mono text-[11px] leading-none"
            >
              7d
            </button>
          </div>
        }
      />

      {state === "loading" ? (
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-20 w-full" />
        </>
      ) : state === "unavailable" || !agg ? (
        <QueryStateNotice state="unavailable" label="Recent freeze data" onRetry={() => void eventsQuery.refetch()} />
      ) : (
        <>
          {state === "stale-with-data" ? (
            <QueryStateNotice
              state={state}
              label="Recent freeze data"
              dataUpdatedAt={eventsQuery.dataUpdatedAt}
              onRetry={() => void eventsQuery.refetch()}
              compact
            />
          ) : null}
          <div className="flex items-baseline gap-2">
            <span
              className={`pharos-numeric text-4xl font-bold tracking-tight ${
                count > 0 ? "text-red-700 dark:text-red-400" : "text-foreground"
              }`}
            >
              {formatCurrency(amount, 0)}
            </span>
            <span aria-hidden="true" className="font-mono text-sm text-muted-foreground/40">
              ·
            </span>
            <span className="pharos-numeric text-[11px] uppercase tracking-wider text-muted-foreground/70">
              {count.toLocaleString("en-US")}X
            </span>
          </div>
          {agg.recent.length > 0 && (
            <ul className="flex flex-col border-t border-border/50 pt-2.5 font-mono text-xs">
              {agg.recent.map((ev) => {
                const logoSrc = logoMap[ev.stablecoinId];
                return (
                  <li
                    key={ev.id}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 py-1 pharos-numeric"
                  >
                    <CoinCell logoSrc={logoSrc} />
                    <span className="truncate uppercase tracking-tight text-foreground">{ev.symbol}</span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-semibold pharos-numeric text-red-700 dark:text-red-400">
                        {ev.amountUsdAtEvent && ev.amountUsdAtEvent > 0 ? formatCurrency(ev.amountUsdAtEvent, 0) : "—"}
                      </span>
                      <span aria-hidden="true" className="text-muted-foreground/40">
                        ·
                      </span>
                      <span className="uppercase pharos-numeric text-muted-foreground/80">
                        {formatRelativeDurationSeconds(ev.ageSec, { nowLabel: "now" })}
                      </span>
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
