"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogos } from "@/hooks/use-logos";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { buildStablecoinUrl } from "@/lib/urls";

function formatNetFlowUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? "+" : "-";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

interface Mover {
  id: string;
  symbol: string;
  netFlow24hUsd: number;
}

export function MintBurnCard(): React.JSX.Element {
  const { data, isLoading } = useMintBurnFlows();
  const { data: logos } = useLogos();
  const logoMap = logos ?? {};

  const { topMovers, totalNet } = useMemo(() => {
    const coins = (data?.coins ?? []).filter(
      (c) => c.has24hActivity !== false && c.netFlow24hUsd !== 0,
    );
    const sorted = [...coins].sort(
      (a, b) => Math.abs(b.netFlow24hUsd) - Math.abs(a.netFlow24hUsd),
    );
    const totalNet = coins.reduce((s, c) => s + c.netFlow24hUsd, 0);
    const topMovers: Mover[] = sorted
      .slice(0, 3)
      .map((c) => ({ id: c.stablecoinId, symbol: c.symbol, netFlow24hUsd: c.netFlow24hUsd }));
    return { topMovers, totalNet };
  }, [data?.coins]);

  const gauge = data?.gauge;

  return (
    <div className="pharos-card-shell flex items-center gap-4 p-4">
      <div className="min-w-0 shrink-0">
        <p className="pharos-kicker">Mint / Burn · 24h</p>
        {isLoading || !gauge ? (
          <Skeleton className="mt-1.5 h-7 w-32" />
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold uppercase tracking-tight text-foreground">
              {gauge.band ?? "—"}
            </span>
            {gauge.score !== null && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {gauge.score >= 0 ? "+" : ""}
                {gauge.score.toFixed(0)}
              </span>
            )}
          </div>
        )}
        <p
          className={`mt-1 font-mono text-[10px] uppercase tracking-wider ${
            totalNet >= 0
              ? "text-green-700 dark:text-green-400"
              : "text-red-700 dark:text-red-400"
          }`}
        >
          {gauge ? `Net ${formatNetFlowUsd(totalNet)}` : "Net flow"}
        </p>
      </div>
      <ul
        className="ml-auto flex flex-1 flex-col justify-center gap-0.5 text-[11px]"
        aria-label="Top 24h flow movers"
      >
        {topMovers.length === 0 ? (
          <li className="font-mono uppercase tracking-wider text-muted-foreground">
            No 24h activity
          </li>
        ) : (
          topMovers.map((row) => {
            const logoSrc = logoMap[row.id];
            return (
              <li key={row.id}>
                <Link
                  prefetch={false}
                  href={buildStablecoinUrl(row.id)}
                  className="pharos-focus-ring -mx-1 grid min-h-6 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1 font-mono tabular-nums transition-colors hover:bg-muted/50"
                >
                  <CoinCell logoSrc={logoSrc} size="compact" />
                  <span className="truncate uppercase tracking-tight text-foreground">
                    {row.symbol}
                  </span>
                  <span
                    className={
                      row.netFlow24hUsd >= 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-red-700 dark:text-red-400"
                    }
                  >
                    {formatNetFlowUsd(row.netFlow24hUsd)}
                  </span>
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
