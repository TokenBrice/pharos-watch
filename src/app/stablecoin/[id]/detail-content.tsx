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
import { BackingMetricsCard, type BackingMetricsInput } from "@/components/stablecoin-detail/backing-metrics-card";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { RegulatoryStandingCard } from "@/components/stablecoin-detail/regulatory-standing-card";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { Badge } from "@/components/ui/badge";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { TransferReviewView } from "@/lib/transfer-review";
import { RailSafetySummary } from "@/components/stablecoin-detail/rail-safety-summary";
import { UnderlyingAssetCard } from "@/components/stablecoin-detail/underlying-asset-card";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { alignAnchorAfterHydration, revealAnchorId } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";
import { GOVERNANCE_LABELS } from "@shared/lib/classification";
import { scoreToGrade } from "@shared/lib/report-card-core";
import type { AiSummaryClaimValues } from "@shared/types";
import {
  buildDetailSharedModules,
  type DetailSharedModules,
  type EvidenceIndexGroup,
  type EvidenceIndexRow,
} from "./detail-shared-modules";
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
  /** The variant parent's `deriveLiquidationEngine` result, computed server-side. */
  parentLiquidationEngine: boolean | null;
  /** A pure or savings pass-through wrapper's parent, built server-side, for the Backing KPI look-through. */
  backingParent: NonNullable<BackingMetricsInput["parent"]> | null;
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

/**
 * Mirrors `ContagionSnapshot`'s empty rule from the same report-cards
 * response: a variant relationship card, a published dependency edge touching
 * the coin between two published cards, or a published dependency disclosure.
 * Without any of them the Context zone holds only the below-xl reference cards.
 */
function hasContextZoneContent(viewModel: ReadyDetailViewModel, hasVariantCard: boolean): boolean {
  if (hasVariantCard) return true;
  const response = viewModel.reportCardsResponse;
  if (!response) return false;
  const cardIds = new Set(response.cards.map((card) => card.id));
  const hasEdge = response.dependencyGraph.edges.some(
    (edge) => (edge.from === viewModel.id || edge.to === viewModel.id) && cardIds.has(edge.from) && cardIds.has(edge.to),
  );
  const focusCard = response.cards.find((card) => card.id === viewModel.id);
  return hasEdge
    || (focusCard?.dependencies.roles?.length ?? 0) > 0
    || (focusCard?.dependencyCoverage?.length ?? 0) > 0;
}

function DetailNavigation({
  contextHasContent,
  onActiveChange,
  viewModel,
}: {
  contextHasContent: boolean;
  onActiveChange: (id: string) => void;
  viewModel: ReadyDetailViewModel;
}) {
  return (
    <LongformScrollspyNav
      sections={DETAIL_SECTIONS.filter((section) =>
        section.id === "activity"
          ? viewModel.hasYieldSection || viewModel.hasBlacklist
          : section.id !== "context" || contextHasContent)}
      railLabel="Jump to"
      navAriaLabel="Stablecoin detail section navigation"
      emphasis="pill-tabs"
      onActiveChange={onActiveChange}
      // A full-bleed band of page background behind the pills, so scrolled
      // content never shows through beside them: the spread shadow paints
      // the band edge to edge and the clip keeps it to the bar's height
      // (a shadow never adds scroll overflow, unlike a wider pseudo-element).
      className="mt-2 bg-background py-2 shadow-[0_0_0_100vmax_var(--background)] [clip-path:inset(0_-100vmax)] lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem)] lg:w-full lg:max-w-none lg:[&>div]:justify-center lg:[&_nav]:flex-none"
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
 * The completed Evidence index (plan §5, decision S9): one row per main-column
 * evidence module, in pillar order, with its published score or verdict chip
 * and the Control limiting-input flag. Each row links to the module's single
 * in-flow mount; the bounded re-alignment absorbs lazy sections settling above
 * the target, and focus moves to the module heading.
 */
function RailEvidenceIndex({ groups }: { groups: readonly EvidenceIndexGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <RailCard title="Evidence index" ariaLabel="Evidence index">
      <div className="space-y-3 px-4 pb-4">
        {groups.map((group) => (
          <div key={group.pillar}>
            <p className="pharos-kicker pb-1">{group.label}</p>
            <ul className="divide-y divide-border/40">
              {group.rows.map((row) => (
                <RailEvidenceIndexRow key={row.key} row={row} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </RailCard>
  );
}

/**
 * Title left, never truncated; the score or chip and the limiting tag right.
 * When both cannot share the 22rem line, the meta group wraps under the
 * title, right-aligned, instead of clipping the module name.
 */
function RailEvidenceIndexRow({ row }: { row: EvidenceIndexRow }) {
  return (
    <li>
      <a
        href={`#${row.anchorId}`}
        onClick={(event) => {
          event.preventDefault();
          window.history.pushState(null, "", `#${row.anchorId}`);
          alignAnchorAfterHydration(row.anchorId);
          // Keyboard and screen-reader users continue from the module, not the rail.
          const target = revealAnchorId(row.anchorId);
          const headingId = target?.getAttribute("aria-labelledby");
          const focusTarget = (headingId ? document.getElementById(headingId) : null) ?? target;
          if (!focusTarget) return;
          if (!focusTarget.hasAttribute("tabindex")) focusTarget.tabIndex = -1;
          focusTarget.focus({ preventScroll: true });
        }}
        className="pharos-focus-ring group flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-sm py-1.5 text-sm"
      >
        <span className="text-foreground/90 underline-offset-2 group-hover:underline">{row.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {row.chip ? (
            <Badge variant="outline" className={cn("text-[11px] font-medium", row.chip.toneClass)}>
              {row.chip.label}
            </Badge>
          ) : null}
          {row.score !== null ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                {row.score > 0 && row.score < 1 ? "<1" : row.score.toFixed(0)}
              </span>
              {row.scoreNote ? (
                <span className="text-[11px] text-muted-foreground">· {row.scoreNote}</span>
              ) : null}
            </span>
          ) : null}
          {/* One limiting grammar across the dossier; its text joins the link name. */}
          {row.limiting ? <ControlRoleTag role="limiting" size="compact" /> : null}
        </span>
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
  // A compact companion in normal flow, never sticky (decision S1): pillar
  // metrics first (Safety → Backing KPI → Access posture → Evidence index),
  // then the reference cards. The metric cards are anchor twins of their
  // in-flow `xl:hidden` copies; evidence modules live once, in their board.
  return (
    <aside aria-label="Coin summary rail" className="hidden min-w-0 self-stretch xl:block">
      <div className="space-y-4 pb-4">
        <RailSafetySummary
          items={heroModel.signalRailItems}
          navToken={viewModel.isNavToken}
          frozen={viewModel.coin.status === "frozen"}
        />
        {sharedModules.backingMetrics ? <BackingMetricsCard view={sharedModules.backingMetrics} anchorTwin /> : null}
        <AccessPosturePanel variant="rail" rows={sharedModules.accessRows} review={transferReview} />
        <RailEvidenceIndex groups={sharedModules.evidenceIndex} />
        {sharedModules.regulatoryStanding ? (
          <RegulatoryStandingCard view={sharedModules.regulatoryStanding} anchorTwin />
        ) : sharedModules.regulatoryNotReviewed ? (
          <div data-anchor-twin="jurisdiction" className={SECTION_SCROLL_MT}>
            <EvidenceStateStrip title="Regulatory standing" state="not-reviewed" density="rail" />
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
  parentLiquidationEngine,
  backingParent,
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
  // Pillar strips, control roles, the Backing KPI and the Evidence index:
  // built once, read by the pillar boards and the xl rail alike.
  const sharedModules = buildDetailSharedModules({
    mechanismBacking,
    backingParent,
    mechanismCollateralization,
    mechanismReview,
    viewModel,
  });
  const contextHasContent = hasContextZoneContent(viewModel, variantRelationshipCard !== null);
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
          <DetailNavigation
            contextHasContent={contextHasContent}
            onActiveChange={onActiveBannerChange}
            viewModel={viewModel}
          />
          <div className="mt-4 min-w-0 space-y-6">
            <DetailRiskContextSections
              activeBannerId={activeBannerId}
              contextHasContent={contextHasContent}
              frozenNote={frozenNote}
              mechanismBacking={mechanismBacking}
              parentLiquidationEngine={parentLiquidationEngine}
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
