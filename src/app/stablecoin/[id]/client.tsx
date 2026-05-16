"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Compass,
  Droplets,
  History as HistoryIcon,
  Network,
  Sparkles,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ReportCardDetail } from "@/components/report-card";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { LazySection } from "@/components/lazy-section";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { MobileStickySummary } from "@/components/stablecoin-detail/mobile-sticky-summary";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";
import { ParentVariantsCard } from "@/components/stablecoin-detail/parent-variants-card";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { RedemptionBackstopCard } from "@/components/stablecoin-detail/redemption-backstop-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { UnderlyingAssetCard } from "@/components/stablecoin-detail/underlying-asset-card";
import { AiSummary } from "@/components/ai-summary";
import { CoinNotices } from "@/components/coin-notice";
import { DEWSDetail } from "@/components/dews-detail";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import { useStablecoinDetailViewModel, type StablecoinDetailSummary } from "@/hooks/use-stablecoin-detail-view-model";
import { GOVERNANCE_LABELS } from "@shared/lib/classification";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import type { BlacklistStablecoin } from "@shared/types";
import { MarketDataSection } from "@/components/stablecoin-detail/market-data-section";

const FeedbackModal = dynamic(
  () => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal),
  { ssr: false },
);

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

const McapChart = dynamic(() => import("@/components/mcap-chart").then((mod) => mod.McapChart), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const PegDeviationChart = dynamic(
  () => import("@/components/peg-deviation-chart").then((mod) => mod.PegDeviationChart),
  {
    loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
  },
);

const DepegHistory = dynamic(() => import("@/components/depeg-history").then((mod) => mod.DepegHistory), {
  loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
});

const FlowsSection = dynamic(
  () => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowsSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const FlowHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const BlacklistSection = dynamic(
  () => import("@/components/stablecoin-detail/blacklist-section").then((mod) => mod.BlacklistSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const BlacklistHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/blacklist-section").then((mod) => mod.BlacklistHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const KeyInfoCard = dynamic(() => import("@/components/key-info-card").then((mod) => mod.KeyInfoCard), {
  loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const YieldDetailSection = dynamic(() => import("@/components/yield-detail-section"), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const DexLiquidityCard = dynamic(() => import("@/components/dex-liquidity-card").then((mod) => mod.DexLiquidityCard), {
  loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
});

const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const SafetyScoreHistorySection = dynamic(
  () =>
    import("@/components/stablecoin-detail/safety-score-history-section").then((mod) => mod.SafetyScoreHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[220px] w-full rounded-xl" />,
  },
);

const DETAIL_SECTION_DEFS = {
  overview: { id: "overview", label: "Overview", icon: Compass },
  context: { id: "context", label: "Context", icon: Network },
  liquidity: { id: "liquidity", label: "Liquidity", icon: Droplets },
  activity: { id: "activity", label: "Activity", icon: Activity },
  history: { id: "history", label: "History", icon: HistoryIcon },
  explore: { id: "explore", label: "Explore", icon: Sparkles },
} as const;

function DetailLoadingShell({
  coin,
  logoSrc,
  staticProfileContent = null,
}: {
  coin: StablecoinStaticMeta;
  logoSrc?: string;
  staticProfileContent?: ReactNode;
}) {
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

      {staticProfileContent ? <div className="mt-12">{staticProfileContent}</div> : null}

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
  staticCoin: StablecoinStaticMeta;
  logoSrc?: string;
  staticProfileContent?: ReactNode;
  exploreNextContent?: ReactNode;
}

export default function StablecoinDetailClient({
  id,
  summary,
  staticCoin,
  logoSrc,
  staticProfileContent = null,
  exploreNextContent = null,
}: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [activeBannerId, setActiveBannerId] = useState<string>("overview");
  const heroRef = useRef<HTMLDivElement>(null);
  const viewModel = useStablecoinDetailViewModel({ id, summary, logoSrc });
  const hasCollateralUsage = staticCoin.hasCollateralUsage;

  if (viewModel.status === "loading") {
    return <DetailLoadingShell coin={staticCoin} logoSrc={logoSrc} staticProfileContent={staticProfileContent} />;
  }

  if (viewModel.status === "list-error") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Link>
        </Button>
        <QueryErrorNotice error={viewModel.listError} hasData={false} onRetry={viewModel.handleRetryAll} />
      </div>
    );
  }

  if (viewModel.status === "not-found") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Link>
        </Button>
        <p className="text-muted-foreground">This stablecoin is not part of the tracked Pharos universe.</p>
      </div>
    );
  }

  const hasPriceTransparency = !!viewModel.coinData && (viewModel.coinData.price != null || !!viewModel.dexPriceCheck);
  const frozenNote =
    viewModel.coin.status === "frozen" && viewModel.coin.frozenAt ? (
      <FrozenDataNote frozenAt={viewModel.coin.frozenAt} />
    ) : null;
  const heroModel = buildStablecoinDetailHeroViewModel({
    coin: viewModel.coin,
    coinData: viewModel.coinData,
    logoSrc: viewModel.logoSrc,
    isNavToken: viewModel.isNavToken,
    mcap: viewModel.mcap,
    supply: viewModel.supply,
    prevDay: viewModel.prevDay,
    prevWeek: viewModel.prevWeek,
    prevMonth: viewModel.prevMonth,
    performanceVsUsd1y: viewModel.performanceVsUsd1y,
    pegRef: viewModel.pegRef,
    deviationBps: viewModel.deviationBps,
    gaugeDeviationBps: viewModel.gaugeDeviationBps,
    pegScoreResult: viewModel.pegScoreResult,
    liquidityData: viewModel.liquidityData,
    yieldRanking: viewModel.yieldRanking,
    stressSignal: viewModel.stressSignal,
    reportCard: viewModel.reportCard ?? null,
    variantParent: viewModel.variantParent,
    variantKind: viewModel.coin.variantKind ?? null,
  });
  const variantRelationshipCard = viewModel.variantParent && viewModel.coin.variantKind ? (
    <UnderlyingAssetCard
      parent={viewModel.variantParent}
      kind={viewModel.coin.variantKind}
      siblings={viewModel.variantSiblings}
    />
  ) : viewModel.childVariants.length > 0 ? (
    <ParentVariantsCard variants={viewModel.childVariants} />
  ) : null;
  const s = DETAIL_SECTION_DEFS;
  const detailSections = [s.overview, s.context, s.liquidity, s.activity, s.history, s.explore];
  const heroVerdictEnabled = isHeroVerdictEnabled();
  const overviewNotices = viewModel.coin.notices?.filter((n) => n.type !== "danger") ?? [];
  const hasReservesPanel = viewModel.reserves != null || viewModel.reserveFetchError != null;
  const reservesPanel = hasReservesPanel ? (
    <OverviewSection
      coin={viewModel.coin}
      reserves={viewModel.reserves}
      reserveFetchError={viewModel.reserveFetchError}
    />
  ) : null;
  const showPegChart =
    viewModel.coin.flags.pegCurrency === "USD"
    && !viewModel.isNavToken
    && viewModel.supplyHistory.length > 0;

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
      <div ref={heroRef} className="space-y-4">
        <HeroCard model={heroModel} onOpenFeedback={() => setFeedbackOpen(true)} />

        <ExploitNoticeBanner notices={viewModel.coin.notices} />

        {viewModel.coin.status === "frozen" && viewModel.coin.obituary && viewModel.coin.frozenAt ? (
          <FrozenStateBanner
            symbol={viewModel.coin.symbol}
            frozenAt={viewModel.coin.frozenAt}
            obituary={viewModel.coin.obituary}
          />
        ) : null}
      </div>

      <MobileStickySummary
        coin={viewModel.coin}
        coinData={viewModel.coinData}
        pegRef={viewModel.pegRef}
        logoSrc={viewModel.logoSrc}
        reportCard={viewModel.reportCard ?? null}
        observeTarget={heroRef}
      />

      {/* ── Navigation zone ── */}
      <div className="mt-6">
        <LongformScrollspyNav
          sections={detailSections}
          railLabel="Jump to Section"
          navAriaLabel="Stablecoin detail section navigation"
          onActiveChange={setActiveBannerId}
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
                href={
                  getPrimaryStaticComparisonPageForCoin(viewModel.coin.id)?.href ??
                  buildLiveCompareUrl([viewModel.coin.id])
                }
                className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                Compare
              </Link>
            </div>
          }
          showDepthHint
        />
      </div>

      {/* ── Key Info ── */}
      <div className="mt-6">
        <section id="info">
          <KeyInfoCard meta={viewModel.coin} />
        </section>
      </div>

      {/* ── Overview ── */}
      <div className="space-y-6">
        <SectionBanner id="overview" label="Overview" icon={Compass} active={activeBannerId === "overview"} />
        <section id="report-card">
          {viewModel.reportCard && (
            <ReportCardDetail
              card={viewModel.reportCard}
              liquidityComponents={viewModel.liquidityData?.scoreComponents ?? null}
              updatedAtMs={viewModel.reportCardUpdatedAt ?? null}
              rightColumn={reservesPanel}
            />
          )}
        </section>
        {overviewNotices.length > 0 ? <CoinNotices notices={overviewNotices} /> : null}
        {heroVerdictEnabled && viewModel.summary ? <AiSummary {...viewModel.summary} /> : null}
        {!viewModel.isNavToken ? <DEWSDetail stablecoinId={viewModel.id} /> : null}
      </div>

      {/* ── Context ── */}
      <div className="space-y-6">
        <SectionBanner id="context" label="Context" icon={Network} active={activeBannerId === "context"} />
        <ContagionSnapshot
          stablecoinId={viewModel.id}
          variantRelationshipCard={variantRelationshipCard}
          hasCollateralUsage={hasCollateralUsage}
        />
        {showPegChart ? (
          <MarketDataSection
            stablecoinId={viewModel.id}
            supplyHistory={viewModel.supplyHistory}
            pegCurrency={viewModel.coin.flags.pegCurrency}
            frozenNote={frozenNote}
          />
        ) : (
          <section id="chart">
            {frozenNote}
            <LazySection minHeight={420}>
              <McapChart data={viewModel.supplyHistory} stablecoinId={viewModel.id} />
            </LazySection>
          </section>
        )}
        <section id="distribution">
          {frozenNote}
          <SectionErrorBoundary name="distribution">
            <DistributionSection stablecoinId={viewModel.id} />
          </SectionErrorBoundary>
        </section>
      </div>

      {/* ── Liquidity ── */}
      <div className="space-y-6">
        <SectionBanner id="liquidity" label="Liquidity" icon={Droplets} active={activeBannerId === "liquidity"} />
        <section id="dex-liquidity">
          {frozenNote}
          <SectionErrorBoundary name="liquidity">
            <LazySection minHeight={360}>
              <DexLiquidityCard stablecoinId={viewModel.id} />
            </LazySection>
          </SectionErrorBoundary>
        </section>

        {(hasPriceTransparency || viewModel.redemptionBackstop) && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {hasPriceTransparency && viewModel.coinData ? (
              <section id="price" aria-label="Price transparency">
                <PriceTransparencyCard
                  coinData={viewModel.coinData}
                  consensusSources={viewModel.consensusSources ?? []}
                  agreeSources={viewModel.agreeSources ?? []}
                  dexPriceCheck={viewModel.dexPriceCheck}
                />
              </section>
            ) : null}
            {viewModel.redemptionBackstop ? (
              <RedemptionBackstopCard entry={viewModel.redemptionBackstop} />
            ) : null}
          </div>
        )}
      </div>

      {/* ── Activity ── */}
      <div className="space-y-6">
        <SectionBanner id="activity" label="Activity" icon={Activity} active={activeBannerId === "activity"} />
        {viewModel.hasYieldSection ? (
          <YieldDetailSection stablecoinId={viewModel.id} />
        ) : null}

        {viewModel.hasFlows ? frozenNote : null}
        <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />

        {viewModel.hasBlacklist && (
          <div>
            {frozenNote}
            <SectionErrorBoundary name="blacklist">
              <BlacklistSection stablecoinId={viewModel.id} symbol={viewModel.coin.symbol as BlacklistStablecoin} />
            </SectionErrorBoundary>
          </div>
        )}
      </div>

      {/* ── History ── */}
      <div className="space-y-6">
        <SectionBanner id="history" label="History" icon={HistoryIcon} active={activeBannerId === "history"} />
        {frozenNote}
        <section id="coin-timeline" aria-label="Coin event timeline">
          <TapeForCoinTeaser coinId={viewModel.id} />
        </section>
        <LazySection minHeight={220}>
          <SafetyScoreHistorySection stablecoinId={viewModel.id} />
        </LazySection>
        {!viewModel.isNavToken ? (
          <LazySection minHeight={360}>
            <DepegHistory
              stablecoinId={viewModel.id}
              earliestTrackingDate={viewModel.earliestTrackingDate}
              hasPriceData={viewModel.coinData.price != null}
              depegEventCoverageLimited={viewModel.pegScoreResult?.depegEventCoverageLimited === true}
            />
          </LazySection>
        ) : null}
        {viewModel.hasFlows ? <FlowHistorySection stablecoinId={viewModel.id} /> : null}
        {viewModel.hasBlacklist ? (
          <SectionErrorBoundary name="blacklist-history">
            <BlacklistHistorySection
              stablecoinId={viewModel.id}
              symbol={viewModel.coin.symbol as BlacklistStablecoin}
            />
          </SectionErrorBoundary>
        ) : null}
      </div>

      {/* ── Explore ── */}
      {exploreNextContent ? (
        <div className="space-y-6">
          <SectionBanner id="explore" label="Explore" icon={Sparkles} active={activeBannerId === "explore"} />
          {exploreNextContent}
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
