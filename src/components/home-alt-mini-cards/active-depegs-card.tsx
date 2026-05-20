"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { useLogos } from "@/hooks/use-logos";
import { buildStablecoinUrl } from "@/lib/urls";

function formatDuration(ageSec: number): string {
  if (ageSec < 60) return `${Math.max(1, Math.round(ageSec))}s`;
  const minutes = Math.floor(ageSec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

interface ActiveRow {
  id: string;
  symbol: string;
  bps: number;
  ageSec: number;
  direction: "above" | "below";
}

export function ActiveDepegsCard(): React.JSX.Element {
  const { data, isLoading } = useActiveDepegEvents();
  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  const rows = useMemo<ActiveRow[]>(() => {
    const events = data?.events ?? [];
    // eslint-disable-next-line react-hooks/purity -- Date.now() used as a transient fallback before TanStack Query reports dataUpdatedAt; visible result bounded by refetchInterval.
    const nowSec = Math.floor(Date.now() / 1000);
    return events
      .map((ev) => ({
        id: ev.stablecoinId,
        symbol: ev.symbol,
        bps: ev.peakDeviationBps,
        ageSec: Math.max(0, nowSec - ev.startedAt),
        direction: ev.direction,
      }))
      .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps))
      .slice(0, 8);
  }, [data]);

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="pharos-kicker">Active Depegs</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Live · away from peg
        </span>
      </div>

      {isLoading ? (
        <>
          <Skeleton className="h-7 w-32" />
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
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {rows.length}
            </span>
            <span className="text-xs text-muted-foreground">
              of {data?.events.length} live
            </span>
          </div>
          <ul className="mt-auto flex flex-col divide-y divide-border/40 font-mono text-xs">
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
        className="pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 py-1 tabular-nums transition-colors hover:bg-muted/50"
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
          <span className={`shrink-0 tabular-nums ${colorClass}`}>
            <span aria-hidden="true" className="mr-0.5">{arrow}</span>
            {Math.abs(row.bps).toFixed(0)} bps
          </span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(row.ageSec)}
        </span>
      </Link>
    </li>
  );
}
