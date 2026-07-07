"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowLeft, Compass, Droplets, History as HistoryIcon, Network, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BackToSource } from "@/components/back-to-source";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { LazySection } from "@/components/lazy-section";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { AiSummary } from "@/components/ai-summary";
import { MobileStickySummary } from "@/components/stablecoin-detail/mobile-sticky-summary";
import { MobileRiskSnapshot } from "@/components/stablecoin-detail/mobile-risk-snapshot";
import { ParentVariantsCard } from "@/components/stablecoin-detail/parent-variants-card";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { RedemptionBackstopCard } from "@/components/stablecoin-detail/redemption-backstop-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { UnderlyingAssetCard } from "@/components/stablecoin-detail/underlying-asset-card";
import { MintAuthoritySection } from "@/components/stablecoin-detail/mint-authority-section";
import { RailSafetySummary } from "@/components/stablecoin-detail/rail-safety-summary";
import { ContractDeployments } from "@/components/key-info-card/contract-deployments";
import { CoinNotices } from "@/components/coin-notice";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import { useStablecoinDetailViewModel, type StablecoinDetailSummary } from "@/hooks/use-stablecoin-detail-view-model";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { GOVERNANCE_LABELS, resolveMechanismArchetype } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-mint-authority-view-model";
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";

const FeedbackModal = dynamic(() => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal), {
  ssr: false,
});

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

const McapChart = dynamic(() => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.McapChart), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

// Keep chart-bearing sections dynamic: a static import here re-attaches the
// whole recharts chunk to the eager first load of all 400+ coin pages.
const MarketDataSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.MarketDataSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
  },
);

const DEWSDetail = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DEWSDetail),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const ReportCardDetail = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.ReportCardDetail),
  {
    loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
  },
);

const ReservePanel = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.ReservePanel),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const DepegHistory = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DepegHistory),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const FlowsSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.FlowsSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const FlowHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.FlowHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const BlacklistSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.BlacklistSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const BlacklistHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.BlacklistHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const KeyInfoCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.KeyInfoCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const PegStabilityCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.PegStabilityCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const YieldDetailSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.YieldDetailSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
  },
);

const DexLiquidityCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DexLiquidityCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.DistributionSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const SafetyScoreHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.SafetyScoreHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[220px] w-full rounded-xl" />,
  },
);

const StablecoinDepegResolverCard = dynamic(
  () => import("@/components/stablecoin-detail/sections-bundle").then((mod) => mod.StablecoinDepegResolverCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
  },
);

const DETAIL_SECTION_DEFS = {
  overview: { id: "overview", label: "Risk", icon: Compass },
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
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  staticCoin: StablecoinStaticMeta;
  logoSrc?: string;
  collateralUsageEntries?: readonly CollateralUsageEntry[];
  staticProfileContent?: ReactNode;
  exploreNextContent?: ReactNode;
  faqContent?: ReactNode;
}

export default function StablecoinDetailClient({
  id,
  coin,
  summary,
  staticCoin,
  logoSrc,
  collateralUsageEntries = [],
  staticProfileContent = null,
  exploreNextContent = null,
  faqContent = null,
}: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [activeBannerId, setActiveBannerId] = useState<string>("overview");
  const heroRef = useRef<HTMLDivElement>(null);
  const { ref: overviewGateRef, near: overviewNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: activityGateRef, near: activityNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: historyGateRef, near: historyNear } = useNearViewport<HTMLDivElement>("600px");
  const activityOrHistoryNear = activityNear || historyNear;
  const viewModel = useStablecoinDetailViewModel({
    id,
    coin,
    summary,
    logoSrc,
    supplementalQueryControls: {
      // Mint & Burn Flows renders in the Risk/overview zone (per the Figma
      // coin template) while FlowHistorySection stays in History, so the
      // flows query arms when either region approaches.
      flows: overviewNear || activityOrHistoryNear,
      blacklist: activityOrHistoryNear,
      reserves: overviewNear,
    },
  });
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

  const hasPriceTransparency = viewModel.coinData.price != null || !!viewModel.dexPriceCheck;
  const hasRedemptionBackstop = Boolean(viewModel.redemptionBackstop);
  const frozenNote =
    viewModel.coin.status === "frozen" && viewModel.coin.frozenAt ? (
      <FrozenDataNote frozenAt={viewModel.coin.frozenAt} />
    ) : null;
  const resolvedMechanismArchetype = resolveMechanismArchetype(viewModel.coin, TRACKED_META_BY_ID);
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
    pegReferenceUnavailable: viewModel.pegReferenceUnavailable,
    pegScoreResult: viewModel.pegScoreResult,
    liquidityData: viewModel.liquidityData,
    yieldRanking: viewModel.yieldRanking,
    stressSignal: viewModel.stressSignal,
    reportCard: viewModel.reportCard ?? null,
    verdict: viewModel.verdict,
    variantParent: viewModel.variantParent,
    variantKind: viewModel.coin.variantKind ?? null,
    resolvedMechanismArchetype,
    mintAuthority: viewModel.mintAuthority,
    redemptionBackstop: viewModel.redemptionBackstop ?? null,
  });
  const variantRelationshipCard =
    viewModel.variantParent && viewModel.coin.variantKind ? (
      <UnderlyingAssetCard
        parent={viewModel.variantParent}
        kind={viewModel.coin.variantKind}
        siblings={viewModel.variantSiblings}
      />
    ) : viewModel.childVariants.length > 0 ? (
      <ParentVariantsCard variants={viewModel.childVariants} />
    ) : null;
  const detailSections = [
    DETAIL_SECTION_DEFS.overview,
    DETAIL_SECTION_DEFS.context,
    DETAIL_SECTION_DEFS.liquidity,
    DETAIL_SECTION_DEFS.activity,
    DETAIL_SECTION_DEFS.history,
    DETAIL_SECTION_DEFS.explore,
  ];
  const overviewNotices = viewModel.coin.notices?.filter((n) => n.type !== "danger") ?? [];
  const hasReservesPanel = viewModel.reserves != null || viewModel.reserveFetchError != null;
  const reservesPanel = hasReservesPanel ? (
    <ReservePanel
      coin={viewModel.coin}
      reserves={viewModel.reserves}
      reserveFetchError={viewModel.reserveFetchError}
      onRetry={viewModel.refetchReserves ?? undefined}
      isFetching={viewModel.isFetchingReserves}
    />
  ) : null;
  const showPegChart =
    viewModel.coin.flags.pegCurrency === "USD" &&
    !viewModel.isNavToken &&
    viewModel.coin.flags.yieldBearing !== true &&
    viewModel.supplyHistory.length > 0;
  const archetypeOverride = viewModel.coin.archetypeOverride === true;
  const isWrapperVariant = viewModel.isVariant && !archetypeOverride;
  const parentArchetype =
    isWrapperVariant && viewModel.variantParent
      ? resolveMechanismArchetype(viewModel.variantParent, TRACKED_META_BY_ID)
      : null;
  const showDepegResolver = !viewModel.isNavToken && viewModel.pegScoreResult?.activeDepeg === true;

  return (
    <div>
      {/* The hero renders the coin name as an h2, so the hydrated dossier
          needs its own h1 (the sr-only h1 in the Suspense fallback unmounts
          after hydration). Mirrors StablecoinDetailSeoContent's h1. */}
      <h1 className="sr-only">
        {viewModel.coin.status === "frozen"
          ? `${viewModel.coin.name} (${viewModel.coin.symbol}) frozen stablecoin archive`
          : `${viewModel.coin.name} (${viewModel.coin.symbol}) stablecoin analytics`}
      </h1>
      <BackToSource className="mb-2" />
      <QueryFreshnessNotices
        error={viewModel.supplyError}
        hasData={viewModel.supplyHistory.length > 0}
        onRetry={viewModel.handleRetryAll}
        queries={viewModel.staleQueries}
      />

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

        <MobileRiskSnapshot reportCard={viewModel.reportCard ?? null} />
      </div>

      <MobileStickySummary
        coin={viewModel.coin}
        coinData={viewModel.coinData}
        pegRef={viewModel.pegRef}
        logoSrc={viewModel.logoSrc}
        reportCard={viewModel.reportCard ?? null}
        observeTarget={heroRef}
      />

      {/* ── Content grid ──
        Single column up to xl; at xl+ the Figma coin-template right rail
        (safety summary, news, contracts, price transparency) sits beside the
        dossier while the relocated in-flow copies CSS-hide. The in-flow
        instance always owns the deep-link anchor id. */}
      <div className="mt-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
      <div className="min-w-0">
      {viewModel.summary ? <AiSummary {...viewModel.summary} /> : null}

      {/* ── Navigation zone ──
        The scrollspy stays in the normal vertical flow so the dossier sections
        can use the full content width on desktop. */}
      <LongformScrollspyNav
        sections={detailSections}
        railLabel="Jump to"
        navAriaLabel="Stablecoin detail section navigation"
        emphasis="pill-tabs"
        onActiveChange={setActiveBannerId}
        className="mt-4 lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem+46px)] lg:w-full lg:max-w-none lg:[&>div]:justify-center lg:[&_nav]:flex-none"
        rightSlot={
          <div className="hidden items-center gap-2 text-xs sm:flex lg:hidden">
            <Link
              href={buildGovernanceTaxonomyUrl(viewModel.coin.flags.governance)}
              className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {GOVERNANCE_LABELS[viewModel.coin.flags.governance] ?? viewModel.coin.flags.governance}
            </Link>
            <span className="text-border">|</span>
            <Link
              href={
                getPrimaryStaticComparisonLinkForCoin(viewModel.coin.id)?.href ??
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

      <div className="mt-6">
        <div className="min-w-0">
          {/* ── Overview (the "Risk" tab) ──
            Per the Figma coin template the Risk zone opens with Key Info and
            closes with Mint & Burn Flows (FlowHistorySection stays in History). */}
          <div ref={overviewGateRef} className="space-y-6">
            <SectionBanner id="overview" label="Overview" icon={Compass} active={activeBannerId === "overview"} />
            <section id="info" className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6">
              {/* Figma coin-template split first row: Key Information beside
                  the Peg Stability diagram card when a peg mechanism exists. */}
              <div className={viewModel.coin.pegMechanism ? "grid gap-6 lg:grid-cols-2" : undefined}>
                <KeyInfoCard
                  meta={viewModel.coin}
                  resolvedMechanismArchetype={resolvedMechanismArchetype}
                  isWrapper={isWrapperVariant}
                  parentSymbol={isWrapperVariant ? viewModel.variantParent?.symbol : null}
                  parentArchetype={parentArchetype}
                  variantKind={viewModel.coin.variantKind ?? null}
                  contractsBelowXlOnly
                  splitMechanism={Boolean(viewModel.coin.pegMechanism)}
                />
                {viewModel.coin.pegMechanism ? (
                  <PegStabilityCard
                    meta={viewModel.coin}
                    resolvedMechanismArchetype={resolvedMechanismArchetype}
                    isWrapper={isWrapperVariant}
                    parentSymbol={isWrapperVariant ? viewModel.variantParent?.symbol : null}
                    parentArchetype={parentArchetype}
                    variantKind={viewModel.coin.variantKind ?? null}
                  />
                ) : null}
              </div>
            </section>
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
            {!viewModel.reportCard ? reservesPanel : null}
            {showDepegResolver ? (
              <StablecoinDepegResolverCard stablecoinId={viewModel.id} logoSrc={viewModel.logoSrc} />
            ) : null}
            {overviewNotices.length > 0 ? <CoinNotices notices={overviewNotices} /> : null}
            {!viewModel.isNavToken ? <DEWSDetail stablecoinId={viewModel.id} /> : null}
            {viewModel.hasFlows ? (
              <>
                {frozenNote}
                <LazySection minHeight={320}>
                  <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />
                </LazySection>
              </>
            ) : null}
          </div>

          {/* ── Context ── */}
          <div className="space-y-6">
            <SectionBanner id="context" label="Context" icon={Network} active={activeBannerId === "context"} />
            <ContagionSnapshot
              stablecoinId={viewModel.id}
              variantRelationshipCard={variantRelationshipCard}
              hasCollateralUsage={hasCollateralUsage}
              collateralUsageEntries={collateralUsageEntries}
            />
            <MintAuthoritySection
              profile={viewModel.mintAuthority}
              decentralizationDrag={viewModel.mintAuthorityDecentralizationDrag}
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

            {(hasPriceTransparency || hasRedemptionBackstop) && (
              // Price Transparency and Redemption Backstop each render full-width and stacked;
              // their internal layouts use the horizontal space instead of a cramped 2-column split.
              <div className="grid grid-cols-1 gap-6">
                {hasRedemptionBackstop && viewModel.redemptionBackstop ? (
                  <RedemptionBackstopCard entry={viewModel.redemptionBackstop} />
                ) : null}
                {hasPriceTransparency ? (
                  /* Relocates to the right rail at xl+; this in-flow copy
                     keeps the #price deep-link anchor below that. */
                  <section id="price" aria-label="Price transparency" className="xl:hidden">
                    <PriceTransparencyCard
                      coinData={viewModel.coinData}
                      consensusSources={viewModel.consensusSources ?? []}
                      agreeSources={viewModel.agreeSources ?? []}
                      dexPriceCheck={viewModel.dexPriceCheck}
                    />
                  </section>
                ) : null}
              </div>
            )}
          </div>

          {/* ── Activity ── */}
          <div ref={activityGateRef} className="space-y-6">
            <SectionBanner id="activity" label="Activity" icon={Activity} active={activeBannerId === "activity"} />
            {viewModel.hasYieldSection ? <YieldDetailSection stablecoinId={viewModel.id} /> : null}

            {viewModel.hasBlacklist && (
              <div>
                {frozenNote}
                <SectionErrorBoundary name="blacklist">
                  <LazySection minHeight={320}>
                    <BlacklistSection stablecoinId={viewModel.id} symbol={viewModel.blacklistSymbol!} />
                  </LazySection>
                </SectionErrorBoundary>
              </div>
            )}
          </div>

          {/* ── History ── */}
          <div ref={historyGateRef} className="space-y-6">
            <SectionBanner id="history" label="History" icon={HistoryIcon} active={activeBannerId === "history"} />
            {frozenNote}
            {/* Relocates to the right rail at xl+; this in-flow copy keeps
                the #coin-timeline deep-link anchor below that. */}
            <section id="coin-timeline" aria-label="Coin event timeline" className="xl:hidden">
              <TapeForCoinTeaser coinId={viewModel.id} />
            </section>
            <LazySection minHeight={220}>
              <SafetyScoreHistorySection stablecoinId={viewModel.id} />
            </LazySection>
            {!viewModel.isNavToken ? (
              /* The hero passport "Record" field jumps here; the anchor wraps
                 the lazy gate so it exists before the section mounts. */
              <section
                id="depeg-history"
                className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6"
              >
                <LazySection minHeight={360}>
                  <DepegHistory
                    stablecoinId={viewModel.id}
                    earliestTrackingDate={viewModel.earliestTrackingDate}
                    hasPriceData={viewModel.coinData.price != null}
                    depegEventCoverageLimited={viewModel.pegScoreResult?.depegEventCoverageLimited === true}
                  />
                </LazySection>
              </section>
            ) : null}
            {viewModel.hasFlows ? (
              <LazySection minHeight={320}>
                <FlowHistorySection stablecoinId={viewModel.id} />
              </LazySection>
            ) : null}
            {viewModel.hasBlacklist ? (
              <SectionErrorBoundary name="blacklist-history">
                <LazySection minHeight={320}>
                  <BlacklistHistorySection stablecoinId={viewModel.id} symbol={viewModel.blacklistSymbol!} />
                </LazySection>
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

          {faqContent}
        </div>
        {/* /min-w-0 content column */}
      </div>
      {/* /content wrapper */}
      </div>
      {/* /main column */}

      <aside aria-label="Coin summary rail" className="hidden min-w-0 xl:block">
        <div className="space-y-4">
          <RailSafetySummary items={heroModel.signalRailItems} />
          <TapeForCoinTeaser coinId={viewModel.id} />
          {(viewModel.coin.contracts?.length ?? 0) > 0 ? (
            <div className="pharos-card-shell p-4">
              <ContractDeployments
                coinId={viewModel.coin.id}
                contracts={viewModel.coin.contracts ?? []}
                compact
              />
            </div>
          ) : null}
          {hasPriceTransparency ? (
            <PriceTransparencyCard
              coinData={viewModel.coinData}
              consensusSources={viewModel.consensusSources ?? []}
              agreeSources={viewModel.agreeSources ?? []}
              dexPriceCheck={viewModel.dexPriceCheck}
              compact
            />
          ) : null}
        </div>
      </aside>
      </div>
      {/* /content grid */}

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
