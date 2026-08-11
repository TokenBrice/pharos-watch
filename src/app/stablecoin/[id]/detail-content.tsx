"use client";

import { useEffect } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import Link from "next/link";
import { ChartPie, Droplet, HeartPulse, Hourglass, Scale, Sparkles } from "lucide-react";
import { AiSummary } from "@/components/ai-summary";
import { BackToSource } from "@/components/back-to-source";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { ContractDeployments } from "@/components/key-info-card/contract-deployments";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { HeroCard, HeroDesktopIdentityToolbar } from "@/components/stablecoin-detail/hero-card";
import { MobileStickySummary } from "@/components/stablecoin-detail/mobile-sticky-summary";
import { ListingStateBanner } from "@/components/stablecoin-detail/listing-state-banner";
import { ParentVariantsCard } from "@/components/stablecoin-detail/parent-variants-card";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { ScoreConstructionPanel } from "@/components/stablecoin-detail/score-construction-panel";
import { MechanismReviewPanel } from "@/components/stablecoin-detail/mechanism-review-panel";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { TransferReviewView } from "@/lib/transfer-review";
import { buildSafetyScoreV9AccessRows } from "@/lib/stablecoin-safety-score-v9-presentation";
import { RailSafetySummary } from "@/components/stablecoin-detail/rail-safety-summary";
import { UnderlyingAssetCard } from "@/components/stablecoin-detail/underlying-asset-card";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import { revealAnchorId } from "@/lib/anchor-reveal";
import { GOVERNANCE_LABELS, resolveMechanismArchetype } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildDetailSharedModules, type DetailSharedModules } from "./detail-shared-modules";
import { DetailHistoryExploreSections } from "./detail-history-explore-sections";
import { DetailLiquidityActivitySections } from "./detail-liquidity-activity-sections";
import { FeedbackModal, ReservePanel } from "./detail-lazy-sections";
import { DetailRiskContextSections } from "./detail-risk-context-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

const DETAIL_SECTIONS = [
  { id: "overview", label: "Risk", icon: Scale },
  { id: "context", label: "Context", icon: ChartPie },
  { id: "liquidity", label: "Market", icon: Droplet },
  { id: "activity", label: "Activity", icon: HeartPulse },
  { id: "history", label: "History", icon: Hourglass },
  { id: "explore", label: "Explore", icon: Sparkles },
] as const;

interface DetailContentProps {
  activeBannerId: string;
  activityGateRef: Ref<HTMLDivElement>;
  collateralUsageEntries: readonly CollateralUsageEntry[];
  exploreNextContent: ReactNode;
  faqContent: ReactNode;
  feedbackOpen: boolean;
  heroRef: RefObject<HTMLDivElement | null>;
  historyGateRef: Ref<HTMLDivElement>;
  mechanismBacking: MechanismBackingView | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  mechanismReview: MechanismReviewView | null;
  transferReview: TransferReviewView | null;
  onActiveBannerChange: (id: string) => void;
  onFeedbackOpenChange: (open: boolean) => void;
  overviewGateRef: Ref<HTMLDivElement>;
  staticHasCollateralUsage: boolean;
  viewModel: ReadyDetailViewModel;
}

function DetailIdentity({
  heroModel,
  heroRef,
  onOpenFeedback,
  viewModel,
}: {
  heroModel: ReturnType<typeof buildStablecoinDetailHeroViewModel>;
  heroRef: RefObject<HTMLDivElement | null>;
  onOpenFeedback: () => void;
  viewModel: ReadyDetailViewModel;
}) {
  return (
    <>
      <h1 className="sr-only">
        {viewModel.coin.status === "frozen"
          ? `${viewModel.coin.name} (${viewModel.coin.symbol}) frozen stablecoin archive`
          : viewModel.coin.status === "delisted"
            ? `${viewModel.coin.name} (${viewModel.coin.symbol}) delisted stablecoin record`
            : viewModel.coin.status === "quarantined"
              ? `${viewModel.coin.name} (${viewModel.coin.symbol}) quarantined stablecoin record`
              : `${viewModel.coin.name} (${viewModel.coin.symbol}) stablecoin analytics`}
      </h1>
      <BackToSource className="mb-2" />
      <QueryFreshnessNotices
        error={viewModel.supplyError}
        hasData={viewModel.supplyHistory.length > 0}
        onRetry={viewModel.handleRetryAll}
        queries={viewModel.staleQueries}
      />
      <HeroDesktopIdentityToolbar model={heroModel} onOpenFeedback={onOpenFeedback} />
      <MobileStickySummary
        coin={viewModel.coin}
        coinData={viewModel.coinData}
        pegRef={viewModel.pegRef}
        logoSrc={viewModel.logoSrc}
        reportCard={viewModel.reportCard ?? null}
        observeTarget={heroRef}
      />
    </>
  );
}

function DetailNavigation({
  onActiveChange,
  viewModel,
}: {
  onActiveChange: (id: string) => void;
  viewModel: ReadyDetailViewModel;
}) {
  return (
    <LongformScrollspyNav
      sections={DETAIL_SECTIONS}
      railLabel="Jump to"
      navAriaLabel="Stablecoin detail section navigation"
      emphasis="pill-tabs"
      onActiveChange={onActiveChange}
      className="mt-4 lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem+46px)] lg:w-full lg:max-w-none lg:[&>div]:justify-center lg:[&_nav]:flex-none"
      rightSlot={(
        <div className="hidden items-center gap-2 text-xs sm:flex lg:hidden">
          <Link
            href={buildGovernanceTaxonomyUrl(viewModel.coin.flags.governance)}
            className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {GOVERNANCE_LABELS[viewModel.coin.flags.governance] ?? viewModel.coin.flags.governance}
          </Link>
          <span className="text-border">|</span>
          <Link
            href={getPrimaryStaticComparisonLinkForCoin(viewModel.coin.id)?.href ?? buildLiveCompareUrl([viewModel.coin.id])}
            className="pharos-focus-ring rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            Compare
          </Link>
        </div>
      )}
    />
  );
}

function DetailSummaryRail({
  heroModel,
  mechanismReview,
  sharedModules,
  transferReview,
  viewModel,
}: {
  heroModel: ReturnType<typeof buildStablecoinDetailHeroViewModel>;
  mechanismReview: MechanismReviewView | null;
  sharedModules: DetailSharedModules;
  transferReview: TransferReviewView | null;
  viewModel: ReadyDetailViewModel;
}) {
  const hasPriceTransparency = viewModel.coinData.price != null || Boolean(viewModel.dexPriceCheck);
  return (
    <aside aria-label="Coin summary rail" className="hidden min-w-0 self-stretch xl:block">
      <div className="space-y-4 pb-4">
        <RailSafetySummary items={heroModel.signalRailItems} />
        {viewModel.reportCard ? <ScoreConstructionPanel card={viewModel.reportCard} compact /> : null}
        {viewModel.reportCard ? (
          <AccessPosturePanel
            rows={buildSafetyScoreV9AccessRows(viewModel.reportCard)}
            review={transferReview}
            compact
          />
        ) : null}
        {sharedModules.collateralization}
        {sharedModules.backingMechanics}
        {sharedModules.custody}
        {sharedModules.controlPosture}
        {sharedModules.freezeSeizure}
        {sharedModules.failureDomains}
        <MechanismReviewPanel review={mechanismReview} compact />
        {sharedModules.bridging}
        {sharedModules.regulatoryStanding}
        {hasPriceTransparency ? (
          <PriceTransparencyCard
            coinData={viewModel.coinData}
            consensusSources={viewModel.consensusSources ?? []}
            agreeSources={viewModel.agreeSources ?? []}
            dexPriceCheck={viewModel.dexPriceCheck}
            compact
          />
        ) : null}
        {(viewModel.coin.contracts?.length ?? 0) > 0 ? (
          <ContractDeployments coinId={viewModel.coin.id} contracts={viewModel.coin.contracts ?? []} compact />
        ) : null}
        <TapeForCoinTeaser coinId={viewModel.id} />
      </div>
    </aside>
  );
}

export function DetailContent({
  activeBannerId,
  activityGateRef,
  collateralUsageEntries,
  exploreNextContent,
  faqContent,
  feedbackOpen,
  heroRef,
  historyGateRef,
  mechanismBacking,
  mechanismCollateralization,
  mechanismReview,
  transferReview,
  onActiveBannerChange,
  onFeedbackOpenChange,
  overviewGateRef,
  staticHasCollateralUsage,
  viewModel,
}: DetailContentProps) {
  // Direct loads with a hash land before lazy sections settle; opening the
  // enclosing disclosures for the hash target keeps deep links honest now
  // that module detail folds by default.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (hash) revealAnchorId(hash);
  }, []);
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
  const frozenNote = viewModel.coin.status === "frozen" && viewModel.coin.frozenAt
    ? <FrozenDataNote frozenAt={viewModel.coin.frozenAt} />
    : null;
  const variantRelationshipCard = viewModel.variantParent && viewModel.coin.variantKind ? (
    <UnderlyingAssetCard
      parent={viewModel.variantParent}
      kind={viewModel.coin.variantKind}
      siblings={viewModel.variantSiblings}
    />
  ) : viewModel.childVariants.length > 0 ? (
    <ParentVariantsCard variants={viewModel.childVariants} />
  ) : null;
  // One declaration per rail module, rendered by both mount sites (WS8.11).
  const sharedModules = buildDetailSharedModules({
    mechanismBacking,
    mechanismCollateralization,
    viewModel,
  });
  const reservesLoading = viewModel.featureStates.reserves.status === "loading";
  const reservesPanel = viewModel.reserves != null || viewModel.reserveFetchError != null || reservesLoading ? (
    <ReservePanel
      coin={viewModel.coin}
      reserves={viewModel.reserves}
      reserveFetchError={viewModel.reserveFetchError}
      onRetry={viewModel.refetchReserves ?? undefined}
      isFetching={viewModel.isFetchingReserves}
      isLoading={reservesLoading}
    />
  ) : null;

  return (
    <div>
      <DetailIdentity
        heroModel={heroModel}
        heroRef={heroRef}
        onOpenFeedback={() => onFeedbackOpenChange(true)}
        viewModel={viewModel}
      />
      <div className="mt-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
        <div className="min-w-0">
          <div ref={heroRef} className="space-y-4">
            <HeroCard model={heroModel} onOpenFeedback={() => onFeedbackOpenChange(true)} />
            <ExploitNoticeBanner notices={viewModel.coin.notices} />
            <ListingStateBanner coin={viewModel.coin} />
            {viewModel.coin.status === "frozen" && viewModel.coin.obituary && viewModel.coin.frozenAt ? (
              <FrozenStateBanner
                symbol={viewModel.coin.symbol}
                frozenAt={viewModel.coin.frozenAt}
                obituary={viewModel.coin.obituary}
              />
            ) : null}
          </div>
          <div className="mt-4">
            {viewModel.summary ? <AiSummary {...viewModel.summary} /> : null}
            <DetailNavigation onActiveChange={onActiveBannerChange} viewModel={viewModel} />
          </div>
          <div className="mt-4 min-w-0 space-y-6">
            <DetailRiskContextSections
              activeBannerId={activeBannerId}
              collateralUsageEntries={collateralUsageEntries}
              frozenNote={frozenNote}
              hasCollateralUsage={staticHasCollateralUsage}
              mechanismReview={mechanismReview}
              sharedModules={sharedModules}
              transferReview={transferReview}
              overviewGateRef={overviewGateRef}
              reservesPanel={reservesPanel}
              variantRelationshipCard={variantRelationshipCard}
              viewModel={viewModel}
            />
            <DetailLiquidityActivitySections
              activeBannerId={activeBannerId}
              activityGateRef={activityGateRef}
              frozenNote={frozenNote}
              viewModel={viewModel}
            />
            <DetailHistoryExploreSections
              activeBannerId={activeBannerId}
              exploreNextContent={exploreNextContent}
              faqContent={faqContent}
              frozenNote={frozenNote}
              historyGateRef={historyGateRef}
              viewModel={viewModel}
            />
          </div>
        </div>
        <DetailSummaryRail
          heroModel={heroModel}
          mechanismReview={mechanismReview}
          sharedModules={sharedModules}
          transferReview={transferReview}
          viewModel={viewModel}
        />
      </div>
      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={onFeedbackOpenChange}
        defaultType="data-correction"
        stablecoinId={viewModel.coin.id}
        stablecoinName={viewModel.coin.name}
        pegValue={viewModel.coinData.price != null ? `$${viewModel.coinData.price.toFixed(6)}` : undefined}
      />
    </div>
  );
}
