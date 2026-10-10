"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary } from "@/hooks/api-hooks";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { resolveQueryViewState } from "@/lib/query-view-state";
import type { PegSummaryCoin } from "@shared/types";

interface ActiveRow {
  id: string;
  symbol: string;
  bps: number | null;
  ageSec: number | null;
}


export function ActiveDepegsCard(): React.JSX.Element {
  const activeQuery = useActiveDepegEvents();
  const pegSummaryQuery = usePegSummary();
  const { data } = activeQuery;
  const { data: pegSummaryData, isLoading: isPegSummaryLoading } = pegSummaryQuery;
  const logos = logosById;
  const logoMap = logos ?? {};

  const activeCoins = useMemo(
    () => (pegSummaryData?.coins ?? []).filter((coin) =>
      ACTIVE_STABLECOIN_ID_SET.has(coin.id) && coin.activeDepeg),
    [pegSummaryData?.coins],
  );
  // The complete summary owns the incident census; the event page supplies detail only.
  const activeRows = useMemo<ActiveRow[]>(() => {
    const eventsById = new Map((data?.events ?? []).map((event) => [event.stablecoinId, event]));
    const nowSec = Math.floor(pegSummaryQuery.dataUpdatedAt / 1000);
    return activeCoins.map((coin: PegSummaryCoin) => {
      const event = eventsById.get(coin.id);
      return {
        id: coin.id,
        symbol: coin.symbol ?? event?.symbol ?? coin.id,
        bps: coin.currentDeviationBps,
        ageSec: event && nowSec > 0 ? Math.max(0, nowSec - event.startedAt) : null,
      };
    }).sort((a, b) =>
      (b.bps == null ? -1 : Math.abs(b.bps)) - (a.bps == null ? -1 : Math.abs(a.bps)));
  }, [activeCoins, data?.events, pegSummaryQuery.dataUpdatedAt]);

  const activeCount = activeCoins.length;
  const flashClass = useFlashOnChange(activeCount);
  const state = resolveQueryViewState({
    hasData: pegSummaryData !== undefined,
    isLoading: isPegSummaryLoading,
    error: pegSummaryQuery.error,
    isEmpty: activeCount === 0,
  });
  const retry = () => {
    void activeQuery.refetch();
    void pegSummaryQuery.refetch();
  };
  const updatedTimes = [activeQuery.dataUpdatedAt, pegSummaryQuery.dataUpdatedAt].filter((value) => value > 0);
  const dataUpdatedAt = updatedTimes.length > 0 ? Math.min(...updatedTimes) : 0;

  return (
    <PulseCard
      className="pharos-card-shell flex h-full flex-col gap-3 overflow-hidden p-4"
      href="/depeg/"
      expandLabel="Open Depeg monitor"
      label="Total Active Depegs"
      state={state}
      notice={{
        label: "Active depeg monitoring",
        dataUpdatedAt,
        queries: [
          { preset: "pegSummary", label: "Active incident count", dataUpdatedAt: pegSummaryQuery.dataUpdatedAt, meta: pegSummaryQuery.meta, error: pegSummaryQuery.error, hasData: pegSummaryData !== undefined },
          { preset: "depegEvents", label: "Incident details", dataUpdatedAt: activeQuery.dataUpdatedAt, meta: activeQuery.meta, error: activeQuery.error, hasData: data !== undefined },
        ],
        onRetry: retry,
        compact: true,
      }}
      loadingContent={
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-20 w-full" />
        </>
      }
      emptyContent={
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-sm uppercase tracking-wider text-green-700 dark:text-green-400">
            No active incidents
          </span>
        </div>
      }
      hasRenderableData={pegSummaryData !== undefined}
    >
      <div className="flex items-baseline gap-2 pharos-numeric font-bold tracking-tight">
        <span className={`rounded-md text-4xl text-frost-blue ${flashClass}`}>{activeCount}</span>
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">active</span>
      </div>
      {activeRows.length > 4 ? (
        <p className="hidden font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:block">
          Top 4 by deviation
        </p>
      ) : null}
      <ul
        aria-label={
          activeRows.length > 4
            ? `Top 4 of ${activeRows.length} active depegs by deviation`
            : "Active depegs by deviation"
        }
        className="hidden flex-col border-t border-border/50 pt-2.5 font-mono text-xs sm:flex"
      >
        {activeRows.slice(0, 4).map((row, index) => (
          <DepegRow key={row.id} row={row} logoSrc={getLogoSrc(logoMap, row.id)} isLead={index === 0} />
        ))}
      </ul>
    </PulseCard>
  );
}

function DepegRow({
  row,
  logoSrc,
  isLead,
}: {
  row: ActiveRow;
  logoSrc: string | undefined;
  isLead: boolean;
}): React.JSX.Element {
  const arrow = row.bps != null && row.bps < 0 ? "↓" : "↑";
  const colorClass =
    row.bps == null ? "text-muted-foreground" : row.bps < 0
      ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400";
  return (
    <li>
      <Link
        prefetch={false}
        href={buildStablecoinUrl(row.id)}
        className={`pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 py-1 pharos-numeric transition-colors hover:bg-muted/50 ${isLead ? "bg-muted/55" : ""}`}
      >
        <CoinCell logoSrc={logoSrc} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate uppercase tracking-tight text-foreground">{row.symbol}</span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span className={`shrink-0 font-semibold pharos-numeric ${colorClass}`}>
            {row.bps == null ? "Observation unavailable" : (
              <><span aria-hidden="true" className="mr-0.5">{arrow}</span>{Math.abs(row.bps).toFixed(0)}</>
            )}
          </span>
        </span>
        <span className="uppercase pharos-numeric text-muted-foreground">
          {row.ageSec != null ? formatElapsedSeconds(row.ageSec) : "Age unavailable"}
        </span>
      </Link>
    </li>
  );
}
