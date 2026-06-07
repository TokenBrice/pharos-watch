"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
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
  const { data, isLoading } = useStablecoins();
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

  return (
    <div className="pharos-card-shell flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="pharos-kicker">Biggest Supply Moves</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          7d · ≥$10M mcap
        </span>
      </div>

      {isLoading || ups.length === 0 ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          {peak && (
            <Link
              prefetch={false}
              href={buildStablecoinUrl(peak.id)}
              className="pharos-focus-ring -mx-1 flex items-center gap-2.5 rounded-sm px-1 py-0.5 tabular-nums transition-colors hover:bg-muted/50"
              aria-label={`${formatPct(peak.pctChange)} ${peak.symbol} Peak 7d supply moved over 7 days`}
              title={`${peak.symbol} supply moved ${formatPct(peak.pctChange)} over 7 days`}
            >
              <span
                className={`font-mono text-5xl font-bold tabular-nums tracking-tight ${
                  peak.pctChange >= 0
                    ? "text-green-700 dark:text-green-400"
                    : "text-red-700 dark:text-red-400"
                }`}
              >
                {formatPct(peak.pctChange)}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
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
                <span className="flex min-w-0 flex-col justify-center leading-none">
                  <span className="truncate text-sm font-bold tracking-tight text-foreground/90">
                    {peak.symbol}
                  </span>
                  <span className="mt-1 whitespace-nowrap text-[10px] tracking-wider">
                    Peak 7d
                  </span>
                </span>
              </span>
            </Link>
          )}
          <div className="mt-auto flex flex-col gap-3">
            <MoverList
              label="Supply up"
              direction="up"
              rows={upsDisplay}
              logoMap={logoMap}
            />
            <MoverList
              label="Supply down"
              direction="down"
              rows={downsDisplay}
              logoMap={logoMap}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MoverList({
  label,
  direction,
  rows,
  logoMap,
}: {
  label: string;
  direction: "up" | "down";
  rows: Mover[];
  logoMap: Record<string, string>;
}): React.JSX.Element {
  const arrow = direction === "up" ? "↗" : "↘";
  const headerClass =
    direction === "up"
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400";
  return (
    <div className="space-y-1">
      <p
        className={`font-mono text-[11px] font-bold uppercase tracking-wider ${headerClass}`}
      >
        <span aria-hidden="true" className="mr-1">{arrow}</span>
        {label}
      </p>
      <ul className="flex flex-col divide-y divide-border/40 font-mono text-[13px]">
        {rows.map((row) => {
          const logoSrc = logoMap[row.id];
          return (
            <li key={row.id}>
              <Link
                prefetch={false}
                href={buildStablecoinUrl(row.id)}
                className="pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1.5 tabular-nums transition-colors hover:bg-muted/50"
              >
                <CoinCell logoSrc={logoSrc} />
                <span className="truncate uppercase tracking-tight text-foreground">
                  {row.symbol}
                </span>
                <span
                  className={`font-semibold tabular-nums ${
                    row.pctChange >= 0
                      ? "text-green-700 dark:text-green-400"
                      : "text-red-700 dark:text-red-400"
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
