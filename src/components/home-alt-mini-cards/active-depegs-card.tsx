"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { QueryStateNotice } from "@/components/query-state-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary } from "@/hooks/api-hooks";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { resolveQueryViewState } from "@/lib/query-view-state";
import type { DepegEvent, PegSummaryCoin } from "@shared/types";

interface ActiveRow {
  id: string;
  symbol: string;
  bps: number;
  ageSec: number;
  direction: "above" | "below";
}

function hasCurrentActiveDeviation(event: DepegEvent, pegSummaryById: Map<string, PegSummaryCoin>): boolean {
  const pegSummary = pegSummaryById.get(event.stablecoinId);
  return pegSummary?.activeDepeg === true && pegSummary.currentDeviationBps != null;
}

export function ActiveDepegsCard(): React.JSX.Element {
  const activeQuery = useActiveDepegEvents();
  const pegSummaryQuery = usePegSummary();
  const { data, isLoading } = activeQuery;
  const { data: pegSummaryData, isLoading: isPegSummaryLoading } = pegSummaryQuery;
  const logos = logosById;
  const logoMap = logos ?? {};

  const pegSummaryById = useMemo(
    () => new Map((pegSummaryData?.coins ?? []).map((coin) => [coin.id, coin])),
    [pegSummaryData?.coins],
  );

  const activeEvents = useMemo(
    () =>
      (data?.events ?? [])
        .filter((ev) => ACTIVE_STABLECOIN_ID_SET.has(ev.stablecoinId))
        .flatMap((ev) => {
          if (!hasCurrentActiveDeviation(ev, pegSummaryById)) return [];
          const currentDeviationBps = pegSummaryById.get(ev.stablecoinId)?.currentDeviationBps;
          return currentDeviationBps == null ? [] : [{ ...ev, currentDeviationBps }];
        }),
    [data, pegSummaryById],
  );

  const rows = useMemo<ActiveRow[]>(() => {
    // eslint-disable-next-line react-hooks/purity -- Date.now() used as a transient fallback before TanStack Query reports dataUpdatedAt; visible result bounded by refetchInterval.
    const nowSec = Math.floor(Date.now() / 1000);
    return activeEvents
      .map((ev) => ({
        id: ev.stablecoinId,
        symbol: ev.symbol,
        bps: ev.currentDeviationBps,
        ageSec: Math.max(0, nowSec - ev.startedAt),
        direction: ev.currentDeviationBps >= 0 ? ("above" as const) : ("below" as const),
      }))
      .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps))
      .slice(0, 4);
  }, [activeEvents]);

  // Flash only the lead count when the number of active depegs changes (skips mount).
  const flashClass = useFlashOnChange(rows.length);
  const error = activeQuery.error ?? pegSummaryQuery.error;
  const hasActiveData = activeQuery.loadedCount > 0 || (!isLoading && !activeQuery.error);
  const hasData = hasActiveData && pegSummaryData !== undefined;
  const state = resolveQueryViewState({
    hasData,
    isLoading: isLoading || isPegSummaryLoading,
    error,
    isEmpty: rows.length === 0,
  });
  const retry = () => {
    void activeQuery.refetch();
    void pegSummaryQuery.refetch();
  };
  const updatedTimes = [activeQuery.dataUpdatedAt, pegSummaryQuery.dataUpdatedAt].filter((value) => value > 0);
  const dataUpdatedAt = updatedTimes.length > 0 ? Math.min(...updatedTimes) : 0;

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 overflow-hidden p-4">
      <PulseCardHeader href="/depeg/" expandLabel="Open Depeg monitor" label="Total Active Depegs" />

      {state === "loading" ? (
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-20 w-full" />
        </>
      ) : state === "unavailable" || (state === "stale-with-data" && rows.length === 0) ? (
        <QueryStateNotice
          state={state}
          label="Active depeg monitoring"
          dataUpdatedAt={dataUpdatedAt}
          onRetry={retry}
          compact
        />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-sm uppercase tracking-wider text-green-700 dark:text-green-400">
            All on peg
          </span>
        </div>
      ) : (
        <>
          {state === "stale-with-data" ? (
            <QueryStateNotice
              state={state}
              label="Active depeg monitoring"
              dataUpdatedAt={dataUpdatedAt}
              onRetry={retry}
              compact
            />
          ) : null}
          <div className="flex items-baseline gap-2 pharos-numeric font-bold tracking-tight">
            <span className={`rounded-md text-4xl text-frost-blue ${flashClass}`}>{rows.length}</span>
            <span aria-hidden="true" className="text-3xl text-muted-foreground/40">
              /
            </span>
            <span className="text-4xl text-muted-foreground">{activeEvents.length}</span>
          </div>
          <ul className="hidden flex-col border-t border-border/50 pt-2.5 font-mono text-xs sm:flex">
            {rows.map((row, index) => (
              <DepegRow key={row.id} row={row} logoSrc={logoMap[row.id]} isLead={index === 0} />
            ))}
          </ul>
        </>
      )}
    </div>
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
  const arrow = row.direction === "below" ? "↓" : "↑";
  const colorClass =
    row.direction === "below" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400";
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
            <span aria-hidden="true" className="mr-0.5">
              {arrow}
            </span>
            {Math.abs(row.bps).toFixed(0)}
          </span>
        </span>
        <span className="uppercase pharos-numeric text-muted-foreground">{formatElapsedSeconds(row.ageSec)}</span>
      </Link>
    </li>
  );
}
