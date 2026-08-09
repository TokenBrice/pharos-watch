"use client";

import type { ReactNode, Ref } from "react";
import { ChartPie } from "lucide-react";
import { CoinNotices } from "@/components/coin-notice";
import { BackingMechanicsCard } from "@/components/stablecoin-detail/backing-mechanics-card";
import { BridgingCard } from "@/components/stablecoin-detail/bridging-card";
import { CollateralizationCard } from "@/components/stablecoin-detail/collateralization-card";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { CustodyCard } from "@/components/stablecoin-detail/custody-card";
import { FailureDomainsCard } from "@/components/stablecoin-detail/failure-domains-card";
import { MechanismReviewPanel } from "@/components/stablecoin-detail/mechanism-review-panel";
import { MintAuthoritySection } from "@/components/stablecoin-detail/mint-authority-section";
import { OracleLiquidationSection } from "@/components/stablecoin-detail/oracle-liquidation-section";
import { RegulatoryStandingCard } from "@/components/stablecoin-detail/regulatory-standing-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { LazySection } from "@/components/lazy-section";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import { buildFailureDomainsView } from "@/lib/failure-domains";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import { buildRegulatoryStandingView } from "@/lib/regulatory-standing";
import type { TransferReviewView } from "@/lib/transfer-review";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import {
  DEWSDetail,
  DistributionSection,
  FlowsSection,
  KeyInfoCard,
  MarketDataSection,
  McapChart,
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
  mechanismBacking: MechanismBackingView | null;
  mechanismCollateralization: MechanismCollateralizationView | null;
  mechanismReview: MechanismReviewView | null;
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
  mechanismBacking,
  mechanismCollateralization,
  mechanismReview,
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
  const regulatoryStanding = buildRegulatoryStandingView(viewModel.coin);
  const showPegChart =
    viewModel.coin.flags.pegCurrency === "USD"
    && !viewModel.isNavToken
    && viewModel.coin.flags.yieldBearing !== true
    && viewModel.supplyHistory.length > 0;
  const showDepegResolver = !viewModel.isNavToken && viewModel.pegScoreResult?.activeDepeg === true;
  const failureDomainsView = buildFailureDomainsView(viewModel.reportCard);
  const liveCollateralizationRatio = viewModel.reserves?.metadata?.collateralizationRatio ?? null;
  const liveLiquidationCapacityRatio = viewModel.reserves?.metadata?.liquidationCapacityRatio ?? null;
  const hasStructureCards =
    mechanismCollateralization != null
    || liveCollateralizationRatio != null
    || liveLiquidationCapacityRatio != null
    || failureDomainsView != null;

  return (
    <>
      <div id="overview" ref={overviewGateRef} className="space-y-6 scroll-mt-32">
        <section id="info" className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6">
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
          {viewModel.reportCard && viewModel.reportCardsResponse ? (
            <StablecoinSafetyScoreV9Card
              card={viewModel.reportCard}
              identity={viewModel.reportCardsResponse.safetyScoreIdentity}
              publicationHealth={viewModel.reportCardsResponse.publicationHealth}
              updatedAtMs={viewModel.reportCardUpdatedAt}
              stablecoinName={viewModel.coin.name}
              rightColumn={reservesPanel}
              transferReview={transferReview}
            />
          ) : null}
        </section>
        {!viewModel.reportCard ? reservesPanel : null}
        {/* The xl summary rail owns these structure cards on desktop; below
            xl the rail is hidden, so in-flow copies keep collateralization
            and failure-domain facts on narrow viewports. */}
        {hasStructureCards ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:hidden">
            <CollateralizationCard
              reviewed={mechanismCollateralization}
              liveRatio={liveCollateralizationRatio}
              liveLiquidationCapacityRatio={liveLiquidationCapacityRatio}
              liveAtSec={viewModel.reserves?.liveAt ?? null}
            />
            <FailureDomainsCard view={failureDomainsView} />
          </div>
        ) : null}
        {viewModel.coin.custodyProfileSummary ? (
          <div className="xl:hidden">
            <CustodyCard summary={viewModel.coin.custodyProfileSummary} />
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
        <MechanismReviewPanel review={mechanismReview} />
        {mechanismBacking ? (
          <div className="xl:hidden">
            <BackingMechanicsCard view={mechanismBacking} />
          </div>
        ) : null}
        {viewModel.coin.bridgeRouteRiskSummary ? (
          <div className="xl:hidden">
            <BridgingCard summary={viewModel.coin.bridgeRouteRiskSummary} />
          </div>
        ) : null}
        {regulatoryStanding ? (
          <div className="xl:hidden">
            <RegulatoryStandingCard view={regulatoryStanding} />
          </div>
        ) : null}
        <MintAuthoritySection profile={viewModel.mintAuthority} symbol={viewModel.coin.symbol} />
        {viewModel.coin.oracleRiskSummary ? (
          <OracleLiquidationSection summary={viewModel.coin.oracleRiskSummary} />
        ) : null}
        {showPegChart ? (
          <MarketDataSection
            stablecoinId={viewModel.id}
            supplyHistory={viewModel.supplyHistory}
            pegCurrency={viewModel.coin.flags.pegCurrency}
            updatedAtMs={viewModel.supplyUpdatedAt}
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
    </>
  );
}
