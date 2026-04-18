"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ReportCardDetail } from "@/components/report-card";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { NoticesAndSummarySection } from "@/components/stablecoin-detail/notices-and-summary-section";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import {
  useStablecoinDetailViewModel,
  type StablecoinDetailSummary,
} from "@/hooks/use-stablecoin-detail-view-model";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import { GOVERNANCE_LABELS } from "@shared/lib/classification";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
import type { StablecoinMeta } from "@shared/types";

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

const McapChart = dynamic(() => import("@/components/mcap-chart").then((mod) => mod.McapChart), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const DepegHistory = dynamic(
  () => import("@/components/depeg-history").then((mod) => mod.DepegHistory),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const FlowsSection = dynamic(() => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowsSection), {
  loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const KeyInfoCard = dynamic(() => import("@/components/key-info-card").then((mod) => mod.KeyInfoCard), {
  loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const YieldDetailSection = dynamic(() => import("@/components/yield-detail-section"), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const DexLiquidityCard = dynamic(
  () => import("@/components/dex-liquidity-card").then((mod) => mod.DexLiquidityCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const CollateralUsageSection = dynamic(
  () => import("@/components/stablecoin-detail/collateral-usage-section").then((mod) => mod.CollateralUsageSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[200px] w-full rounded-xl" />,
  },
);

const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const SafetyScoreHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/safety-score-history-section").then((mod) => mod.SafetyScoreHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[220px] w-full rounded-xl" />,
  },
);

const BASE_DETAIL_SECTIONS = [
  { id: "report-card", label: "Safety" },
  { id: "overview", label: "Overview" },
  { id: "chart", label: "Market" },
  { id: "liquidity", label: "Liquidity" },
  { id: "history", label: "History" },
];

const YIELD_SECTION = { id: "yield", label: "Yield" };
const FLOWS_SECTION = { id: "flows", label: "Flows" };
const RESERVES_SECTION = { id: "reserves", label: "Reserves" };
const PRICE_SECTION = { id: "price", label: "Price" };
const EXPLORE_SECTION = { id: "explore-next", label: "Explore" };

function DetailLoadingShell({ coin, logoSrc }: { coin: StablecoinMeta; logoSrc?: string }) {
  return (
    <div className="space-y-6">
      <StablecoinDetailLoadingShell
        coin={coin}
        logoSrc={logoSrc}
        description="Loading research dossier…"
        statusLabel="Loading…"
      />

      {/* Safety zone skeleton */}
      <div className="mt-10 rounded-xl border border-border/60 p-4">
        <Skeleton className="mb-4 h-6 w-32" />
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
          <Skeleton className="h-[180px] rounded-xl" />
        </div>
      </div>

      {/* Context zone skeleton */}
      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-[200px] rounded-xl" />
        <Skeleton className="h-[200px] rounded-xl" />
      </div>

      {/* Chart zone skeleton */}
      <Skeleton className="mt-12 h-[420px] rounded-xl" />
    </div>
  );
}

interface StablecoinDetailClientProps {
  id: string;
  summary: StablecoinDetailSummary | null;
  coin: StablecoinMeta;
  logoSrc?: string;
}

export default function StablecoinDetailClient({ id, summary, coin, logoSrc }: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const viewModel = useStablecoinDetailViewModel({ id, summary, coin, logoSrc });
  const hasCollateralUsage = useMemo(() => {
    return TRACKED_STABLECOINS.some((c) => {
      if (c.id === id) return false;
      return deriveDependencies(c).some((dep) => dep.id === id);
    });
  }, [id]);
  const {
    data: depegHistoryData,
  } = useInfiniteDepegEvents({
    stablecoinId: id,
    enabled: viewModel.status === "ready" && !viewModel.isNavToken,
    autoLoadAll: viewModel.status === "ready" && !viewModel.isNavToken,
  });

  if (viewModel.status === "loading") {
    return <DetailLoadingShell coin={coin} logoSrc={logoSrc} />;
  }

  if (viewModel.status === "list-error") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <QueryErrorNotice error={viewModel.listError} hasData={false} onRetry={viewModel.handleRetryAll} />
      </div>
    );
  }

  if (viewModel.status === "not-found") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">
          This stablecoin is not part of the tracked Pharos universe.
        </p>
      </div>
    );
  }

  // Scrollspy pill array — conditional on data presence. Section ids are
  // verified against the actual <section id=...> elements below and in the
  // subcomponents (flows-section, overview-section, explore-next-section).
  const hasPriceTransparency =
    !!viewModel.coinData && (viewModel.coinData.price != null || !!viewModel.dexPriceCheck);
  const detailSections = [
    BASE_DETAIL_SECTIONS[0], // Safety
    BASE_DETAIL_SECTIONS[1], // Overview
    ...(hasPriceTransparency ? [PRICE_SECTION] : []),
    ...(viewModel.reserves ? [RESERVES_SECTION] : []),
    BASE_DETAIL_SECTIONS[2], // Market
    ...(viewModel.hasYieldSection ? [YIELD_SECTION] : []),
    BASE_DETAIL_SECTIONS[3], // Liquidity
    ...(viewModel.hasFlows ? [FLOWS_SECTION] : []),
    BASE_DETAIL_SECTIONS[4], // History
    EXPLORE_SECTION,
  ];

  return (
    <div>
      {viewModel.supplyError != null ? (
        <QueryErrorNotice
          error={viewModel.supplyError}
          hasData={viewModel.supplyHistory.length > 0}
          onRetry={viewModel.handleRetryAll}
        />
      ) : null}

      <StaleDataBanner queries={viewModel.staleQueries} />

      {/* ── Identity zone ── */}
      <div className="space-y-4">
        <HeroCard
          coin={viewModel.coin}
          coinData={viewModel.coinData}
          logoSrc={viewModel.logoSrc}
          isNavToken={viewModel.isNavToken}
          mcap={viewModel.mcap}
          supply={viewModel.supply}
          prevDay={viewModel.prevDay}
          prevWeek={viewModel.prevWeek}
          prevMonth={viewModel.prevMonth}
          performanceVsUsd1y={viewModel.performanceVsUsd1y}
          pegRef={viewModel.pegRef}
          deviationBps={viewModel.deviationBps}
          gaugeDeviationBps={viewModel.gaugeDeviationBps}
          pegScoreResult={viewModel.pegScoreResult}
          recordedDepegEventCount={depegHistoryData?.total ?? null}
          liquidityData={viewModel.liquidityData}
          yieldRanking={viewModel.yieldRanking}
          stressSignal={viewModel.stressSignal}
          reportCard={viewModel.reportCard ?? null}
          onOpenFeedback={() => setFeedbackOpen(true)}
        />

        <ExploitNoticeBanner notices={viewModel.coin.notices} />
      </div>

      {/* ── Navigation zone ── */}
      <div className="mt-6">
        <LongformScrollspyNav
          sections={detailSections}
          railLabel="Jump to Section"
          navAriaLabel="Stablecoin detail section navigation"
          rightSlot={
            <div className="hidden items-center gap-2 text-xs sm:flex">
              <Link
                href={buildGovernanceTaxonomyUrl(viewModel.coin.flags.governance)}
                className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                {GOVERNANCE_LABELS[viewModel.coin.flags.governance] ?? viewModel.coin.flags.governance}
              </Link>
              <span className="text-border">|</span>
              <Link
                href={getPrimaryStaticComparisonPageForCoin(viewModel.coin.id)?.href ?? buildLiveCompareUrl([viewModel.coin.id])}
                className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                Compare
              </Link>
            </div>
          }
          showDepthHint
        />
      </div>

      {/* ── Safety zone ── */}
      <div className="mt-10 space-y-4">
        <section id="report-card">
          <p className="pharos-kicker mb-3">Safety Assessment</p>
          {viewModel.reportCard && (
            <ReportCardDetail
              card={viewModel.reportCard}
              liquidityComponents={viewModel.liquidityData?.scoreComponents ?? null}
            />
          )}
          <div className="mt-4">
            <SafetyScoreHistorySection stablecoinId={viewModel.id} />
          </div>
        </section>
      </div>

      {/* ── Context & details zone ── */}
      <div className="mt-12 space-y-6">
        <section id="overview">
          <NoticesAndSummarySection
            stablecoinId={viewModel.id}
            coin={viewModel.coin}
            summary={viewModel.summary}
            reserves={viewModel.reserves}
            reserveFetchError={viewModel.reserveFetchError}
            redemptionBackstop={viewModel.redemptionBackstop}
            isNavToken={viewModel.isNavToken}
            coinData={viewModel.coinData}
            consensusSources={viewModel.consensusSources}
            agreeSources={viewModel.agreeSources}
            dexPriceCheck={viewModel.dexPriceCheck}
          />
        </section>

        <section id="info">
          <KeyInfoCard meta={viewModel.coin} />
        </section>

        {hasCollateralUsage && <CollateralUsageSection stablecoinId={viewModel.id} />}

        {viewModel.hasYieldSection && <YieldDetailSection stablecoinId={viewModel.id} />}
      </div>

      {/* ── Market zone ── */}
      <div className="mt-12 space-y-6">
        <section id="chart">
          <McapChart data={viewModel.supplyHistory} />
        </section>

        <section id="distribution">
          <SectionErrorBoundary name="distribution">
            <DistributionSection stablecoinId={viewModel.id} />
          </SectionErrorBoundary>
        </section>
      </div>

      {/* ── Activity zone ── */}
      <div className="mt-12 space-y-6">
        <section id="liquidity">
          <SectionErrorBoundary name="liquidity">
            <DexLiquidityCard stablecoinId={viewModel.id} />
          </SectionErrorBoundary>
        </section>

        <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />
      </div>

      {/* ── History zone ── */}
      {!viewModel.isNavToken ? (
        <div className="mt-12">
          <section id="history">
            <DepegHistory
              stablecoinId={viewModel.id}
              earliestTrackingDate={viewModel.earliestTrackingDate}
              hasPriceData={viewModel.coinData.price != null}
              depegEventCoverageLimited={viewModel.pegScoreResult?.depegEventCoverageLimited === true}
            />
          </section>
        </div>
      ) : null}

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType="data-correction"
        stablecoinId={viewModel.coin.id}
        stablecoinName={viewModel.coin.name}
        pegValue={viewModel.coinData.price != null ? `$${viewModel.coinData.price.toFixed(6)}` : undefined}
      />
    </div>
  );
}
