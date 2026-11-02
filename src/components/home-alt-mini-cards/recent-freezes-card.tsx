"use client";

import { useMemo, useState } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { buildBlacklistStatusBuckets } from "@shared/lib/blacklist-status-buckets";
import { computeFreezableSummary, formatShare } from "@shared/lib/freezewatch/freezable-summary";
import { getLogoSrc, logosById } from "@/lib/logos";
import { formatCurrency } from "@shared/lib/format";
import { formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { formatBlacklistValuation } from "@/lib/blacklist-valuation";

// How many recent freeze rows to surface beneath the headline.
const MAX_RECENT = 3;

type WindowKey = "24h" | "7d";


interface RecentFreezeEvent {
  id: string;
  stablecoinId: string;
  symbol: string;
  amountUsdAtEvent: number | null;
  ageSec: number;
  eventType: "blacklist" | "destroy";
}

function buildRecentRows(
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
): RecentFreezeEvent[] {
  const cutoff7d = nowSeconds - 7 * DAY_SECONDS;
  const recent: RecentFreezeEvent[] = [];
  for (const ev of events) {
    if (ev.eventType !== "blacklist" && ev.eventType !== "destroy") continue;
    if (ev.timestamp < cutoff7d) continue;
    // Only surface recent rows that carry a known USD amount — events with a
    // null amountUsdAtEvent (older events where price/balance couldn't be
    // reconstructed) look broken in a discovery list.
    if (
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
      if (recent.length === MAX_RECENT) break;
    }
  }
  return recent;
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

// Rows only carry positive valuations; a sub-dollar freeze must not round to "$0".
function formatFreezeRowUsd(value: number): string {
  return value < 1 ? "<$1" : formatCurrency(value, 0);
}

export function RecentFreezesCard(): React.JSX.Element {
  const eventsQuery = useBlacklistEventsPage({
    eventType: "all",
    sortBy: "date",
    sortDirection: "desc",
    limit: 200,
    offset: 0,
  });
  const summaryQuery = useBlacklistSummary();
  // The FreezeWatch hero figure, from the same stablecoins list and summary
  // helper the /freezewatch/ hero reads (shared cache, no extra request).
  const stablecoinsQuery = useStablecoins();
  const freezable = useMemo(
    () => computeFreezableSummary(stablecoinsQuery.data ? buildBlacklistStatusBuckets(stablecoinsQuery.data.peggedAssets) : null),
    [stablecoinsQuery.data],
  );
  const logos = logosById;
  const logoMap = useMemo(() => logos ?? {}, [logos]);
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");

  const recent = useMemo(() => {
    if (!eventsQuery.data) return [];
    const refSec = eventsQuery.dataUpdatedAt
      ? Math.floor(eventsQuery.dataUpdatedAt / 1000)
      : // eslint-disable-next-line react-hooks/purity -- Date.now() only used as a transient fallback before TanStack Query reports dataUpdatedAt; visible result is bounded by the query's refetchInterval.
        Math.floor(Date.now() / 1000);
    return buildRecentRows(eventsQuery.data.events, refSec, (sym) => symbolToId(sym, logoMap));
  }, [eventsQuery.data, eventsQuery.dataUpdatedAt, logoMap]);

  const isLoading = eventsQuery.isLoading || summaryQuery.isLoading;
  const state = resolveQueryViewState({
    hasData: eventsQuery.data !== undefined && summaryQuery.data !== undefined,
    isLoading,
    error: summaryQuery.error ?? eventsQuery.error,
    isEmpty:
      (eventsQuery.data?.events.length ?? 0) === 0 &&
      (summaryQuery.data?.stats.recentFreezeCount7d ?? 0) === 0,
  });
  const amount =
    windowKey === "24h"
      ? summaryQuery.data?.stats.recentFreezeAmount24hUsd
      : summaryQuery.data?.stats.recentFreezeAmount7dUsd;
  const count =
    windowKey === "24h"
      ? (summaryQuery.data?.stats.recentFreezeCount24h ?? 0)
      : (summaryQuery.data?.stats.recentFreezeCount7d ?? 0);
  const valuationCoverage = windowKey === "24h"
    ? summaryQuery.data?.stats.valuationCoverage?.recent24h
    : summaryQuery.data?.stats.valuationCoverage?.recent7d;

  return (
    <PulseCard
      className="pharos-card-shell flex h-full flex-col gap-3 overflow-hidden p-4"
      href="/freezewatch/"
      expandLabel="Open FreezeWatch"
      label="FreezeWatch"
      aside={
        <div role="group" aria-label="Freeze window" className="pharos-segmented">
          <button
            type="button"
            onClick={() => setWindowKey("24h")}
            aria-pressed={windowKey === "24h"}
            className="pharos-focus-ring pharos-segmented-item px-2 font-mono text-2xs leading-none"
          >
            24h
          </button>
          <button
            type="button"
            onClick={() => setWindowKey("7d")}
            aria-pressed={windowKey === "7d"}
            className="pharos-focus-ring pharos-segmented-item px-2 font-mono text-2xs leading-none"
          >
            7d
          </button>
        </div>
      }
      state={state}
      loadingContent={
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-20 w-full" />
        </>
      }
      hasRenderableData={summaryQuery.data !== undefined && eventsQuery.data !== undefined}
      unavailableWhen={!summaryQuery.data || !eventsQuery.data}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RailHeroFigureTransition rail="freezewatch">
          <span className="pharos-numeric text-4xl font-bold tracking-tight text-foreground">
            {freezable.freezableShare === null || freezable.coverage === "unavailable"
              ? "—"
              : formatShare(freezable.freezableShare)}
          </span>
        </RailHeroFigureTransition>
        {stablecoinsQuery.data ? (
          <UniverseChip universe="active" value={`${freezable.registryCount} coins classified`} className="sm:ml-auto" />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Freezable share of {freezable.coverage === "partial" ? "observed" : "tracked"} supply · frozen in {windowKey}:{" "}
        <span className="pharos-numeric text-foreground">
          {formatBlacklistValuation(amount, valuationCoverage, (value) => formatCurrency(value, 0))}
        </span>
        {" · "}
        <span>{`${count.toLocaleString("en-US")} ${count === 1 ? "freeze" : "freezes"}`}</span>
        {recent.length > 0 ? " · latest first" : ""}
      </p>
      {recent.length > 0 && (
        <ul
          aria-label="Latest valued freezes, newest first"
          className="flex flex-col border-t border-border/50 pt-2.5 font-mono text-xs"
        >
          {recent.map((ev) => {
            const logoSrc = getLogoSrc(logoMap, ev.stablecoinId);
            return (
              <li
                key={ev.id}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 py-1 pharos-numeric"
              >
                <CoinCell logoSrc={logoSrc} />
                <span className="truncate tracking-tight text-foreground">{ev.symbol}</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-semibold pharos-numeric text-state-danger">
                    {ev.amountUsdAtEvent && ev.amountUsdAtEvent > 0 ? formatFreezeRowUsd(ev.amountUsdAtEvent) : "—"}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                  <span className="pharos-numeric text-muted-foreground/80">
                    {formatRelativeDurationSeconds(ev.ageSec, { nowLabel: "now" })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </PulseCard>
  );
}
