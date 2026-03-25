"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Compass, Search, SlidersHorizontal, X } from "lucide-react";
import { useDexLiquidity, usePegSummary, useReportCards, useStressSignals } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useHomepageFilters, FILTER_GROUPS } from "@/hooks/use-homepage-filters";
import { useStartHereCallout } from "@/hooks/use-start-here-callout";
import { useDataAnnounce } from "@/hooks/use-data-announce";
import { DataLiveRegion } from "@/components/data-live-region";
import { MarketHighlights } from "@/components/market-highlights";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterBar } from "@/components/filter-bar";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { UpcomingStablecoinsSection } from "@/components/upcoming-stablecoins-section";
import { PEG_CURRENCY_COUNT, getDewsRiskLevel, isThreatBand } from "@shared/lib/classification";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS, pegCoinCount } from "@/lib/peg-landing";
import { derivePegRates } from "@shared/lib/peg-rates";
import { FILTER_TAG_LABELS, type PegSummaryCoin } from "@shared/types";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-table-logic";

const CEFI_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized").length;
const CEFI_DEP_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length;
const DEFI_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length;

function SectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

function ChartSkeleton({ className, type = "area", height = "h-[300px]" }: { className?: string; type?: "area" | "bar" | "radar"; height?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-border/50 bg-card/50 ${className}`}>
      {/* Chart header placeholder */}
      <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      {/* Chart area placeholder */}
      <div className="relative px-4 pb-4 pt-3">
        {/* Y-axis labels */}
        <div className="absolute left-4 top-3 bottom-4 flex flex-col justify-between py-2">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-6" />
        </div>
        {/* Chart content */}
        <div className={`ml-12 ${height} relative`}>
          {type === "area" && (
            <>
              <div className="absolute inset-0 bg-gradient-to-b from-muted/60 via-muted/30 to-transparent rounded-lg" />
              <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-muted/40 to-transparent rounded-b-lg" />
              {/* Simulated line path */}
              <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                <path
                  d="M0,80 C50,70 100,90 150,60 S250,40 300,50 S400,30 450,45 S550,35 600,40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/30"
                />
              </svg>
            </>
          )}
          {type === "radar" && (
            <div className="flex h-full items-center justify-center">
              <div className="relative h-4/5 w-4/5">
                <div className="absolute inset-0 rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[15%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[30%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[45%] rounded-full bg-muted-foreground/10" />
              </div>
            </div>
          )}
          {type === "bar" && (
            <div className="flex h-full items-end justify-around gap-2 px-4">
              <Skeleton variant="shimmer" className="h-[40%] w-8" />
              <Skeleton variant="shimmer" className="h-[65%] w-8" />
              <Skeleton variant="shimmer" className="h-[50%] w-8" />
              <Skeleton variant="shimmer" className="h-[80%] w-8" />
              <Skeleton variant="shimmer" className="h-[45%] w-8" />
              <Skeleton variant="shimmer" className="h-[70%] w-8" />
            </div>
          )}
          {/* X-axis labels */}
          <div className="absolute -bottom-6 left-0 right-0 flex justify-between">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      </div>
    </div>
  );
}

const StablecoinTable = dynamic(() => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable), {
  loading: () => <SectionSkeleton className="h-[720px] w-full rounded-xl" />,
});

const CategoryStats = dynamic(() => import("@/components/category-stats").then((mod) => mod.CategoryStats), {
  loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const TotalMcapChart = dynamic(() => import("@/components/total-mcap-chart").then((mod) => mod.TotalMcapChart), {
  loading: () => <ChartSkeleton className="h-[360px] w-full" type="area" />,
});

const PsiHistoryChart = dynamic(() => import("@/components/psi-history-chart").then((mod) => mod.PsiHistoryChart), {
  loading: () => <ChartSkeleton className="h-[360px] w-full" type="area" />,
});

const DEWSSummary = dynamic(() => import("@/components/dews-summary").then((mod) => mod.DEWSSummary), {
  loading: () => <ChartSkeleton className="h-[320px] w-full" type="radar" />,
});

const HomepageFlowOverview = dynamic(
  () => import("@/components/homepage-flow-overview").then((mod) => mod.HomepageFlowOverview),
  {
    loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const HomepageSafetyOverview = dynamic(
  () => import("@/components/homepage-safety-overview").then((mod) => mod.HomepageSafetyOverview),
  {
    loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const PegDiversityChart = dynamic(
  () => import("@/components/peg-diversity-chart").then((mod) => mod.PegDiversityChart),
  {
    loading: () => <ChartSkeleton className="h-[360px] w-full" type="bar" />,
  },
);

const DailyDigest = dynamic(() => import("@/components/daily-digest").then((mod) => mod.DailyDigest), {
  loading: () => <SectionSkeleton className="h-[220px] w-full rounded-xl" />,
});

const PEG_PILL_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/70 bg-background/55 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground sm:min-h-9 sm:py-1";

/** Group pegs into semantic categories for the browse strip. */
type PegGroup = { label: string; pegs: typeof ACTIVE_PEGS };
function groupPegs(pegs: typeof ACTIVE_PEGS): PegGroup[] {
  const fiat: typeof ACTIVE_PEGS = [];
  const commodity: typeof ACTIVE_PEGS = [];
  const other: typeof ACTIVE_PEGS = [];
  for (const peg of pegs) {
    if (peg === "GOLD" || peg === "SILVER") commodity.push(peg);
    else if (peg === "VAR" || peg === "OTHER") other.push(peg);
    else fiat.push(peg);
  }
  const groups: PegGroup[] = [];
  if (fiat.length > 0) groups.push({ label: "Fiat", pegs: fiat });
  if (commodity.length > 0) groups.push({ label: "Commodity", pegs: commodity });
  if (other.length > 0) groups.push({ label: "Other", pegs: other });
  return groups;
}

const PEG_PREVIEW_FIAT = 4;

function PegBrowseStrip({
  pegs,
  pegCoinCount: countFn,
}: {
  pegs: typeof ACTIVE_PEGS;
  pegCoinCount: (peg: (typeof ACTIVE_PEGS)[number]) => number;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupPegs(pegs), [pegs]);

  // Collapsed: first N fiat + all commodity/other
  const collapsedFiatCount = PEG_PREVIEW_FIAT;
  const hasFiatOverflow = groups[0]?.pegs.length > collapsedFiatCount;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="pharos-kicker">Browse by peg</h3>
        {hasFiatOverflow && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="pharos-focus-ring text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Show fewer" : `+${groups[0].pegs.length - collapsedFiatCount} more pegs`}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {groups.map((group) => {
          const visiblePegs =
            !expanded && group.label === "Fiat"
              ? group.pegs.slice(0, collapsedFiatCount)
              : group.pegs;
          return (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mr-0.5">
                {group.label}
              </span>
              {visiblePegs.map((peg) => {
                const slug = PEG_SLUGS[peg];
                if (!slug) return null;
                return (
                  <Link
                    key={peg}
                    href={`/stablecoins/${slug}/`}
                    className={PEG_PILL_CLASS}
                  >
                    {PEG_LABELS_SHORT[peg]} ({countFn(peg)})
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StartHereCallout({ onOpenStartHere }: { onOpenStartHere: () => void }) {
  return (
    <section
      className="pharos-card-shell overflow-hidden border border-border/40 px-4 py-4 sm:px-5"
      style={{ background: 'var(--surface-onboarding-gradient)', boxShadow: 'var(--elevation-rest)' }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-[var(--brand-accent)]">
            <Compass className="h-4 w-4" aria-hidden="true" />
            <p className="pharos-kicker text-[var(--brand-accent)]">New to Pharos?</p>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              Start with the route that matches your job, not the full feature list.
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The /start/ page explains what the core signals mean and points you to the right surface for market
              monitoring, single-coin research, yield, comparison, or alerts.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild className="h-10 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary/90">
            <Link href="/start/" onClick={onOpenStartHere}>
              Start Here
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full px-5"
            onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
          >
            <Search className="h-4 w-4" />
            Search a coin
          </Button>
        </div>
      </div>
    </section>
  );
}

function HomepageSectionBand({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="pharos-kicker">{eyebrow}</p>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function HomepageClient() {
  const { isReady: startHereReady, shouldShow: shouldShowStartHereCallout, retireCallout } = useStartHereCallout();
  const [showFilters, setShowFilters] = useState(false);
  const { data, isLoading, error: pricesError, dataUpdatedAt, refetch: refetchPrices } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg } = usePegSummary();
  const {
    data: dexLiquidity,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
  const { data: stressData } = useStressSignals();

  const dewsRiskLevel = useMemo(
    () => getDewsRiskLevel(
      stressData?.signals
        ? Object.values(stressData.signals).map((s) => s.band).filter(isThreatBand)
        : [],
    ),
    [stressData],
  );
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
  const { rates: pegRates } = useMemo(
    () => derivePegRates(data?.peggedAssets ?? [], TRACKED_META_BY_ID, data?.fxFallbackRates),
    [data],
  );
  const filters = useHomepageFilters();
  const filteredRowCount = useMemo(() => {
    const trackedIds = buildTrackedIdSet(filters.activeFilters, reportCardMap);
    return filterStablecoins(data?.peggedAssets, trackedIds, filters.searchQuery).length;
  }, [data?.peggedAssets, filters.activeFilters, filters.searchQuery, reportCardMap]);
  const globalError = pricesError ?? pegError ?? liquidityError ?? reportCardsError;
  const handleRetry = useCallback(() => {
    void Promise.allSettled([refetchPrices(), refetchPeg(), refetchLiquidity(), refetchReportCards()]);
  }, [refetchPeg, refetchLiquidity, refetchPrices, refetchReportCards]);

  // Announce data updates to screen readers
  useDataAnnounce([
    { dataUpdatedAt, dataName: "Market data" },
    { dataUpdatedAt: pegUpdatedAt, dataName: "Peg summary" },
    { dataUpdatedAt: liqUpdatedAt, dataName: "Liquidity" },
    { dataUpdatedAt: rcUpdatedAt, dataName: "Report cards" },
  ]);

  return (
    <div className="space-y-6">
      <DataLiveRegion />
      <QueryErrorNotice error={globalError} hasData={!!data?.peggedAssets?.length} onRetry={handleRetry} />
      <StaleDataBanner
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: pricesError, hasData: !!data?.peggedAssets?.length },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegUpdatedAt,
            error: pegError,
            hasData: !!pegSummaryData?.coins?.length,
          },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: liquidityError, hasData: !!dexLiquidity },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
          },
        ]}
      />

      {startHereReady && shouldShowStartHereCallout ? <StartHereCallout onOpenStartHere={retireCallout} /> : null}

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="table">
        <section aria-label="Tracked stablecoin universe">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <HomepageSectionBand
              eyebrow="Tracked Universe"
              title="Key Stablecoin Data"
              description="Filter and sort across all tracked stablecoins."
            />
            {/* Active filter chips now shown inline in the table toolbar */}
          </div>
          <PegBrowseStrip pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
          <div className="mt-4">
          <StablecoinTable
            data={data?.peggedAssets}
            isLoading={isLoading}
            activeFilters={filters.activeFilters}
            toolbarActions={
              <>
                {filters.activeFilters.length > 0 ? (
                  <>
                    {filters.activeFilters.map((tag) => {
                      const group = FILTER_GROUPS.find((g) => g.options.includes(tag));
                      return (
                        <button
                          key={tag}
                          onClick={() => group && filters.handleGroupChange(group.label, "all")}
                          className="pharos-focus-ring inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-primary/20"
                          aria-label={`Remove ${FILTER_TAG_LABELS[tag]} filter`}
                        >
                          {FILTER_TAG_LABELS[tag]}
                          <X className="h-3 w-3 text-muted-foreground" aria-hidden />
                        </button>
                      );
                    })}
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{filteredRowCount} rows</span>
                  </>
                ) : (
                  <span className="hidden text-[11px] text-muted-foreground/60 sm:inline">
                    Filter by peg, backing, governance, grade
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowFilters((prev) => !prev)}
                  className="gap-1.5 text-xs text-muted-foreground"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {showFilters ? "Hide" : "Filters"}
                  {filters.hasFilters && (
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                      {filters.activeFilters.length}
                    </span>
                  )}
                </Button>
              </>
            }
            filterPanel={showFilters ? <FilterBar {...filters} /> : null}
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
      </SectionErrorBoundary>

      <SectionErrorBoundary name="digest">
        <DailyDigest variant="preview" />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="upcoming-stablecoins">
        <UpcomingStablecoinsSection logos={logos} />
      </SectionErrorBoundary>

      <section
        aria-label="Core monitoring"
        className="space-y-6 -mx-3 px-3 py-6 rounded-2xl sm:-mx-4 sm:px-4"
        style={{ borderTop: '2px solid var(--zone-divider)', background: 'var(--surface-zone-monitoring)' }}
      >
        <HomepageSectionBand
          eyebrow="Core Monitoring"
          title="Live system stress and market health"
          description="Depeg risk, flows, safety distribution, and the market-wide stability regime."
        />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
          <SectionErrorBoundary name="dews-radar">
            <section aria-label="DEWS depeg early warning" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="status" aria-label={`DEWS risk level: ${dewsRiskLevel}`} className={`border-l-4 pl-3 transition-colors duration-300 ${
                  dewsRiskLevel === "danger"
                    ? "border-l-red-500"
                    : dewsRiskLevel === "warning"
                      ? "border-l-amber-500"
                      : dewsRiskLevel === "alert"
                        ? "border-l-orange-500"
                        : "border-l-transparent"
                }`}>
                  <h2 className="text-xl font-semibold tracking-tight">DEWS: Depeg Early Warning System</h2>
                </div>
                <Link
                  href="/depeg/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  View Depeg Tracker
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <DEWSSummary logos={logos} showHeader={false} />
            </section>
          </SectionErrorBoundary>
          <SectionErrorBoundary name="mint-burn-snapshot">
            <HomepageFlowOverview />
          </SectionErrorBoundary>
        </div>

        <SectionErrorBoundary name="charts">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="flex h-full flex-col space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Safety Scores Overview</h2>
                <Link
                  href="/safety-scores/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  View Safety Scores
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <HomepageSafetyOverview
                cards={reportCardsData?.cards}
                peggedAssets={data?.peggedAssets}
                className="h-full"
              />
            </section>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Pharos Stability Index History</h2>
                <Link
                  href="/stability-index/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  More Information on PSI
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <PsiHistoryChart excludeEvents={["Tether DOJ Probe", "IRON Finance"]} showHeader={false} />
            </section>
          </div>
        </SectionErrorBoundary>
      </section>

      <section
        aria-label="Research surfaces"
        className="space-y-6 -mx-3 px-3 py-6 rounded-2xl sm:-mx-4 sm:px-4"
        style={{ borderTop: '2px solid var(--zone-divider)', background: 'var(--surface-zone-research)' }}
      >
        <HomepageSectionBand
          eyebrow="Research Surfaces"
          title="Distribution and market structure"
          description="Cohort mix, total market-cap regime changes, and non-USD peg growth."
        />

        <SectionErrorBoundary name="stats">
          <section>
            <h2 className="mb-4 text-xl font-semibold tracking-tight">Stablecoin Market Structure</h2>
            <CategoryStats data={data?.peggedAssets} reportCards={reportCardMap} />
          </section>
        </SectionErrorBoundary>

        <SectionErrorBoundary name="marketcap">
          <TotalMcapChart />
        </SectionErrorBoundary>

        <SectionErrorBoundary name="peg-diversity">
          <PegDiversityChart />
        </SectionErrorBoundary>
      </section>

      <section aria-label="About Pharos" className="space-y-2 border-t border-border/50 pt-6">
        <p className="mx-auto max-w-5xl text-center text-xs leading-relaxed text-muted-foreground">
          Pharos tracks {ACTIVE_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies with honest
          governance classification:{" "}
          {CEFI_COUNT} CeFi, {CEFI_DEP_COUNT} CeFi-Dependent, and {DEFI_COUNT} DeFi. Use the dashboard
          for live market ranking, then drill into peg stress, safety, liquidity, blacklist risk, flows, and dead-coin
          history on the specialist routes. Core market data refreshes every 15 minutes; slower diagnostics run on
          their own cadences.
        </p>
        {dataUpdatedAt > 0 && (
          <p className="text-center text-xs text-muted-foreground">
            Last updated:{" "}
            {new Date(dataUpdatedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </p>
        )}
      </section>
    </div>
  );
}
