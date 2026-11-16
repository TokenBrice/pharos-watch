"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { formatBlacklistValuation } from "@/lib/blacklist-valuation";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types/blacklist";

interface BlacklistDetailStatsProps {
  symbol: BlacklistStablecoin;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

/** Strip columns by how many figures it carries, so the present ones always fill the row. */
const STRIP_GRID_CLASS = ["", "grid-cols-1", "grid-cols-2", "grid-cols-3"] as const;

interface StatCell {
  key: string;
  label: string;
  value: string;
  note: string;
}

/**
 * The module's headline figures as one compact strip (the Mint & Burn net
 * strip's grammar), not three stacked cards. A figure that is unavailable or
 * zero gets no cell: "$0.00 destroyed" is not a finding.
 */
export function BlacklistDetailStats({ symbol, stats, isLoading }: BlacklistDetailStatsProps) {
  if (isLoading || !stats) {
    return <Skeleton className="h-[74px] w-full rounded-lg" />;
  }

  const frozenAddresses = stats.perCoinFrozenAddressCount[symbol] ?? 0;
  const frozenTotal = stats.perCoinFrozenTotal[symbol];
  const destroyedTotal = stats.perCoinDestroyedTotal[symbol];
  const isFigure = (amount: number | null | undefined): amount is number =>
    amount != null && Number.isFinite(amount) && amount !== 0;

  const cells: StatCell[] = [
    ...(frozenAddresses > 0
      ? [{ key: "addresses", label: "Frozen addresses", value: formatDecimal(frozenAddresses, 0, 0), note: "latest action is a freeze" }]
      : []),
    ...(isFigure(frozenTotal)
      ? [{
          key: "frozen",
          label: "Frozen total",
          value: formatBlacklistValuation(frozenTotal, stats.valuationCoverage?.perCoinFrozen[symbol]),
          note: "balance still frozen",
        }]
      : []),
    ...(isFigure(destroyedTotal)
      ? [{
          key: "destroyed",
          label: "Destroyed",
          value: formatBlacklistValuation(destroyedTotal, stats.valuationCoverage?.perCoinDestroyed[symbol]),
          note: "seized and burned, in USD",
        }]
      : []),
  ];
  if (cells.length === 0) return null;

  return (
    <dl
      className={cn(
        "grid overflow-hidden rounded-lg border border-border/60 animate-in fade-in duration-[220ms] motion-reduce:animate-none",
        STRIP_GRID_CLASS[cells.length],
      )}
      aria-label="Blacklist totals"
    >
      {cells.map((cell, index) => (
        <div key={cell.key} className={cn("min-w-0 px-3 py-2.5 sm:px-4", index > 0 && "border-l border-border/60")}>
          <dt className="pharos-label">{cell.label}</dt>
          <dd className="mt-1 pharos-numeric text-lg font-semibold leading-tight text-foreground">{cell.value}</dd>
          <dd className="mt-0.5 text-xs text-muted-foreground">{cell.note}</dd>
        </div>
      ))}
    </dl>
  );
}
