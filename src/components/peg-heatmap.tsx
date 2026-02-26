"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { DeviationIcon } from "@/components/severity-icon";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { deviationBgClass } from "@/lib/severity-colors";
import type { PegSummaryCoin, PegCurrency, GovernanceType } from "@/lib/types";
import { GOVERNANCE_LABELS_SHORT } from "@/lib/classification";

interface PegHeatmapProps {
  coins: PegSummaryCoin[];
  logos?: Record<string, string>;
  isLoading: boolean;
  pegFilter: PegCurrency | "all";
  typeFilter: GovernanceType | "all";
  onPegFilterChange: (v: PegCurrency | "all") => void;
  onTypeFilterChange: (v: GovernanceType | "all") => void;
  searchQuery?: string;
  onSearchChange?: (v: string) => void;
}

const PEG_OPTIONS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All Pegs" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

const TYPE_OPTIONS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: GOVERNANCE_LABELS_SHORT.centralized },
  { value: "centralized-dependent", label: GOVERNANCE_LABELS_SHORT["centralized-dependent"] },
  { value: "decentralized", label: GOVERNANCE_LABELS_SHORT.decentralized },
];

/** Compound tile classes for heatmap cells, derived from shared severity thresholds. */
function deviationTileClass(absBps: number): string {
  if (absBps >= 500) return "bg-red-500/20 border-red-500/50 text-red-600 dark:text-red-400";
  if (absBps >= 200) return "bg-orange-500/15 border-orange-500/40 text-orange-600 dark:text-orange-400";
  if (absBps >= 50) return "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400";
  return "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400";
}

function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`px-2.5 py-1.5 sm:py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function PegHeatmap({
  coins,
  logos,
  isLoading,
  pegFilter,
  typeFilter,
  onPegFilterChange,
  onTypeFilterChange,
  searchQuery,
  onSearchChange,
}: PegHeatmapProps) {
  const prefetch = usePrefetchStablecoin();
  const sorted = useMemo(() => {
    return [...coins]
      .filter((c) => c.currentDeviationBps !== null)
      .sort((a, b) => Math.abs(b.currentDeviationBps!) - Math.abs(a.currentDeviationBps!));
  }, [coins]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Live Peg Deviation
            </CardTitle>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${deviationBgClass(0)}`} /> &lt;50bps</div>
              <div className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${deviationBgClass(50)}`} /> 50-200</div>
              <div className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${deviationBgClass(200)}`} /> 200-500</div>
              <div className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${deviationBgClass(500)}`} /> &gt;500bps</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips options={PEG_OPTIONS} value={pegFilter} onChange={onPegFilterChange} />
            <FilterChips options={TYPE_OPTIONS} value={typeFilter} onChange={onTypeFilterChange} />
            {onSearchChange && (
              <div className="relative w-full sm:w-44">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery ?? ""}
                  onChange={(e) => onSearchChange(e.target.value)}
                  className="pl-8 pr-7 h-9 sm:h-8 text-xs"
                  aria-label="Search stablecoins by name or symbol"
                />
                {searchQuery && (
                  <button
                    onClick={() => onSearchChange("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
            {Array.from({ length: 30 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No coins match filters</p>
        ) : (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
              {sorted.map((coin) => {
                const absBps = Math.abs(coin.currentDeviationBps!);
                const sign = coin.currentDeviationBps! >= 0 ? "+" : "";
                const dex = coin.dexPriceCheck;
                const dexDisagrees = dex && !dex.agrees;
                return (
                  <Link
                    key={coin.id}
                    href={`/stablecoin/${coin.id}`}
                    className={`relative flex flex-col items-center justify-center gap-1 p-2 rounded-lg border transition-transform hover:scale-105 ${deviationTileClass(absBps)}`}
                    title={dexDisagrees
                      ? `DEX price disagrees: $${dex.dexPrice.toFixed(4)} (${dex.dexDeviationBps >= 0 ? "+" : ""}${dex.dexDeviationBps}bps) from ${dex.sourcePools} pool${dex.sourcePools !== 1 ? "s" : ""} (${formatCurrency(dex.sourceTvl)} TVL)`
                      : undefined}
                    onMouseEnter={() => prefetch(coin.id)}
                  >
                    {dexDisagrees && (
                      <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-white" aria-label="DEX price disagrees">!</span>
                    )}
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                    <span className="text-[10px] font-medium truncate max-w-full">{coin.symbol}</span>
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-mono font-semibold">
                      <DeviationIcon absBps={absBps} className="h-2.5 w-2.5" />
                      {sign}{coin.currentDeviationBps}
                    </span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
