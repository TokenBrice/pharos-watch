"use client";

import { useEffect } from "react";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { ReactNode, Ref, RefObject } from "react";
import Link from "next/link";
import { ChartPie, Droplet, HeartPulse, Hourglass, Scale, Sparkles } from "lucide-react";
import { AiSummary } from "@/components/ai-summary";
import { BackToSource } from "@/components/back-to-source";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { HeroCard, HeroDesktopIdentityToolbar } from "@/components/stablecoin-detail/hero-card";
import { MobileStickySummary } from "@/components/stablecoin-detail/mobile-sticky-summary";
import { ListingStateBanner } from "@/components/stablecoin-detail/listing-state-banner";
import { ParentVariantsCard } from "@/components/stablecoin-detail/parent-variants-card";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { Badge } from "@/components/ui/badge";
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
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { alignAnchorAfterHydration } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";
import { GOVERNANCE_LABELS } from "@shared/lib/classification";
import { scoreToGrade } from "@shared/lib/report-card-core";
import type { AiSummaryClaimValues } from "@shared/types";
import { buildDetailSharedModules, type DetailSharedModules, type StructuralModuleEntry } from "./detail-shared-modules";
import { DetailHistoryExploreSections } from "./detail-history-explore-sections";
import { DetailLiquidityActivitySections } from "./detail-liquidity-activity-sections";
import { FeedbackModal } from "./detail-lazy-sections";
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
  viewModel: ReadyDetailViewModel;
}

function DetailIdentity({
  heroModel,
  heroRef,
  onOpenFeedback,
  viewModel,
}: {
  heroModel: ReadyDetailViewModel["hero"];
  heroRef: RefObject<HTMLDivElement | null>;
  onOpenFeedback: () => void;
  viewModel: ReadyDetailViewModel;
}) {
  return (
    <>
      {/* The page H1 is server-rendered permanently by StablecoinDetailSeoContent
          (src/components/stablecoin-detail/static-seo-content.tsx) so it survives
          with JavaScript disabled. Re-adding it here would produce two H1s after
          hydration. */}
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
      sections={DETAIL_SECTIONS.filter((section) => section.id !== "activity" || viewModel.hasYieldSection || viewModel.hasBlacklist)}
      railLabel="Jump to"
      navAriaLabel="Stablecoin detail section navigation"
      emphasis="pill-tabs"
      onActiveChange={onActiveChange}
      className="mt-4 lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem)] lg:w-full lg:max-w-none lg:[&>div]:justify-center lg:[&_nav]:flex-none"
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

/**
 * One rail row per structural evidence card: title + the card's own verdict
 * chip, linking to the single in-flow mount inside its pillar group. The
 * bounded re-alignment absorbs lazy sections settling above the target.
 */
function RailEvidenceIndex({ sharedModules }: { sharedModules: DetailSharedModules }) {
  const groups = [
    { label: "Backing", entries: sharedModules.backing },
    { label: "Control", entries: sharedModules.control },
  ].filter((group) => group.entries.length > 0);
  if (groups.length === 0) return null;
  return (
    <RailCard title="Evidence index" ariaLabel="Evidence index">
      <div className="space-y-3 px-4 pb-4">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="pharos-kicker pb-1">{group.label}</p>
            <ul className="divide-y divide-border/40">
              {group.entries.map((entry) => (
                <RailEvidenceIndexRow key={entry.key} entry={entry} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </RailCard>
  );
}

function RailEvidenceIndexRow({ entry }: { entry: StructuralModuleEntry }) {
  return (
    <li>
      <a
        href={`#${entry.anchorId}`}
        onClick={(event) => {
          event.preventDefault();
          window.history.pushState(null, "", `#${entry.anchorId}`);
          alignAnchorAfterHydration(entry.anchorId);
        }}
        className="pharos-focus-ring group flex min-h-9 items-center justify-between gap-3 rounded-sm py-1.5 text-sm"
      >
        <span className="min-w-0 truncate text-foreground/90 underline-offset-2 group-hover:underline">
          {entry.title}
        </span>
        {entry.chip ? (
          <Badge variant="outline" className={cn("shrink-0 text-[11px] font-medium", entry.chip.toneClass)}>
            {entry.chip.label}
          </Badge>
        ) : null}
      </a>
    </li>
  );
}

function DetailSummaryRail({
  heroModel,
  sharedModules,
  transferReview,
  viewModel,
}: {
  heroModel: ReadyDetailViewModel["hero"];
  sharedModules: DetailSharedModules;
  transferReview: TransferReviewView | null;
  viewModel: ReadyDetailViewModel;
}) {
  const hasPriceTransparency = viewModel.coinData.price != null || Boolean(viewModel.coinData.nominalPriceReference) || Boolean(viewModel.dexPriceCheck);
  // An index, not a second page: Safety + Access posture + one row per
  // structural card, then the compact reference cards. Full evidence cards
  // live once, in flow, in their pillar group.
  return (
    <aside aria-label="Coin summary rail" className="hidden min-w-0 self-stretch xl:block">
      <div className="space-y-4 pb-4">
        <RailSafetySummary items={heroModel.signalRailItems} />
        {viewModel.reportCard ? (
          <AccessPosturePanel
            rows={buildSafetyScoreV9AccessRows(viewModel.reportCard)}
            review={transferReview}
            compact
          />
        ) : null}
        <RailEvidenceIndex sharedModules={sharedModules} />
        {hasPriceTransparency ? (
          <PriceTransparencyCard
            coinData={viewModel.coinData}
            consensusSources={viewModel.consensusSources ?? []}
            agreeSources={viewModel.agreeSources ?? []}
            dexPriceCheck={viewModel.dexPriceCheck}
            compact
          />
        ) : null}
        <KeyLinksCard meta={viewModel.coin} />
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
  viewModel,
}: DetailContentProps) {
  // The scrollspy owns its top-level hashes. Nested direct links need the
  // same bounded alignment after hydration, not only disclosure reveal.
  useEffect(() => {
    let hash: string;
    try {
      hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    } catch {
      return;
    }
    if (hash && !DETAIL_SECTIONS.some((section) => section.id === hash)) {
      return alignAnchorAfterHydration(hash);
    }
  }, []);
  const heroModel = viewModel.hero;
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
  // Structural evidence cards: built once, mounted once in flow, indexed by
  // the xl rail.
  const sharedModules = buildDetailSharedModules({
    mechanismBacking,
    mechanismCollateralization,
    mechanismReview,
    viewModel,
  });
  // Registered AI-summary claim tokens resolve against the same live values the
  // hero and report card render; pillar grades use the breakdown's scoreToGrade.
  const card = viewModel.reportCard;
  const pegScore = viewModel.isNavToken ? null : viewModel.pegScoreResult?.pegScore ?? null;
  const claimValues: AiSummaryClaimValues = {
    "report-card.grade": card?.grade ?? null,
    "report-card.score": card?.score ?? null,
    "report-card.pillars.backing.grade": card ? scoreToGrade(card.pillars.backing.score) : null,
    "report-card.pillars.backing.score": card?.pillars.backing.score ?? null,
    "report-card.pillars.exit.grade": card ? scoreToGrade(card.pillars.exit.score) : null,
    "report-card.pillars.exit.score": card?.pillars.exit.score ?? null,
    "report-card.pillars.control.grade": card ? scoreToGrade(card.pillars.control.score) : null,
    "report-card.pillars.control.score": card?.pillars.control.score ?? null,
    "peg-summary.grade": pegScore == null ? null : scoreToGrade(pegScore),
    "peg-summary.score": pegScore,
    "stablecoin.circulating-usd": viewModel.mcap,
  };

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
          {viewModel.summary ? (
            <div className="mt-4">
              <AiSummary {...viewModel.summary} claimValues={claimValues} />
            </div>
          ) : null}
          {/* A direct child of the main column, so `position: sticky` holds
              for the whole dossier rather than ending with a wrapper. */}
          <DetailNavigation onActiveChange={onActiveBannerChange} viewModel={viewModel} />
          <div className="mt-4 min-w-0 space-y-6">
            <DetailRiskContextSections
              activeBannerId={activeBannerId}
              frozenNote={frozenNote}
              sharedModules={sharedModules}
              transferReview={transferReview}
              overviewGateRef={overviewGateRef}
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
        pegValue={isObservedPrice(viewModel.coinData) && viewModel.coinData.price != null ? `$${viewModel.coinData.price.toFixed(6)}` : undefined}
      />
    </div>
  );
}
