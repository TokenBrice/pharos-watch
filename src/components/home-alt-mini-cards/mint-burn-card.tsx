"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCardHeader } from "@/components/home-alt-mini-cards/pulse-card-header";
import { QueryStateNotice } from "@/components/query-state-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogos } from "@/hooks/use-logos";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatSignedCompactUsd } from "@shared/lib/format";
import { buildStablecoinUrl } from "@/lib/urls";
import { resolveQueryViewState } from "@/lib/query-view-state";

interface Mover {
  id: string;
  symbol: string;
  netFlow24hUsd: number;
}

export function MintBurnCard({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const query = useMintBurnFlows();
  const { data, isLoading } = query;
  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  const { topMovers, totalNet } = useMemo(() => {
    const coins = (data?.coins ?? []).filter((c) => c.has24hActivity !== false && c.netFlow24hUsd !== 0);
    const sorted = [...coins].sort((a, b) => Math.abs(b.netFlow24hUsd) - Math.abs(a.netFlow24hUsd));
    const totalNet = coins.reduce((s, c) => s + c.netFlow24hUsd, 0);
    const topMovers: Mover[] = sorted
      .slice(0, 3)
      .map((c) => ({ id: c.stablecoinId, symbol: c.symbol, netFlow24hUsd: c.netFlow24hUsd }));
    return { topMovers, totalNet };
  }, [data?.coins]);

  const gauge = data?.gauge;
  const state = resolveQueryViewState({
    hasData: data !== undefined,
    isLoading,
    error: query.error,
    isEmpty: topMovers.length === 0,
  });

  return (
    <div className={`${embedded ? "h-full min-h-0 gap-3 p-3.5" : "pharos-card-shell gap-4 p-4"} flex flex-col`}>
      <PulseCardHeader href="/flows/" expandLabel="Open Mint/Burn Flows" label="Mint / Burn" />
      {state === "unavailable" ? (
        <QueryStateNotice state={state} label="Mint and burn flow data" onRetry={() => void query.refetch()} compact />
      ) : (
        <div className="flex flex-col gap-2">
          {state === "stale-with-data" ? (
            <QueryStateNotice
              state={state}
              label="Mint and burn flow data"
              dataUpdatedAt={query.dataUpdatedAt}
              onRetry={() => void query.refetch()}
              compact
            />
          ) : null}
          <div className="flex items-center gap-4">
            <div className="min-w-0 shrink-0">
              {state === "loading" ? (
                <Skeleton className="h-9 w-32" />
              ) : gauge ? (
                <div className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                  {gauge.band ? gauge.band.charAt(0) + gauge.band.slice(1).toLowerCase() : "—"}
                </div>
              ) : null}
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {gauge ? (
                  <>
                    {gauge.score !== null && (
                      <span className="pharos-numeric">
                        {gauge.score >= 0 ? "+" : ""}
                        {gauge.score.toFixed(0)} ·{" "}
                      </span>
                    )}
                    Net <span className="pharos-numeric text-foreground/85">{formatSignedCompactUsd(totalNet)}</span>
                  </>
                ) : (
                  "Net flow"
                )}
              </p>
            </div>
            <ul className="ml-auto flex flex-1 flex-col justify-center gap-1 text-xs" aria-label="Top 24h flow movers">
              {state === "empty" ? (
                <li className="font-mono uppercase tracking-wider text-muted-foreground">No 24h activity</li>
              ) : (
                topMovers.map((row) => {
                  const logoSrc = logoMap[row.id];
                  return (
                    <li key={row.id}>
                      <Link
                        prefetch={false}
                        href={buildStablecoinUrl(row.id)}
                        className="pharos-focus-ring -mx-1 grid min-h-6 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1 pharos-numeric transition-colors hover:bg-muted/50"
                      >
                        <CoinCell logoSrc={logoSrc} size="compact" />
                        <span className="truncate uppercase tracking-tight text-foreground">{row.symbol}</span>
                        <span
                          className={
                            row.netFlow24hUsd >= 0
                              ? "text-green-700 dark:text-green-400"
                              : "text-red-700 dark:text-red-400"
                          }
                        >
                          {formatSignedCompactUsd(row.netFlow24hUsd)}
                        </span>
                      </Link>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
