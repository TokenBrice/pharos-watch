"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Compass, Megaphone, Search } from "lucide-react";
import { useDexLiquidity, usePegSummary, useReportCards, useStressSignals } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";
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
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS, pegCoinCount } from "@/lib/peg-landing";
import { derivePegRates } from "@shared/lib/peg-rates";
import type { PegSummaryCoin } from "@shared/types";

function SectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

function ChartSkeleton({ className, type = "area" }: { className?: string; type?: "area" | "bar" | "radar" | "line" }) {
  const heightClass = className?.match(/h-\[?\d+(?:px)?\]?/) || "h-[300px]";
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
        <div className={`ml-12 ${heightClass} relative`}>
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
              <Skeleton className="h-[40%] w-8" />
              <Skeleton className="h-[65%] w-8" />
              <Skeleton className="h-[50%] w-8" />
              <Skeleton className="h-[80%] w-8" />
              <Skeleton className="h-[45%] w-8" />
              <Skeleton className="h-[70%] w-8" />
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

const PEG_PREVIEW_COUNT = 5;
const CAMPAIGN_END_AT = Date.parse("2026-03-20T00:00:00Z");
const CAMPAIGN_POST_URL = "https://x.com/PharosWatch/status/2032107485629202921";

function CampaignCallout() {
  return (
    <section
      aria-label="Pharos community campaign"
      className="pharos-card-shell relative overflow-hidden border px-4 py-4 sm:px-5"
      style={{
        background: 'var(--surface-campaign-gradient)',
        borderColor: 'var(--surface-campaign-border)',
        boxShadow: 'var(--surface-campaign-shadow)',
      }}
      data-no-theme-transition
    >
      <div 
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-56 md:block"
        style={{
          background: 'radial-gradient(circle at center, oklch(0.82 0.09 230 / 0.22), transparent 68%)',
        }}
      />
      <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-sky-900/78 dark:text-sky-100/76">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-600/20 bg-white/80 px-2.5 py-1 shadow-sm dark:border-sky-400/15 dark:bg-white/[0.06]">
              <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
              Community Campaign
            </span>
            <span className="inline-flex rounded-full border border-sky-600/18 bg-white/65 px-2.5 py-1 font-mono tabular-nums shadow-sm dark:border-sky-400/15 dark:bg-white/[0.04]">
              $3,000 pool
            </span>
            <span className="inline-flex rounded-full border border-sky-600/18 bg-white/65 px-2.5 py-1 shadow-sm dark:border-sky-400/15 dark:bg-white/[0.04]">
              Ends March 19, 2026
            </span>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white sm:text-xl">
              Spot the signal. Tell the story.
            </h2>
            <p className="max-w-3xl text-sm leading-relaxed text-slate-700 dark:text-slate-200/78">
              Threads, blog posts, videos, podcasts, and useful product feedback can all earn from the Pharos push.
              Top prize is <span className="font-mono tabular-nums text-slate-950 dark:text-white">$1,250</span> from
              a <span className="font-mono tabular-nums text-slate-950 dark:text-white">$3,000</span> reward pool.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 xl:items-end">
          <a
            href={CAMPAIGN_POST_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-slate-950/12 bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-[0_10px_24px_oklch(0_0_0_/0.18)] transition-[transform,background-color,box-shadow] hover:bg-slate-900 hover:shadow-[0_14px_28px_oklch(0_0_0_/0.22)] active:translate-y-[1px] dark:border-white/12 dark:bg-white dark:text-slate-950 dark:hover:bg-white/90"
            aria-label="View campaign details on X"
          >
            View campaign
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <p className="max-w-sm text-xs leading-relaxed text-slate-700/88 dark:text-slate-200/70 xl:text-right">
            Useful bug reports and data corrections count too. The feedback button stays live across every page.
          </p>
        </div>
      </div>
    </section>
  );
}

function PegBrowseSection({
  pegs,
  pegCoinCount,
}: {
  pegs: typeof ACTIVE_PEGS;
  pegCoinCount: (peg: (typeof ACTIVE_PEGS)[number]) => number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? pegs : pegs.slice(0, PEG_PREVIEW_COUNT);

  return (
    <div className="mt-8 space-y-2.5">
      <h2 className="pharos-kicker">Browse By Peg</h2>
      <div className="flex flex-wrap gap-2">
        {visible.map((peg) => {
          const slug = PEG_SLUGS[peg];
          if (!slug) return null;
          return (
            <Link
              key={peg}
              href={`/stablecoins/${slug}/`}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/70 bg-background/55 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground sm:min-h-0 sm:py-1"
            >
              {PEG_LABELS_SHORT[peg]} ({pegCoinCount(peg)})
            </Link>
          );
        })}
        {!expanded && pegs.length > PEG_PREVIEW_COUNT && (
          <button
            onClick={() => setExpanded(true)}
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/70 bg-background/55 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground sm:min-h-0 sm:py-1"
          >
            +{pegs.length - PEG_PREVIEW_COUNT} more
          </button>
        )}
      </div>
    </div>
  );
}

function StartHereCallout({ onOpenStartHere }: { onOpenStartHere: () => void }) {
  return (
    <section 
      className="pharos-card-shell overflow-hidden border border-black/7 px-4 py-4 shadow-[0_16px_34px_oklch(0_0_0_/0.08)] sm:px-5 dark:border-white/10 dark:shadow-[0_20px_42px_oklch(0_0_0_/0.16)]"
      style={{ background: 'var(--surface-onboarding-gradient)' }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 text-sky-700 dark:text-sky-200/82">
            <Compass className="h-4 w-4" aria-hidden="true" />
            <p className="pharos-kicker text-sky-700 dark:text-sky-200/82">New to Pharos?</p>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white sm:text-xl">
              Start with the route that matches your job, not the full feature list.
            </h2>
            <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200/74">
              The /start/ page explains what the core signals mean and points you to the right surface for market
              monitoring, single-coin research, yield, comparison, or alerts.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild className="h-10 rounded-full bg-slate-950 px-5 text-white hover:bg-slate-900 dark:bg-white dark:text-slate-950 dark:hover:bg-white/90">
            <Link href="/start/" onClick={onOpenStartHere}>
              Start Here
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full border-black/10 bg-white/70 px-5 text-slate-900 hover:bg-white hover:text-slate-950 dark:border-white/15 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1] dark:hover:text-white"
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
  const [showCampaignCallout, setShowCampaignCallout] = useState(true);
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
  const metaById = TRACKED_META_BY_ID;

  // Compute DEWS risk level for visual styling
  const dewsRiskLevel = useMemo(() => {
    if (!stressData?.signals) return "calm";
    const signals = Object.values(stressData.signals);
    const dangerCount = signals.filter((s) => s.band === "DANGER").length;
    const warningCount = signals.filter((s) => s.band === "WARNING").length;
    const alertCount = signals.filter((s) => s.band === "ALERT").length;
    
    if (dangerCount > 0) return "danger";
    if (warningCount > 0) return "warning";
    if (alertCount > 0) return "alert";
    return "calm";
  }, [stressData]);
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
    () => derivePegRates(data?.peggedAssets ?? [], metaById, data?.fxFallbackRates),
    [data, metaById],
  );
  const filters = useHomepageFilters();
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

  useEffect(() => {
    const remainingMs = CAMPAIGN_END_AT - Date.now();
    const timeoutId = window.setTimeout(() => setShowCampaignCallout(false), Math.max(0, remainingMs));
    return () => window.clearTimeout(timeoutId);
  }, []);

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

      {showCampaignCallout ? <CampaignCallout /> : null}

      {startHereReady && shouldShowStartHereCallout ? <StartHereCallout onOpenStartHere={retireCallout} /> : null}

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="digest">
        <DailyDigest variant="preview" />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="table">
        <section>
          <h2 className="mb-4 text-xl font-semibold tracking-tight text-foreground">Key Stablecoin Data</h2>
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
          <PegBrowseSection pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
        </section>
      </SectionErrorBoundary>

      <section className="space-y-6 border-t border-border/50 pt-6">
        <HomepageSectionBand
          eyebrow="Core Monitoring"
          title="Live system stress and market health"
          description="Use these surfaces to scan depeg risk, mint and burn pressure, safety distribution, and the market-wide stability regime before drilling into a single coin."
        />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
          <SectionErrorBoundary name="dews-radar">
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className={`border-l-4 pl-3 transition-colors duration-300 ${
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

      <section className="space-y-6 border-t border-border/50 pt-6">
        <HomepageSectionBand
          eyebrow="Research Surfaces"
          title="Distribution and market structure"
          description="These charts shift from live monitoring to deeper context: cohort mix, total market-cap regime changes, and the growth of non-USD pegs across the ecosystem."
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

        <PegDiversityChart />
      </section>

      <section className="space-y-2 border-t border-border/50 pt-6">
        <p className="mx-auto max-w-5xl text-center text-xs leading-loose text-muted-foreground">
          Pharos tracks {ACTIVE_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies (USD, EUR,
          GBP, gold, silver, and more) with honest governance classification:{" "}
          {ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized").length} CeFi,{" "}
          {ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length} CeFi-Dependent, and{" "}
          {ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length} DeFi. Live market caps, peg
          deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of fallen stablecoins. Updated
          every 15 minutes.
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
