"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { ReactNode, Ref, RefObject } from "react";
import { ChartPie, Droplet, HeartPulse, Hourglass, Scale, Sparkles, Unlink } from "lucide-react";
import { AiSummary } from "@/components/ai-summary/ai-summary";
import { BackToSource } from "@/components/back-to-source";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { HeroCard, HeroIdentityHeader } from "@/components/stablecoin-detail/hero-card";
import { HolderAlerts } from "@/components/stablecoin-detail/holder-alerts";
import { MobileStickySummary } from "@/components/stablecoin-detail/mobile-sticky-summary";
import { ListingStateBanner } from "@/components/stablecoin-detail/listing-state-banner";
import { ParentVariantsCard } from "@/components/stablecoin-detail/parent-variants-card";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { BackingMetricsCard, type BackingMetricsInput } from "@/components/stablecoin-detail/backing-metrics-card";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import type { FailureScenarioSelection } from "@/components/stablecoin-detail/failure-scenario/scenario-model";
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
import { TapeForCoinTeaser } from "@/components/tape/tape-for-coin-teaser";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { formatLiveCardAsOf } from "@/lib/stablecoin-detail-hero-metrics";
import { alignAnchorAfterHydration, revealAnchorId, revealDeferredSectionsThroughAnchor } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";
import { scoreToGrade } from "@shared/lib/report-card-core";
import type { AiSummaryClaimValues } from "@shared/types/editorial";
import {
  buildDetailSharedModules,
  type DetailSharedModules,
  type EvidenceIndexGroup,
  type EvidenceIndexRow,
} from "./detail-shared-modules";
import { DetailHistoryExploreSections } from "./detail-history-explore-sections";
import { activityZoneLabel, DetailLiquidityActivitySections } from "./detail-liquidity-activity-sections";
import { ActiveDepegOutlook, FeedbackModal } from "./detail-lazy-sections";
import { DetailRiskContextSections } from "./detail-risk-context-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

// Labels use searchers' words (Google lists these tabs as in-page links); the
// zone ids stay fixed so existing deep links keep working. The Activity pill
// takes its per-coin label from `activityZoneLabel`.
const DETAIL_SECTIONS = [
  { id: "overview", label: "Risk", icon: Scale },
  { id: "how-it-breaks", label: "How it breaks", icon: Unlink },
  { id: "context", label: "Dependencies", icon: ChartPie },
  { id: "liquidity", label: "Supply & Liquidity", icon: Droplet },
  { id: "activity", label: "Yield & Blacklist", icon: HeartPulse },
  { id: "history", label: "History", icon: Hourglass },
  { id: "explore", label: "Explore", icon: Sparkles },
] as const;

const DETAIL_SECTION_IDS = DETAIL_SECTIONS.map((section) => section.id);

interface DetailContentProps {
  activeBannerId: string;
  activityGateRef: Ref<HTMLDivElement>;
  /** C1: server-rendered retained-ledger preview for the History panel. */
  depegHistoryPreview: ReactNode;
  exploreNextContent: ReactNode;
  feedbackOpen: boolean;
  /** The page heading; the visible identity title is the page's only h1. */
  heading?: string;
  heroRef: RefObject<HTMLDivElement | null>;
  historyActive: boolean;
  historyGateRef: Ref<HTMLDivElement>;
  mechanismBacking: MechanismBackingView | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  mechanismReview: MechanismReviewView | null;
  /** The variant parent's `deriveLiquidationEngine` result, computed server-side. */
  parentLiquidationEngine: boolean | null;
  /** A pure or savings pass-through wrapper's parent, built server-side, for the Backing KPI look-through. */
  backingParent: NonNullable<BackingMetricsInput["parent"]> | null;
  transferReview: TransferReviewView | null;
  /** The coin's publishable failure scenario; null drops the pill and the section. */
  failureScenario: FailureScenarioSelection | null;
  onActiveBannerChange: (id: string) => void;
  onFeedbackOpenChange: (open: boolean) => void;
  overviewGateRef: Ref<HTMLDivElement>;
  viewModel: ReadyDetailViewModel;
}

/** The producer generation, never the browser's request receipt; unknown hides the stamp. */
function detailSnapshotProvenance(queries: ReadyDetailViewModel["staleQueries"]): {
  updatedAtMs: number;
  dailySnapshot: boolean;
} {
  const lane = queries.find((query) => query.label === "Detail snapshot");
  const updatedAt = lane?.meta?.updatedAt;
  return {
    updatedAtMs: updatedAt != null && updatedAt > 0 ? updatedAt * 1000 : 0,
    dailySnapshot: lane?.dailySnapshot === true,
  };
}

function DetailIdentity({
  heading,
  heroModel,
  heroRef,
  onOpenFeedback,
  viewModel,
}: {
  heading?: string;
  heroModel: ReadyDetailViewModel["hero"];
  heroRef: RefObject<HTMLDivElement | null>;
  onOpenFeedback: () => void;
  viewModel: ReadyDetailViewModel;
}) {
  const snapshot = detailSnapshotProvenance(viewModel.staleQueries);
  return (
    <>
      {/* The identity header's visible title is the page's only h1. */}
      <BackToSource className="mb-2" />
      <QueryFreshnessNotices
        error={viewModel.supplyError}
        hasData={viewModel.supplyHistory.length > 0}
        onRetry={viewModel.handleRetryAll}
        queries={viewModel.staleQueries}
      />
      <HeroIdentityHeader
        heading={heading}
        model={heroModel}
        onOpenFeedback={onOpenFeedback}
        gradeRead={viewModel.gradeRead}
        updatedAtMs={snapshot.updatedAtMs}
        dailySnapshot={snapshot.dailySnapshot}
        hasSummary={Boolean(viewModel.summary)}
      />
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
  const cards = "neighborhood" in response ? response.neighborhood : response.cards;
  const cardIds = new Set(cards.map((card) => card.id));
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
  hasFailureScenario,
  onActiveChange,
  onBeforeAlign,
  viewModel,
}: {
  contextHasContent: boolean;
  hasFailureScenario: boolean;
  onActiveChange: (id: string) => void;
  onBeforeAlign: (sectionId: string) => void;
  viewModel: ReadyDetailViewModel;
}) {
  return (
    <LongformScrollspyNav
      sections={DETAIL_SECTIONS.filter((section) => {
        if (section.id === "activity") return viewModel.hasYieldSection || viewModel.hasBlacklist;
        if (section.id === "context") return contextHasContent;
        if (section.id === "how-it-breaks") return hasFailureScenario;
        return true;
      }).map((section) => (section.id === "activity" ? { ...section, label: activityZoneLabel(viewModel) } : section))}
      navAriaLabel="Stablecoin detail section navigation"
      emphasis="pill-tabs"
      onActiveChange={onActiveChange}
      onBeforeAlign={onBeforeAlign}
      // A band of page background behind the pills, so scrolled content never
      // shows through beside them: the spread shadow paints the band and the
      // clip keeps it to the bar's height (a shadow never adds scroll
      // overflow, unlike a wider pseudo-element). Full bleed below xl; at xl
      // the clip stops at the column's right edge so the band never paints
      // over the summary rail beside it.
      className="mt-2 bg-background py-1.5 sm:py-2 shadow-[0_0_0_100vmax_var(--background)] [clip-path:inset(0_-100vmax)] lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem)] lg:w-full lg:max-w-none lg:[&>div]:justify-center lg:[&_nav]:flex-none xl:[clip-path:inset(0_0_0_-100vmax)]"
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
/**
 * The evidence module currently under the reader's eye, so the bottom-pinned
 * index doubles as an "on this page" navigator. Lazy modules mount after the
 * first scan, so the observer re-scans for anchors it has not seen yet.
 */
function useActiveEvidenceAnchor(anchorIds: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = anchorIds.join("|");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || key === "") return;
    const ids = key.split("|");
    const tops = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) tops.set(entry.target.id, entry.boundingClientRect.top);
          else tops.delete(entry.target.id);
        }
        let best: string | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const [id, top] of tops) {
          if (top < bestTop) {
            best = id;
            bestTop = top;
          }
        }
        setActive(best);
      },
      // A module counts as "current" while it crosses the upper-middle band.
      { rootMargin: "-25% 0px -55% 0px" },
    );
    const observed = new Set<Element>();
    const scan = () => {
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element && !observed.has(element)) {
          observed.add(element);
          observer.observe(element);
        }
      }
    };
    scan();
    const timer = window.setInterval(scan, 2000);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [key]);
  return active;
}

function RailEvidenceIndex({ groups }: { groups: readonly EvidenceIndexGroup[] }) {
  const anchorIds = useMemo(() => groups.flatMap((group) => group.rows.map((row) => row.anchorId)), [groups]);
  const activeAnchor = useActiveEvidenceAnchor(anchorIds);
  if (groups.length === 0) return null;
  return (
    <RailCard title="Evidence index" ariaLabel="Evidence index">
      <div className="space-y-3 px-4 pb-4">
        {groups.map((group) => (
          <div key={group.pillar}>
            <p className="pharos-label pb-1">{group.label}</p>
            <ul className="divide-y divide-border/40">
              {group.rows.map((row) => (
                <RailEvidenceIndexRow key={row.key} row={row} active={row.anchorId === activeAnchor} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </RailCard>
  );
}

/**
 * Title left, never truncated; the score or verdict chip and the limiting tag
 * right. When both cannot share the 22rem line, the meta group wraps under
 * the title, right-aligned, instead of clipping the module name. The current
 * row changes colour, never weight, so it keeps its width and never re-wraps.
 */
function RailEvidenceIndexRow({ row, active = false }: { row: EvidenceIndexRow; active?: boolean }) {
  return (
    <li>
      <a
        href={`#${row.anchorId}`}
        aria-current={active ? "location" : undefined}
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
        className={cn(
          "pharos-focus-ring group -mx-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm transition-colors",
          active ? "bg-muted/70" : "hover:bg-muted/40",
        )}
      >
        <span className={cn("underline-offset-2 group-hover:underline", active ? "text-foreground" : "text-foreground/85")}>{row.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {row.chip ? (
            <Badge variant="outline" className={cn("text-2xs font-medium", row.chip.toneClass)}>
              {row.chip.label}
            </Badge>
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
  // The live card's own clock, so the rail Safety card keeps its dated line
  // (and its height) once the live card replaces the dated release grade.
  const liveSafetyAsOf = formatLiveCardAsOf(viewModel.reportCardsResponse?.updatedAt);
  // Hold the Backing KPI footprint only while live reserve evidence is still
  // pending; a settled read without a KPI hides the card, never "unavailable".
  const reservesPending = viewModel.featureStates.reserves.status === "loading" || viewModel.featureStates.reserves.status === "deferred";
  // A compact companion that reads in normal flow from the top: pillar metrics
  // first (Safety → Backing KPI → Access posture), then the reference cards,
  // then the Evidence index. The rail is bottom-anchored sticky (it sits at
  // the end of its grid cell and `bottom` pulls it up into view): it scrolls
  // with the page until its last card reaches the viewport bottom, then rides
  // there, so the Evidence index stays a jump list with verdicts for the whole
  // dossier instead of leaving an empty column. Never `top`-sticky, never a
  // nested scroll container. The metric cards are anchor twins of their
  // in-flow `xl:hidden` copies; evidence modules live once, in their board.
  return (
    <aside aria-label="Coin summary rail" className="hidden min-w-0 xl:sticky xl:bottom-4 xl:block xl:self-end">
      <div className="space-y-4">
        <RailSafetySummary
          items={heroModel.signalRailItems}
          navToken={viewModel.isNavToken}
          frozen={viewModel.coin.status === "frozen"}
          gradeRead={viewModel.gradeRead}
          liveAsOf={liveSafetyAsOf}
          card={viewModel.reportCard ?? null}
        />
        {/* The loading placeholders reserve their card's footprint; a loaded
            card takes its own height, so the rail never shows a blank gap. */}
        {sharedModules.backingMetrics || (viewModel.coin.liveReservesConfig && reservesPending) ? (
          <div className={sharedModules.backingMetrics ? undefined : "min-h-64"} data-rail-slot="collateralization">
            {sharedModules.backingMetrics ? <BackingMetricsCard view={sharedModules.backingMetrics} anchorTwin /> : (
              <RailCard title="Collateralization" ariaLabel="Collateralization">
                <p className="px-4 pb-4 text-xs text-muted-foreground">Waiting for reserve evidence.</p>
              </RailCard>
            )}
          </div>
        ) : null}
        {sharedModules.accessRows.length > 0 || viewModel.gradeRead === "pending" ? (
          <div className={sharedModules.accessRows.length > 0 ? undefined : "min-h-48"} data-rail-slot="access">
            {sharedModules.accessRows.length > 0 ? (
              <AccessPosturePanel variant="rail" rows={sharedModules.accessRows} review={transferReview} />
            ) : (
              <RailCard title="Access posture" ariaLabel="Access posture">
                <p className="px-4 pb-4 text-xs text-muted-foreground">Loading published access posture…</p>
              </RailCard>
            )}
          </div>
        ) : null}
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
            pegCurrency={viewModel.coin.flags.pegCurrency}
            pegRef={viewModel.pegRef}
            consensusSources={viewModel.consensusSources}
            agreeSources={viewModel.agreeSources}
            dexPriceCheck={viewModel.dexPriceCheck}
            navToken={viewModel.isNavToken}
            compact
          />
        ) : null}
        <TapeForCoinTeaser coinId={viewModel.id} supplyUsd={viewModel.mcap} />
        <KeyLinksCard meta={viewModel.coin} />
        {(viewModel.coin.contracts?.length ?? 0) > 0 ? (
          <ContractDeployments coinId={viewModel.coin.id} contracts={viewModel.coin.contracts ?? []} compact />
        ) : null}
        <RailEvidenceIndex groups={sharedModules.evidenceIndex} />
      </div>
    </aside>
  );
}

export function DetailContent({
  activeBannerId,
  activityGateRef,
  depegHistoryPreview,
  exploreNextContent,
  feedbackOpen,
  heading,
  heroRef,
  historyActive,
  historyGateRef,
  mechanismBacking,
  mechanismCollateralization,
  mechanismReview,
  parentLiquidationEngine,
  backingParent,
  transferReview,
  failureScenario,
  onActiveBannerChange,
  onFeedbackOpenChange,
  overviewGateRef,
  viewModel,
}: DetailContentProps) {
  const detailRootRef = useRef<HTMLDivElement | null>(null);
  const prepareAnchor = useCallback((sectionId: string) => {
    revealDeferredSectionsThroughAnchor(sectionId, DETAIL_SECTION_IDS, detailRootRef.current);
  }, []);
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
      return alignAnchorAfterHydration(hash, true, { beforeAlign: () => prepareAnchor(hash) });
    }
  }, [prepareAnchor]);
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
  // Board headings, control roles, the Backing KPI and the Evidence index:
  // built once, read by the pillar boards and the xl rail alike.
  const sharedModules = useMemo(() => buildDetailSharedModules({
    mechanismBacking,
    backingParent,
    mechanismCollateralization,
    mechanismReview,
    viewModel,
  }), [mechanismBacking, backingParent, mechanismCollateralization, mechanismReview, viewModel]);
  // A collateral or hedge-coverage ratio read against par is the mechanism's
  // own headline figure, so it earns the hero's fourth cell.
  const backingHeadline = sharedModules.backingMetrics?.visual?.kind === "coverage-ratio"
    ? sharedModules.backingMetrics
    : null;
  // A live (non-archived, fixed-peg) depeg puts the resolver outlook first.
  const activeDepeg = viewModel.coin.status !== "frozen" && !viewModel.isNavToken && viewModel.pegScoreResult?.activeDepeg === true;
  const heroKeyMetric = backingHeadline
    ? {
        key: "backing-ratio",
        label: backingHeadline.title,
        mobileLabel: backingHeadline.title === "Collateralization" ? "Collateral" : backingHeadline.title,
        value: backingHeadline.headline.value,
        subValue: backingHeadline.headline.basis,
        colorClass: "text-foreground",
      }
    : null;
  const hasVariantCard = variantRelationshipCard !== null;
  const contextHasContent = useMemo(
    () => hasContextZoneContent(viewModel, hasVariantCard),
    [viewModel, hasVariantCard],
  );
  // Registered AI-summary claim tokens resolve against the same live values the
  // hero and report card render; pillar grades use the breakdown's scoreToGrade.
  // While the live card is pending (the prerender included), the grade reads the
  // same dated release value the hero shows.
  const card = viewModel.reportCard;
  const savedGrade = heroModel.savedGrade;
  const pegScore = viewModel.isNavToken ? null : viewModel.pegScoreResult?.pegScore ?? null;
  const claimValues: AiSummaryClaimValues = {
    "report-card.grade": card?.grade ?? savedGrade?.grade ?? null,
    "report-card.score": card?.score ?? savedGrade?.score ?? null,
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
    <div ref={detailRootRef}>
      <DetailIdentity
        heading={heading}
        heroModel={heroModel}
        heroRef={heroRef}
        onOpenFeedback={() => onFeedbackOpenChange(true)}
        viewModel={viewModel}
      />
      <div className="mt-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
        <div className="min-w-0">
          <div ref={heroRef} className="space-y-4">
            {/* A live depeg leads the dossier: the resolver's forecast sits above
                the figures, inside the first fold at every width. Without a
                published forecast the plain active-depeg alert takes its place. */}
            {activeDepeg ? (
              <ActiveDepegOutlook
                stablecoinId={viewModel.id}
                symbol={viewModel.coin.symbol}
                fallback={<HolderAlerts activeDepeg symbol={viewModel.coin.symbol} />}
              />
            ) : null}
            <HeroCard model={heroModel} keyMetric={heroKeyMetric} />
            {/* A frozen coin leads with its obituary; its past danger notice
                follows as a muted record so the story is not told in red first. */}
            {viewModel.coin.status === "frozen" && viewModel.coin.obituary && viewModel.coin.frozenAt ? (
              <FrozenStateBanner
                symbol={viewModel.coin.symbol}
                frozenAt={viewModel.coin.frozenAt}
                obituary={viewModel.coin.obituary}
              />
            ) : null}
            <ExploitNoticeBanner
              notices={viewModel.coin.notices}
              tone={viewModel.coin.status === "frozen" ? "archive" : "alert"}
            />
            <ListingStateBanner coin={viewModel.coin} />
            {viewModel.coin.status === "frozen" ? null : (
              <HolderAlerts notices={viewModel.coin.notices} symbol={viewModel.coin.symbol} />
            )}
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
            hasFailureScenario={failureScenario !== null}
            onActiveChange={onActiveBannerChange}
            onBeforeAlign={prepareAnchor}
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
              failureScenario={failureScenario}
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
              depegHistoryPreview={depegHistoryPreview}
              exploreNextContent={exploreNextContent}
              frozenNote={frozenNote}
              historyActive={historyActive}
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
