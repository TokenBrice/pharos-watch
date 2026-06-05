"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePegSummary } from "@/hooks/api-hooks";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { useLogos } from "@/hooks/use-logos";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatElapsedSeconds } from "@shared/lib/format";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";
import type { DepegEvent, PegSummaryCoin } from "@shared/types";

interface ActiveRow {
  id: string;
  symbol: string;
  bps: number;
  ageSec: number;
  direction: "above" | "below";
}

function hasCurrentActiveDeviation(
  event: DepegEvent,
  pegSummaryById: Map<string, PegSummaryCoin>,
): boolean {
  const pegSummary = pegSummaryById.get(event.stablecoinId);
  return pegSummary?.activeDepeg === true && pegSummary.currentDeviationBps != null;
}

export function ActiveDepegsCard(): React.JSX.Element {
  const { data, isLoading } = useActiveDepegEvents();
  const { data: pegSummaryData, isLoading: isPegSummaryLoading } = usePegSummary();
  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  const pegSummaryById = useMemo(
    () => new Map((pegSummaryData?.coins ?? []).map((coin) => [coin.id, coin])),
    [pegSummaryData?.coins],
  );

  const activeEvents = useMemo(
    () => (data?.events ?? [])
      .filter((ev) => CLIENT_ACTIVE_IDS.has(ev.stablecoinId))
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
        direction: ev.currentDeviationBps >= 0 ? "above" as const : "below" as const,
      }))
      .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps))
      .slice(0, 8);
  }, [activeEvents]);

  // Flash only the lead count when the number of active depegs changes (skips mount).
  const flashClass = useFlashOnChange(rows.length);

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="pharos-kicker">Active Depegs</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Live · away from peg
        </span>
      </div>

      {isLoading || isPegSummaryLoading ? (
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-32 w-full" />
        </>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-sm uppercase tracking-wider text-green-700 dark:text-green-400">
            All on peg
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2.5">
            <span
              aria-hidden="true"
              className="animate-pharos-pulse inline-block h-2 w-2 shrink-0 self-center rounded-full bg-red-600 dark:bg-red-500"
            />
            <span className={`rounded-md font-mono text-5xl font-bold tabular-nums tracking-tight text-foreground ${flashClass}`}>
              {rows.length}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              of {activeEvents.length} live
            </span>
          </div>
          <ul className="mt-auto flex flex-col divide-y divide-border/40 font-mono text-[13px]">
            {rows.map((row) => (
              <DepegRow key={row.id} row={row} logoSrc={logoMap[row.id]} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DepegRow({ row, logoSrc }: { row: ActiveRow; logoSrc: string | undefined }): React.JSX.Element {
  const arrow = row.direction === "below" ? "↓" : "↑";
  const colorClass =
    row.direction === "below"
      ? "text-red-700 dark:text-red-400"
      : "text-amber-700 dark:text-amber-400";
  return (
    <li>
      <Link
        href={buildStablecoinUrl(row.id)}
        className="pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 py-1.5 tabular-nums transition-colors hover:bg-muted/50"
      >
        {logoSrc ? (
          <Image
            src={logoSrc}
            alt=""
            width={14}
            height={14}
            className="h-3.5 w-3.5 rounded-full"
            aria-hidden
          />
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate uppercase tracking-tight text-foreground">
            {row.symbol}
          </span>
          <span className={`shrink-0 font-semibold tabular-nums ${colorClass}`}>
            <span aria-hidden="true" className="mr-0.5">{arrow}</span>
            {Math.abs(row.bps).toFixed(0)} bps
          </span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatElapsedSeconds(row.ageSec)}
        </span>
      </Link>
    </li>
  );
}
