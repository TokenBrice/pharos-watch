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
import { formatCurrency, formatNativePrice } from "@shared/lib/format";
import { deviationBgClass, deviationTileClass } from "@/lib/severity-colors";
import { buildStablecoinUrl } from "@/lib/urls";
import type { PegSummaryCoin, PegCurrency, GovernanceType } from "@shared/types";
import { PEG_FILTER_OPTIONS, GOVERNANCE_FILTER_OPTIONS } from "@shared/lib/classification";

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
  fallbackPegTypes?: string[];
  hideFilters?: boolean;
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
          className={`px-2.5 py-1.5 sm:py-1 min-h-11 sm:min-h-0 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
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
  fallbackPegTypes,
  hideFilters,
}: PegHeatmapProps) {
  type PegHeatmapCoinWithDeviation = PegSummaryCoin & { currentDeviationBps: number };
  const prefetch = usePrefetchStablecoin();
  const fallbackPegs = useMemo(() => new Set(fallbackPegTypes ?? []), [fallbackPegTypes]);
  const sorted = useMemo(() => {
    return [...coins]
      .filter((coin): coin is PegHeatmapCoinWithDeviation => coin.currentDeviationBps !== null)
      .sort((a, b) => Math.abs(b.currentDeviationBps) - Math.abs(a.currentDeviationBps));
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
              <div className="flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ${deviationBgClass(0)}`} /> &lt;50bps</div>
              <div className="flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ${deviationBgClass(50)}`} /> 50-200</div>
              <div className="flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ${deviationBgClass(200)}`} /> 200-500</div>
              <div className="flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ${deviationBgClass(500)}`} /> &gt;500bps</div>
            </div>
          </div>
          {!hideFilters && (
            <div className="flex flex-wrap items-center gap-3">
              <FilterChips options={PEG_FILTER_OPTIONS} value={pegFilter} onChange={onPegFilterChange} />
              <FilterChips options={GOVERNANCE_FILTER_OPTIONS} value={typeFilter} onChange={onTypeFilterChange} />
              {onSearchChange && (
                <div className="relative w-full sm:w-44">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search..."
                    value={searchQuery ?? ""}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="pl-8 pr-7 h-11 sm:h-8 text-xs"
                    aria-label="Search stablecoins by name or symbol"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => onSearchChange("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Clear search"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {fallbackPegs.size > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Peg references for some currencies use ECB FX rates (not market-derived).
          </p>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-2 min-[375px]:grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
            {Array.from({ length: 30 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No coins match filters</p>
        ) : (
          <>
            <div className="grid grid-cols-2 min-[375px]:grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
              {sorted.map((coin) => {
                const absBps = Math.abs(coin.currentDeviationBps);
                const sign = coin.currentDeviationBps >= 0 ? "+" : "";
                const dex = coin.dexPriceCheck;
                const dexDisagrees = dex && !dex.agrees;
                const confirmRequired = coin.primaryTrust === "confirm_required";
                const provenance = [coin.priceSource ?? "unknown source", coin.priceConfidence ?? "unknown confidence"].join(" · ");
                return (
                  <Link
                    key={coin.id}
                    href={buildStablecoinUrl(coin.id)}
                    className={`relative flex flex-col items-center justify-center gap-1 p-2 rounded-lg border hover:bg-muted/40 transition-colors ${deviationTileClass(absBps)}`}
                    title={dexDisagrees
                      ? `DEX price disagrees: ${formatNativePrice(dex.dexPrice, "USD", 1)} (${dex.dexDeviationBps >= 0 ? "+" : ""}${dex.dexDeviationBps}bps) from ${dex.sourcePools} pool${dex.sourcePools !== 1 ? "s" : ""} (${formatCurrency(dex.sourceTvl)} TVL)`
                      : provenance}
                    onMouseEnter={() => prefetch(coin.id)}
                  >
                    {dexDisagrees && (
                      <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-white" aria-label="DEX price disagrees">!</span>
                    )}
                    {confirmRequired && (
                      <span
                        className="absolute -top-1 -left-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-slate-700 px-1 text-[8px] font-bold text-white"
                        aria-label="Primary price requires confirmation"
                        title={`Primary price requires confirmation (${provenance})`}
                      >
                        ?
                      </span>
                    )}
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                    <span className="text-xs font-medium truncate max-w-full">{coin.symbol}</span>
                    <span className="inline-flex items-center gap-0.5 text-xs font-mono font-semibold">
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
