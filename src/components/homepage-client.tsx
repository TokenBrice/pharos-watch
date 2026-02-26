"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useDepegEvents } from "@/hooks/use-depeg-events";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";
import { StablecoinTable } from "@/components/stablecoin-table";
import { CategoryStats } from "@/components/category-stats";
import { MarketHighlights } from "@/components/market-highlights";
import { TotalMcapChart } from "@/components/total-mcap-chart";
import { PsiHistoryChart } from "@/components/psi-history-chart";
import { PegDiversityChart } from "@/components/peg-diversity-chart";
import { PegHeatmap } from "@/components/peg-heatmap";
import { DepegFeed } from "@/components/depeg-feed";
import { useDailyDigest } from "@/hooks/use-daily-digest";
import { formatDateline } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { FilterBar } from "@/components/filter-bar";
import { FeatureHighlights } from "@/components/feature-highlights";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CRON_15MIN } from "@/hooks/use-api-query";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { cn } from "@/lib/utils";
import { derivePegRates } from "@/lib/peg-rates";
import type { PegSummaryCoin, PegCurrency, GovernanceType } from "@/lib/types";

const DIGEST_STORAGE_KEY = "pharos-digest-open";

function useDigestOpen() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(DIGEST_STORAGE_KEY);
    if (stored === "false") setOpen(false);
  }, []);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      localStorage.setItem(DIGEST_STORAGE_KEY, String(next));
      return next;
    });
  };

  return [open, toggle] as const;
}

export function HomepageClient() {
  const { data, isLoading, error, dataUpdatedAt } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData, isLoading: isPegLoading } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();
  const { data: eventsData } = useDepegEvents();
  const { data: digestData } = useDailyDigest();
  const [pegFilter, setPegFilter] = useState<PegCurrency | "all">("all");
  const [typeFilter, setTypeFilter] = useState<GovernanceType | "all">("all");
  const [digestOpen, toggleDigest] = useDigestOpen();

  const filteredPegCoins = useMemo(
    () =>
      (pegSummaryData?.coins ?? []).filter((c) => {
        if (pegFilter !== "all" && c.pegCurrency !== pegFilter) return false;
        if (typeFilter !== "all" && c.governance !== typeFilter) return false;
        return true;
      }),
    [pegSummaryData, pegFilter, typeFilter],
  );
  const metaById = TRACKED_META_BY_ID;
  const pegScores = useMemo(() => {
    const map = new Map<string, PegSummaryCoin>();
    if (!pegSummaryData?.coins) return map;
    for (const coin of pegSummaryData.coins) {
      map.set(coin.id, coin);
    }
    return map;
  }, [pegSummaryData]);
  const reportCardMap = useMemo(() => {
    if (!reportCardsData?.cards) return undefined;
    return Object.fromEntries(reportCardsData.cards.map((c) => [c.id, c]));
  }, [reportCardsData]);
  const { rates: pegRates } = useMemo(() => derivePegRates(data?.peggedAssets ?? [], metaById, data?.fxFallbackRates), [data, metaById]);
  const filters = useHomepageFilters();

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
          queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_15MIN }]}
        />
      )}

      <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TotalMcapChart />
        <PsiHistoryChart excludeEvents={["Tether DOJ Probe", "IRON Finance"]} />
      </div>

      {digestData?.digest && (
        <section>
          <Card>
            <CardHeader
              className="flex flex-row items-center justify-between cursor-pointer"
              onClick={toggleDigest}
            >
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">
                {digestData.digestTitle || "Daily Recap"}
                {digestData.generatedAt && (
                  <span className="font-normal tracking-wide text-muted-foreground"> · {formatDateline(digestData.generatedAt)}</span>
                )}
              </CardTitle>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform flex-shrink-0",
                  digestOpen && "rotate-180",
                )}
              />
            </CardHeader>
            {digestOpen && (
              <CardContent className="animate-in fade-in duration-200">
                <p className="text-[1.1rem] leading-relaxed text-foreground/90 italic" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                  {digestData.digest}
                </p>
                {digestData.digestExtended && (
                  <p className="text-[1.1rem] leading-relaxed text-foreground/90 italic mt-3" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                    {digestData.digestExtended}
                  </p>
                )}
                <Link
                  href="/digest/"
                  className="inline-block mt-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
                >
                  Read all previous recaps &rarr;
                </Link>
              </CardContent>
            )}
          </Card>
        </section>
      )}

      <FeatureHighlights />

      <section>
        <h2 className="text-xl font-semibold tracking-tight mb-4">Key Stablecoin Data</h2>
        <FilterBar {...filters} />
        <div className="mt-6">
          <StablecoinTable
            data={data?.peggedAssets}
            isLoading={isLoading}
            activeFilters={filters.activeFilters}
            logos={logos}
            pegRates={pegRates}
            searchQuery={filters.searchQuery}
            pegScores={pegScores}
            dexLiquidity={dexLiquidity ?? undefined}
            reportCards={reportCardMap}
            onClearSearch={() => filters.setSearchQuery("")}
            onClearFilters={filters.clearAll}
          />
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight mb-4">What Pharos Tracks</h2>
        <CategoryStats data={data?.peggedAssets} reportCards={reportCardMap} />
      </section>

      <PegDiversityChart />

      <section>
        <PegHeatmap
          coins={filteredPegCoins}
          logos={logos}
          isLoading={isPegLoading}
          pegFilter={pegFilter}
          typeFilter={typeFilter}
          onPegFilterChange={setPegFilter}
          onTypeFilterChange={setTypeFilter}
        />
      </section>

      <section>
        <DepegFeed
          events={eventsData?.events ?? []}
          logos={logos}
        />
      </section>

      <p className="text-xs text-muted-foreground text-center max-w-3xl mx-auto">
        Pharos tracks {TRACKED_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies — USD, EUR, GBP,
        gold, silver, and more — with honest governance classification: {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").length} CeFi,
        {" "}{TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length} CeFi-Dependent, and {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length} DeFi. Live market caps, peg
        deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of
        fallen stablecoins — updated every 15 minutes.
      </p>
      {dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Last updated: {new Date(dataUpdatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
        </p>
      )}
    </div>
  );
}
