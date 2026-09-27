"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getLogoSrc, logosById } from "@/lib/logos";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatSignedCompactUsd } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { resolveCoinNetFlow } from "@/lib/mint-burn-coin-helpers";
import { sumMintBurnSignedNets, type MintBurnSignedNetView } from "@/lib/mint-burn-valuation-display";
import { FlowSignedNetValue } from "@/components/flow-valuation-value";

interface Mover {
  id: string;
  symbol: string;
  netFlow24hUsd: number;
  net: MintBurnSignedNetView;
}

export function MintBurnCard({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const query = useMintBurnFlows();
  const { data, isLoading } = query;
  const logos = logosById;
  const logoMap = logos ?? {};

  const { topMovers, totalNet, hasUnavailableNet } = useMemo(() => {
    const activeCoins = (data?.coins ?? []).filter((c) => c.has24hActivity !== false);
    const nets = activeCoins.map((c) => ({ coin: c, net: resolveCoinNetFlow(c, "24h") }));
    // Only displayable nonzero nets rank as movers; an unavailable net is never ranked as 0.
    const movers: Mover[] = nets.flatMap(({ coin, net }) =>
      net.valueUsd == null || net.valueUsd === 0
        ? []
        : [{ id: coin.stablecoinId, symbol: coin.symbol, netFlow24hUsd: net.valueUsd, net }],
    );
    const topMovers = movers
      .sort((a, b) => Math.abs(b.netFlow24hUsd) - Math.abs(a.netFlow24hUsd))
      .slice(0, 3);
    const totalNet = sumMintBurnSignedNets(nets.map(({ net }) => net));
    return { topMovers, totalNet, hasUnavailableNet: totalNet.valueUsd == null };
  }, [data?.coins]);

  const gauge = data?.gauge;
  const state = resolveQueryViewState({
    hasData: data !== undefined,
    isLoading,
    error: query.error,
    // Coins whose net is unavailable still count as activity: "no activity" would be a false claim.
    isEmpty: topMovers.length === 0 && !hasUnavailableNet,
  });

  return (
    <PulseCard
      className={`${embedded ? "h-full min-h-0 gap-3 p-3.5" : "pharos-card-shell gap-4 p-4"} flex flex-col`}
      href="/flows/"
      expandLabel="Open Mint/Burn Flows"
      label="Mint / Burn"
      state={state}
      notice={{
        label: "Mint and burn flow data",
        dataUpdatedAt: query.dataUpdatedAt,
        onRetry: () => void query.refetch(),
        compact: true,
      }}
    >
      <div className="flex flex-col gap-2">
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
                  Net{" "}
                  <FlowSignedNetValue
                    net={totalNet}
                    format={formatSignedCompactUsd}
                    className="pharos-numeric text-foreground/85"
                  />
                </>
              ) : (
                "Net flow"
              )}
            </p>
          </div>
          <ul className="ml-auto flex flex-1 flex-col justify-center gap-1 text-xs" aria-label="Top 24h flow movers">
            {state === "empty" ? (
              <li className="font-mono uppercase tracking-wider text-muted-foreground">No 24h activity</li>
            ) : topMovers.length === 0 ? (
              <li className="font-mono uppercase tracking-wider text-muted-foreground">Net flows unavailable</li>
            ) : (
              topMovers.map((row) => {
                const logoSrc = getLogoSrc(logoMap, row.id);
                return (
                  <li key={row.id}>
                    <Link
                      prefetch={false}
                      href={buildStablecoinUrl(row.id)}
                      className="pharos-focus-ring -mx-1 grid min-h-6 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1 pharos-numeric transition-colors hover:bg-muted/50"
                    >
                      <CoinCell logoSrc={logoSrc} size="compact" />
                      <span className="truncate uppercase tracking-tight text-foreground">{row.symbol}</span>
                      <FlowSignedNetValue
                        net={row.net}
                        format={formatSignedCompactUsd}
                        className={
                          row.netFlow24hUsd >= 0
                            ? "text-green-700 dark:text-green-400"
                            : "text-red-700 dark:text-red-400"
                        }
                      />
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </PulseCard>
  );
}
