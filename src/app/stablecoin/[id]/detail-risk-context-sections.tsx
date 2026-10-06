"use client";

import type { ReactNode, Ref } from "react";
import { ChartPie } from "lucide-react";
import { CoinNotices } from "@/components/coin-notice";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { MintAuthoritySection } from "@/components/stablecoin-detail/mint-authority-section";
import { OracleLiquidationSection } from "@/components/stablecoin-detail/oracle-liquidation-section";
import { RailCopyFold } from "@/components/stablecoin-detail/rail-copy-fold";
import { RedemptionRouteSection } from "@/components/stablecoin-detail/redemption-backstop-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { LazySection } from "@/components/lazy-section";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { buildSafetyScoreV9AccessRows } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewView } from "@/lib/transfer-review";
import { cn } from "@/lib/utils";
import type { DetailSharedModules } from "./detail-shared-modules";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import {
  DEWSDetail,
  FlowsSection,
  PegStabilityCard,
  ReservesSection,
  StablecoinSafetyScoreV9Card,
  StablecoinDepegResolverCard,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

interface DetailRiskContextSectionsProps {
  activeBannerId: string;
  frozenNote: ReactNode;
  sharedModules: DetailSharedModules;
  transferReview: TransferReviewView | null;
  overviewGateRef: Ref<HTMLDivElement>;
  variantRelationshipCard: ReactNode;
  viewModel: ReadyDetailViewModel;
}

/**
 * One Safety Score pillar's evidence: a quiet kicker heading over the modules
 * that substantiate that pillar. The pillar rows in the score card link to
 * `id`. A group whose modules all render nothing collapses with its heading
 * (the heading is then the section's only child).
 */
function PillarEvidenceGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("space-y-4 has-[>:only-child]:hidden", SECTION_SCROLL_MT)}
    >
      <h2
        id={headingId}
        className="pharos-kicker flex items-center gap-3 pt-2 after:h-px after:flex-1 after:bg-border/50"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function DetailRiskContextSections({
  activeBannerId,
  frozenNote,
  sharedModules,
  transferReview,
  overviewGateRef,
  variantRelationshipCard,
  viewModel,
}: DetailRiskContextSectionsProps) {
  const resolvedMechanismArchetype = resolveMechanismArchetype(viewModel.coin, TRACKED_META_BY_ID);
  const archetypeOverride = viewModel.coin.archetypeOverride === true;
  const isWrapperVariant = viewModel.isVariant && !archetypeOverride;
  const parentArchetype = isWrapperVariant && viewModel.variantParent
    ? resolveMechanismArchetype(viewModel.variantParent, TRACKED_META_BY_ID)
    : null;
  const overviewNotices = viewModel.coin.notices?.filter((notice) => notice.type !== "danger") ?? [];
  const showDepegResolver = !viewModel.isNavToken && viewModel.pegScoreResult?.activeDepeg === true;
  const reservesLoading = viewModel.featureStates.reserves.status === "loading";
  const qualitySummary = viewModel.coin.reserveQualitySummary ?? null;
  const hasReviewedSlices = qualitySummary != null || (viewModel.coin.reserves?.length ?? 0) > 0;
  const showReserves =
    viewModel.reserves != null || viewModel.reserveFetchError != null || reservesLoading || hasReviewedSlices;
  const { reportCard, reportCardsResponse } = viewModel;
  const showScoreCard = reportCard != null && reportCardsResponse != null;
  // Pair side by side only when a reviewed composition fills the Reserves
  // half; a live-feed-only module would leave a mostly empty stretched box.
  const pairScoreAndReserves = showScoreCard && hasReviewedSlices;

  return (
    <>
      {/* Risk zone = the Safety Score's spine: the peg-mechanism intro, the
          score, then each pillar's evidence in pillar order. */}
      <div id="overview" ref={overviewGateRef} className="space-y-6 scroll-mt-32">
        {/* `#info` is the passport strip's fallback target for facts that live
            in the strip itself (launch date, jurisdiction without a regulatory
            review), so the section keeps the id even when the coin has no peg
            mechanism to render. Peg Stability stays ahead of the score: it is
            the "how this coin holds its peg" primer the pillars assume. */}
        <section id="info" className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6">
          {viewModel.coin.pegMechanism ? (
            <PegStabilityCard
              meta={viewModel.coin}
              resolvedMechanismArchetype={resolvedMechanismArchetype}
              isWrapper={isWrapperVariant}
              parentSymbol={isWrapperVariant ? viewModel.variantParent?.symbol : null}
              parentArchetype={parentArchetype}
              parentNavToken={isWrapperVariant ? (viewModel.variantParent?.flags?.navToken ?? null) : null}
              variantKind={viewModel.coin.variantKind ?? null}
            />
          ) : null}
        </section>
        {/* Score left, reserves right at lg+ when both exist and reserves has
            a reviewed composition; otherwise each takes the full width, stacked.
            Each half is a one-cell grid so its card stretches to the row
            height and the pair stays equal. */}
        <div className={cn("grid gap-6", pairScoreAndReserves ? "lg:grid-cols-2" : undefined)}>
          <section id="report-card" className={cn("grid min-w-0", SECTION_SCROLL_MT)}>
            {reportCard && reportCardsResponse ? (
              <StablecoinSafetyScoreV9Card
                card={reportCard}
                identity={reportCardsResponse.safetyScoreIdentity}
                publicationHealth={reportCardsResponse.publicationHealth}
                updatedAtMs={viewModel.reportCardUpdatedAt}
                stablecoinName={viewModel.coin.name}
                stablecoinSymbol={viewModel.coin.symbol}
                logoSrc={viewModel.logoSrc}
              />
            ) : null}
          </section>
          {showReserves ? (
            <div className="grid min-w-0">
              <ReservesSection
                coin={viewModel.coin}
                reserves={viewModel.reserves}
                reserveFetchError={viewModel.reserveFetchError}
                onRetry={viewModel.refetchReserves ?? undefined}
                isFetching={viewModel.isFetchingReserves}
                isLoading={reservesLoading}
                qualitySummary={qualitySummary}
              />
            </div>
          ) : null}
        </div>
        {showDepegResolver ? (
          <StablecoinDepegResolverCard stablecoinId={viewModel.id} logoSrc={viewModel.logoSrc} />
        ) : null}

        <PillarEvidenceGroup id="backing-evidence" title="Backing evidence">
          {viewModel.coin.oracleRiskSummary ? (
            <OracleLiquidationSection summary={viewModel.coin.oracleRiskSummary} />
          ) : null}
          {sharedModules.backing.map((entry) => (
            <RailCopyFold key={entry.key} id={entry.anchorId} title={entry.title} chip={entry.chip}>
              {entry.body}
            </RailCopyFold>
          ))}
        </PillarEvidenceGroup>

        <PillarEvidenceGroup id="exit-evidence" title="Exit evidence">
          <RedemptionRouteSection
            entry={viewModel.redemptionBackstop}
            reportCard={viewModel.reportCard}
            coinId={viewModel.coin.id}
          />
          {/* The xl rail carries the compact Access posture card; below xl
              this in-flow copy keeps it with the exit evidence it scores. */}
          {viewModel.reportCard ? (
            <div className="xl:hidden">
              <AccessPosturePanel rows={buildSafetyScoreV9AccessRows(viewModel.reportCard)} review={transferReview} />
            </div>
          ) : null}
        </PillarEvidenceGroup>

        <PillarEvidenceGroup id="control-evidence" title="Control evidence">
          <MintAuthoritySection profile={viewModel.mintAuthority} symbol={viewModel.coin.symbol} />
          {sharedModules.control.map((entry) => (
            <RailCopyFold key={entry.key} id={entry.anchorId} title={entry.title} chip={entry.chip}>
              {entry.body}
            </RailCopyFold>
          ))}
        </PillarEvidenceGroup>

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

      <div className="space-y-6">
        <SectionBanner id="context" label="Context" icon={ChartPie} active={activeBannerId === "context"} />
        <ContagionSnapshot
          stablecoinId={viewModel.id}
          variantRelationshipCard={variantRelationshipCard}
        />
        {/* The xl rail owns Key Links and Contracts; below xl these in-flow
            copies keep the outbound links, the reserve attestation link and the
            deployment list reachable — after the score and its evidence, never
            ahead of them. Both own their anchors (`#attestation`, `#contracts`);
            the rail copies are marked as their twins. */}
        <div className="space-y-4 xl:hidden">
          <KeyLinksCard meta={viewModel.coin} anchors />
          <ContractDeployments coinId={viewModel.coin.id} contracts={viewModel.coin.contracts ?? []} />
        </div>
      </div>
    </>
  );
}
