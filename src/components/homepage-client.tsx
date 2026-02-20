"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { Search, X } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { StablecoinTable } from "@/components/stablecoin-table";
import { CategoryStats } from "@/components/category-stats";
import { MarketHighlights } from "@/components/market-highlights";
import { TotalMcapChart } from "@/components/total-mcap-chart";
import { PegDiversityChart } from "@/components/peg-diversity-chart";
import { BlacklistSummary } from "@/components/blacklist-summary";
import { CemeterySummary } from "@/components/cemetery-summary";
import { PegTrackerSummary } from "@/components/peg-tracker-summary";
import { LiquiditySummary } from "@/components/liquidity-summary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_5MIN } from "@/hooks/use-api-query";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { derivePegRates } from "@/lib/peg-rates";
import type { FilterTag, PegSummaryCoin } from "@/lib/types";
import { FILTER_TAG_LABELS } from "@/lib/types";

interface FilterGroup {
  label: string;
  options: FilterTag[];
}

const FILTER_GROUPS: FilterGroup[] = [
  {
    label: "Peg",
    options: ["usd-peg", "eur-peg", "gold-peg", "other-peg"],
  },
  {
    label: "Type",
    options: ["centralized", "centralized-dependent", "decentralized"],
  },
  {
    label: "Backing",
    options: ["rwa-backed", "crypto-backed", "algorithmic"],
  },
  {
    label: "Features",
    options: ["yield-bearing", "rwa"],
  },
];

export function HomepageClient() {
  const { data, isLoading, error, dataUpdatedAt } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: bluechipRatings } = useBluechipRatings();
  const { data: dexLiquidity } = useDexLiquidity();
  const metaById = TRACKED_META_BY_ID;
  const pegScores = useMemo(() => {
    const map = new Map<string, PegSummaryCoin>();
    if (!pegSummaryData?.coins) return map;
    for (const coin of pegSummaryData.coins) {
      map.set(coin.id, coin);
    }
    return map;
  }, [pegSummaryData]);
  const pegRates = useMemo(() => derivePegRates(data?.peggedAssets ?? [], metaById, data?.fxFallbackRates), [data, metaById]);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Initialize from URL
  const [groupSelections, setGroupSelections] = useState<Record<string, FilterTag | "">>(() => {
    const initial: Record<string, FilterTag | ""> = {};
    for (const group of FILTER_GROUPS) {
      for (const opt of group.options) {
        if (searchParams.get(group.label.toLowerCase()) === opt) {
          initial[group.label] = opt;
        }
      }
    }
    return initial;
  });
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") ?? "");

  // Sync state changes to URL
  useEffect(() => {
    const params = new URLSearchParams();
    for (const [groupLabel, value] of Object.entries(groupSelections)) {
      if (value) {
        params.set(groupLabel.toLowerCase(), value);
      }
    }
    if (searchQuery) {
      params.set("q", searchQuery);
    }
    const paramString = params.toString();
    const newUrl = paramString ? `/?${paramString}` : "/";
    router.replace(newUrl, { scroll: false });
  }, [groupSelections, searchQuery, router]);



  const handleGroupChange = useCallback((groupLabel: string, value: string) => {
    setGroupSelections((prev) => ({
      ...prev,
      [groupLabel]: value as FilterTag | "",
    }));
  }, []);

  const clearAll = useCallback(() => setGroupSelections({}), []);

  // Collect active filters (one per group that has a selection)
  const activeFilters: FilterTag[] = Object.values(groupSelections).filter(
    (v): v is FilterTag => v !== ""
  );

  const hasFilters = activeFilters.length > 0;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive flex items-center justify-between">
          <span>Failed to load stablecoin data. Please check your connection.</span>
          <button
            onClick={() => window.location.reload()}
            className="text-sm font-medium underline hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none rounded"
          >
            Retry
          </button>
        </div>
      )}
      {!error && (
        <StaleDataBanner
          queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_5MIN }]}
        />
      )}

      <CategoryStats data={data?.peggedAssets} pegRates={pegRates} />

      <TotalMcapChart />

      <PegDiversityChart />

      <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />

      <div className="grid gap-5 lg:grid-cols-2">
        <PegTrackerSummary />
        <LiquiditySummary />
        <BlacklistSummary />
        <CemeterySummary />
      </div>

      <div id="filter-bar" className="space-y-3 border-t pt-4 sticky top-14 z-40 bg-background pb-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Filters
              {hasFilters && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold w-4 h-4">
                  {activeFilters.length}
                </span>
              )}
            </p>
            {hasFilters && (
              <button
                onClick={clearAll}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none rounded"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or symbol..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-8 h-9 sm:h-8 text-xs"
              aria-label="Search stablecoins by name or symbol"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FILTER_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
              <ToggleGroup
                type="single"
                value={groupSelections[group.label] ?? ""}
                onValueChange={(v) => handleGroupChange(group.label, v)}
                className="flex flex-wrap justify-start gap-1"
              >
                {group.options.map((opt) => (
                  <ToggleGroupItem
                    key={opt}
                    value={opt}
                    variant="outline"
                    size="sm"
                    className="text-xs py-1.5 sm:py-1"
                  >
                    {FILTER_TAG_LABELS[opt]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ))}
        </div>
      </div>

      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={activeFilters}
        logos={logos}
        pegRates={pegRates}
        searchQuery={searchQuery}
        pegScores={pegScores}
        bluechipRatings={bluechipRatings ?? undefined}
        dexLiquidity={dexLiquidity ?? undefined}
        onClearSearch={() => setSearchQuery("")}
        onClearFilters={clearAll}
      />

      {dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Last updated: {new Date(dataUpdatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
        </p>
      )}
    </div>
  );
}
