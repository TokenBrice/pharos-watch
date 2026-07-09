"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { QueryStateNotice } from "@/components/query-state-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types";

// Coins whose total supply is below this floor are excluded from the
// movers list: a 200% jump on a $50k stablecoin is meaningless next to
// a 5% move on USDT, and showing it would crowd out real signal.
const MIN_TRACKED_MCAP_USD = 10_000_000;

interface Mover {
  id: string;
  symbol: string;
  pctChange: number;
}

function compute(coins: readonly StablecoinData[]): {
  ups: Mover[];
  downs: Mover[];
} {
  const movers: Mover[] = [];
  for (const c of coins) {
    if (!ACTIVE_STABLECOIN_ID_SET.has(c.id)) continue;
    const current = getCirculatingRaw(c);
    const prev = getPrevWeekRaw(c);
    if (current < MIN_TRACKED_MCAP_USD && prev < MIN_TRACKED_MCAP_USD) continue;
    if (prev <= 0) continue;
    const pctChange = ((current - prev) / prev) * 100;
    if (!Number.isFinite(pctChange) || pctChange === 0) continue;
    movers.push({ id: c.id, symbol: c.symbol, pctChange });
  }
  const ups = [...movers].sort((a, b) => b.pctChange - a.pctChange).slice(0, 4);
  const downs = [...movers].sort((a, b) => a.pctChange - b.pctChange).slice(0, 4);
  return { ups, downs };
}

function formatPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  if (Math.abs(pct) >= 100) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}

export function SupplyMovesCard(): React.JSX.Element {
  const query = useStablecoins();
  const { data, isLoading } = query;
  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  const { ups, downs } = useMemo(() => compute(data?.peggedAssets ?? []), [data]);
  const peak = useMemo<Mover | null>(() => {
    const top = ups[0];
    const bottom = downs[0];
    if (!top && !bottom) return null;
    if (!top) return bottom!;
    if (!bottom) return top;
    return Math.abs(top.pctChange) >= Math.abs(bottom.pctChange) ? top : bottom;
  }, [ups, downs]);
  const peakInUps = peak !== null && peak.id === ups[0]?.id;
  const upsDisplay = peakInUps ? ups.slice(1, 4) : ups.slice(0, 3);
  const downsDisplay = !peakInUps && peak !== null ? downs.slice(1, 4) : downs.slice(0, 3);
  const state = resolveQueryViewState({
    hasData: data !== undefined,
    isLoading,
    error: query.error,
    isEmpty: ups.length === 0 && downs.length === 0,
  });

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 overflow-hidden p-4">
      <PulseCardHeader
        href="/screener/"
        expandLabel="Open Screener"
        label={
          <>
            Biggest Supply Moves{" "}
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
              {"· >10M MC"}
            </span>
          </>
        }
      />

      {state === "loading" ? (
        <Skeleton className="h-32 w-full" />
      ) : state === "unavailable" || (state === "stale-with-data" && !peak) ? (
        <QueryStateNotice
          state={state}
          label="Supply move data"
          dataUpdatedAt={query.dataUpdatedAt}
          onRetry={() => void query.refetch()}
        />
      ) : state === "empty" ? (
        <div className="flex flex-1 items-center justify-center text-center font-mono text-xs uppercase tracking-wider text-muted-foreground">
          No qualifying 7-day supply moves
        </div>
      ) : (
        <>
          {state === "stale-with-data" ? (
            <QueryStateNotice
              state={state}
              label="Supply move data"
              dataUpdatedAt={query.dataUpdatedAt}
              onRetry={() => void query.refetch()}
              compact
            />
          ) : null}
          {peak && (
            <Link
              prefetch={false}
              href={buildStablecoinUrl(peak.id)}
              className="pharos-focus-ring -mx-1 flex items-center justify-between gap-3 rounded-sm px-1 py-0.5 pharos-numeric transition-colors hover:bg-muted/50"
              aria-label={`${peak.symbol} — peak 7-day supply mover: ${formatPct(peak.pctChange)}`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {logoMap[peak.id] && (
                  <Image
                    src={logoMap[peak.id]}
                    alt=""
                    width={28}
                    height={28}
                    className="h-7 w-7 shrink-0 rounded-full"
                    aria-hidden
                  />
                )}
                <span className="truncate font-mono text-3xl font-bold uppercase tracking-tight text-foreground">
                  {peak.symbol}
                </span>
              </span>
              <span
                className={`pharos-numeric text-3xl font-bold tracking-tight ${
                  peak.pctChange >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                }`}
              >
                {formatPct(peak.pctChange)}
              </span>
            </Link>
          )}
          <div className="grid grid-cols-2 border-t border-border/50 pt-3">
            <div className="pr-4">
              <MoverList label="Supply up" rows={upsDisplay} logoMap={logoMap} />
            </div>
            <div className="border-l border-border/50 pl-4">
              <MoverList label="Supply down" rows={downsDisplay} logoMap={logoMap} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MoverList({
  label,
  rows,
  logoMap,
}: {
  label: string;
  rows: Mover[];
  logoMap: Record<string, string>;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <ul className="flex flex-col font-mono text-xs">
        {rows.map((row) => {
          const logoSrc = logoMap[row.id];
          return (
            <li key={row.id}>
              <Link
                prefetch={false}
                href={buildStablecoinUrl(row.id)}
                className="pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1 pharos-numeric transition-colors hover:bg-muted/50"
              >
                <CoinCell logoSrc={logoSrc} />
                <span className="truncate uppercase tracking-tight text-foreground">{row.symbol}</span>
                <span
                  className={`font-semibold pharos-numeric ${
                    row.pctChange >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                  }`}
                >
                  {formatPct(row.pctChange)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
