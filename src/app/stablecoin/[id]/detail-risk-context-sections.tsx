"use client";

import type { ReactNode, Ref } from "react";
import { ChartPie } from "lucide-react";
import { CoinNotices } from "@/components/coin-notice";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { MechanismReviewPanel } from "@/components/stablecoin-detail/mechanism-review-panel";
import { MintAuthoritySection } from "@/components/stablecoin-detail/mint-authority-section";
import { OracleLiquidationSection } from "@/components/stablecoin-detail/oracle-liquidation-section";
import { RailCopyFold } from "@/components/stablecoin-detail/rail-copy-fold";
import { ReserveQualitySection } from "@/components/stablecoin-detail/reserve-quality-section";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { LazySection } from "@/components/lazy-section";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { TransferReviewView } from "@/lib/transfer-review";
import type { DetailSharedModules } from "./detail-shared-modules";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import {
  DEWSDetail,
  FlowsSection,
  PegStabilityCard,
  StablecoinSafetyScoreV9Card,
  StablecoinDepegResolverCard,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

interface DetailRiskContextSectionsProps {
  activeBannerId: string;
  collateralUsageEntries: readonly CollateralUsageEntry[];
  frozenNote: ReactNode;
  hasCollateralUsage: boolean;
  mechanismReview: MechanismReviewView | null;
  sharedModules: DetailSharedModules;
  transferReview: TransferReviewView | null;
  overviewGateRef: Ref<HTMLDivElement>;
  reservesPanel: ReactNode;
  variantRelationshipCard: ReactNode;
  viewModel: ReadyDetailViewModel;
}

export function DetailRiskContextSections({
  activeBannerId,
  collateralUsageEntries,
  frozenNote,
  hasCollateralUsage,
  mechanismReview,
  sharedModules,
  transferReview,
  overviewGateRef,
  reservesPanel,
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

  return (
    <>
      <div id="overview" ref={overviewGateRef} className="space-y-6 scroll-mt-32">
        {/* `#info` is the passport strip's fallback target for facts that live
            in the strip itself (launch date, jurisdiction without a regulatory
            review), so the section keeps the id even when the coin has no peg
            mechanism to render. */}
        <section id="info" className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6">
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
        </section>
        {/* The xl rail owns Key Links and Contracts; below xl the rail is
            hidden, so in-flow copies keep the outbound links, the reserve
            attestation link, and the deployment list reachable. Both own their
            anchors (`#attestation`, `#contracts`) — the rail copies are marked
            as their twins. */}
        <div className="space-y-4 xl:hidden">
          <KeyLinksCard meta={viewModel.coin} anchors />
          <ContractDeployments coinId={viewModel.coin.id} contracts={viewModel.coin.contracts ?? []} />
        </div>
        <section id="report-card">
          {viewModel.reportCard && viewModel.reportCardsResponse ? (
            <StablecoinSafetyScoreV9Card
              card={viewModel.reportCard}
              identity={viewModel.reportCardsResponse.safetyScoreIdentity}
              publicationHealth={viewModel.reportCardsResponse.publicationHealth}
              updatedAtMs={viewModel.reportCardUpdatedAt}
              stablecoinName={viewModel.coin.name}
              stablecoinSymbol={viewModel.coin.symbol}
              logoSrc={viewModel.logoSrc}
              rightColumn={reservesPanel}
              transferReview={transferReview}
            />
          ) : null}
        </section>
        {!viewModel.reportCard ? reservesPanel : null}
        {/* The xl summary rail owns these structure cards on desktop; below
            xl the rail is hidden, so in-flow copies keep collateralization
            and failure-domain facts on narrow viewports. */}
        {sharedModules.hasStructureCards ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:hidden">
            {sharedModules.collateralization}
            {sharedModules.failureDomains}
          </div>
        ) : null}
        {sharedModules.custody ? (
          <div className="xl:hidden">
            <RailCopyFold title="Custody" chip={sharedModules.foldChips.custody}>
              {sharedModules.foldBodies.custody}
            </RailCopyFold>
          </div>
        ) : null}
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

      <div className="space-y-6">
        <SectionBanner id="context" label="Context" icon={ChartPie} active={activeBannerId === "context"} />
        <ContagionSnapshot
          stablecoinId={viewModel.id}
          variantRelationshipCard={variantRelationshipCard}
          hasCollateralUsage={hasCollateralUsage}
          collateralUsageEntries={collateralUsageEntries}
        />
        <MintAuthoritySection profile={viewModel.mintAuthority} symbol={viewModel.coin.symbol} />
        {viewModel.coin.reserveQualitySummary ? (
          <ReserveQualitySection summary={viewModel.coin.reserveQualitySummary} />
        ) : null}
        {viewModel.coin.oracleRiskSummary ? (
          <OracleLiquidationSection summary={viewModel.coin.oracleRiskSummary} />
        ) : null}
        {mechanismReview ? (
          <div className="xl:hidden">
            <RailCopyFold title="Mechanism review" id="mechanism-review">
              <MechanismReviewPanel review={mechanismReview} embedded />
            </RailCopyFold>
          </div>
        ) : null}
        {sharedModules.backingMechanics ? (
          <div className="xl:hidden">
            <RailCopyFold title="Backing mechanics">{sharedModules.foldBodies.backingMechanics}</RailCopyFold>
          </div>
        ) : null}
        {sharedModules.bridging ? (
          <div className="xl:hidden">
            <RailCopyFold title="Bridging" chip={sharedModules.foldChips.bridging}>
              {sharedModules.foldBodies.bridging}
            </RailCopyFold>
          </div>
        ) : null}
        {sharedModules.regulatoryStanding ? (
          <div className="xl:hidden">
            <RailCopyFold
              title="Regulatory standing"
              id="jurisdiction"
              chip={sharedModules.foldChips.regulatoryStanding}
            >
              {sharedModules.foldBodies.regulatoryStanding}
            </RailCopyFold>
          </div>
        ) : null}
        {sharedModules.controlPosture ? (
          <div className="xl:hidden">
            <RailCopyFold title="Control posture" chip={sharedModules.foldChips.controlPosture}>
              {sharedModules.foldBodies.controlPosture}
            </RailCopyFold>
          </div>
        ) : null}
        {sharedModules.freezeSeizure ? (
          <div className="xl:hidden">
            <RailCopyFold title="Freeze & seizure" chip={sharedModules.foldChips.freezeSeizure}>
              {sharedModules.foldBodies.freezeSeizure}
            </RailCopyFold>
          </div>
        ) : null}
      </div>
    </>
  );
}
