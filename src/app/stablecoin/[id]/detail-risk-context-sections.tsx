"use client";

import type { ReactNode, Ref } from "react";
import { ChartPie, Unlink } from "lucide-react";
import { CoinNotices } from "@/components/coin-notice";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { BACKING_METRICS_ANCHOR_ID, BackingMetricsCard } from "@/components/stablecoin-detail/backing-metrics-card";
import { BridgingDeploymentsModule } from "@/components/stablecoin-detail/bridging-card";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { CustodyModule } from "@/components/stablecoin-detail/custody-card";
import { EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import { FailureScenarioModule } from "@/components/stablecoin-detail/failure-scenario/failure-scenario-module";
import type { FailureScenarioSelection } from "@/components/stablecoin-detail/failure-scenario/scenario-model";
import { FreezeSeizureModule } from "@/components/stablecoin-detail/freeze-seizure-card";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { ContagionSnapshot } from "@/components/stablecoin-detail/contagion-snapshot";
import { MintAuthoritySection } from "@/components/stablecoin-detail/mint-authority-section";
import {
  OracleLiquidationSection,
  oracleModuleSize,
} from "@/components/stablecoin-detail/oracle-liquidation-section";
import { RedemptionRouteSection } from "@/components/stablecoin-detail/redemption-backstop-card";
import { RegulatoryStandingCard } from "@/components/stablecoin-detail/regulatory-standing-card";
import type {
  PillarEvidenceAnchors,
  PillarEvidenceBoardVisibility,
} from "@/components/stablecoin-detail/safety-score-v9-breakdown";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { LazySection } from "@/components/lazy-section";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import { isCustodyStructureUndisclosed } from "@/lib/stablecoin-detail-custody-client";
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
  /** False when the Context zone has nothing to show at `xl+` (see `hasContextZoneContent`). */
  contextHasContent: boolean;
  /** The coin's publishable failure scenario; null renders no banner and no module. */
  failureScenario: FailureScenarioSelection | null;
  frozenNote: ReactNode;
  mechanismBacking: MechanismBackingView | null;
  /** The variant parent's `deriveLiquidationEngine` result, computed server-side. */
  parentLiquidationEngine: boolean | null;
  sharedModules: DetailSharedModules;
  transferReview: TransferReviewView | null;
  overviewGateRef: Ref<HTMLDivElement>;
  variantRelationshipCard: ReactNode;
  viewModel: ReadyDetailViewModel;
}

/**
 * Where a pillar board renders: everywhere, only below `xl` (its only content
 * is an in-flow twin of a rail card), or nowhere. A board never renders a
 * kicker whose modules are all hidden at the current breakpoint.
 */
function resolveBoardVisibility(allWidths: boolean, belowXl: boolean): PillarEvidenceBoardVisibility {
  if (allWidths) return "all";
  return belowXl ? "below-xl" : "none";
}

/**
 * Each pillar board's visibility, read by the boards and by the Safety Score
 * card's "Evidence" links, so a link never targets a board that is absent.
 */
function resolvePillarEvidenceAnchors(shared: DetailSharedModules): PillarEvidenceAnchors {
  return {
    backing: resolveBoardVisibility(shared.custody !== null || shared.custodyNotReviewed, shared.backingMetrics !== null),
    exit: resolveBoardVisibility(shared.hasRedemption || shared.redemptionNotReviewed, shared.accessRows.length > 0),
    // Mint Authority or its "Not reviewed" state always renders, so the board does too.
    control: "all",
  };
}

/**
 * One Safety Score pillar's board: a plain kicker `h2` with a trailing
 * hairline, then full-width signature modules, then the tile grid. The
 * pillar's grade and decomposition live on the Safety Score card, whose
 * pillar rows link to `id`.
 */
function PillarBoard({
  id,
  title,
  visibility,
  children,
}: {
  id: string;
  title: string;
  visibility: PillarEvidenceBoardVisibility;
  children: ReactNode;
}) {
  if (visibility === "none") return null;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={cn("@container/board space-y-4", SECTION_SCROLL_MT, visibility === "below-xl" && "xl:hidden")}
    >
      <h2
        id={`${id}-heading`}
        className="pharos-kicker flex items-center gap-3 pt-2 after:h-px after:flex-1 after:bg-border/50"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

interface BoardTile {
  key: string;
  render: (stripForm: boolean) => ReactNode;
}

interface BoardRow {
  key: string;
  node: ReactNode;
  /** A below-xl-only line (the xl rail carries its card). */
  belowXlOnly?: boolean;
}

/** Where one grid item sits; the component maps it to static classes. */
export interface BoardGridPlacement {
  /** Spans the row at two tracks: at every width, only at xl (twins hidden), or never. */
  rowAtTwo: "always" | "xl" | "never";
  /** Half-tracks of six at three tracks (`@7xl`, xl only); null for a twin, hidden there. */
  halfTracksAtThree: 2 | 3 | 6 | null;
  stripForm: boolean;
}

/** Six half-tracks at `@7xl`: a tile spans two, a pair in a short last row three each. */
function halfTracksAtThree(index: number, count: number): 2 | 3 | 6 {
  if (count === 1) return 6;
  const remainder = count % 3;
  // 2 left over: the last two split the row. 1 left over: rather than one
  // lone tile, the last four pair up as two rows of two.
  if ((remainder === 2 && index >= count - 2) || (remainder === 1 && index >= count - 4)) return 3;
  return 2;
}

/**
 * Grid placement for a board's tiles followed by its twins. Rule: a last row
 * never leaves an empty track, at one, two or three tracks.
 *
 * Twins are in-flow copies of xl rail cards (Backing KPI, Regulatory): grid
 * items below xl only, so they pair with a tile instead of taking a row each.
 * Three tracks (`@7xl`) are only reached at xl, so twins never meet them; at
 * two tracks the count is tiles + twins below xl and tiles alone at xl, so a
 * tile can be lone only at xl. A tile lone at two tracks renders in strip form.
 */
export function resolveBoardGridPlacement(tileCount: number, twinCount: number): BoardGridPlacement[] {
  const belowXlCount = tileCount + twinCount;
  const tiles = Array.from({ length: tileCount }, (_, index): BoardGridPlacement => {
    const loneAtXl = index === tileCount - 1 && tileCount % 2 === 1;
    const loneBelowXl = index === belowXlCount - 1 && belowXlCount % 2 === 1;
    return {
      rowAtTwo: loneBelowXl ? "always" : loneAtXl ? "xl" : "never",
      halfTracksAtThree: halfTracksAtThree(index, tileCount),
      stripForm: loneAtXl,
    };
  });
  const twins = Array.from({ length: twinCount }, (_, offset): BoardGridPlacement => {
    const lone = tileCount + offset === belowXlCount - 1 && belowXlCount % 2 === 1;
    return { rowAtTwo: lone ? "always" : "never", halfTracksAtThree: null, stripForm: lone };
  });
  return [...tiles, ...twins];
}

const ROW_AT_TWO_CLASS: Record<BoardGridPlacement["rowAtTwo"], string | null> = {
  always: "col-span-full",
  xl: "xl:col-span-full",
  never: null,
};

const HALF_TRACKS_AT_THREE_CLASS: Record<2 | 3 | 6, string> = {
  2: "@7xl/board:col-span-2",
  3: "@7xl/board:col-span-3",
  6: "@7xl/board:col-span-full",
};

/**
 * Tiles target ~480 px (plan §3 rule 4): one track below a 48rem board, two
 * from `@3xl` (the ~992 px column at xl, and every board below xl from
 * 768 px), three from `@7xl` (the ~1,472 px column at 1920), drawn as six
 * half-tracks so a short last row can split evenly. Placement comes from
 * `resolveBoardGridPlacement`. Static classes only: Tailwind emits container
 * variants after breakpoints, so `@7xl/board:` wins over `xl:` on the same
 * item, and no item carries a competing `@3xl/board:` span.
 *
 * `rows` are full-width lines (strip-form modules, S14 states) that follow.
 */
function BoardTileGrid({
  tiles,
  twins = [],
  rows,
}: {
  tiles: readonly BoardTile[];
  twins?: readonly BoardTile[];
  rows: readonly BoardRow[];
}) {
  if (tiles.length === 0 && twins.length === 0 && rows.length === 0) return null;
  const placements = resolveBoardGridPlacement(tiles.length, twins.length);
  const items = [...tiles, ...twins];
  return (
    <div className="grid items-start gap-4 @3xl/board:grid-cols-2 @7xl/board:grid-cols-6">
      {items.map((item, index) => {
        const placement = placements[index]!;
        return (
          <div
            key={item.key}
            className={cn(
              "min-w-0",
              ROW_AT_TWO_CLASS[placement.rowAtTwo],
              placement.halfTracksAtThree === null
                ? "xl:hidden"
                : HALF_TRACKS_AT_THREE_CLASS[placement.halfTracksAtThree],
            )}
          >
            {item.render(placement.stripForm)}
          </div>
        );
      })}
      {rows.map((row) => (
        <div key={row.key} className={cn("col-span-full min-w-0", row.belowXlOnly && "xl:hidden")}>
          {row.node}
        </div>
      ))}
    </div>
  );
}

function BackingBoard({ shared, visibility }: { shared: DetailSharedModules; visibility: PillarEvidenceBoardVisibility }) {
  const { custody, backingMetrics } = shared;
  const custodyUndisclosed = custody !== null && isCustodyStructureUndisclosed(custody);
  const tiles: BoardTile[] = custody && !custodyUndisclosed
    ? [{ key: "custody", render: (stripForm) => <CustodyModule summary={custody} variant="tile" stripForm={stripForm} /> }]
    : [];
  // The xl rail carries the Backing KPI card; below xl this twin owns
  // `#collateralization` and the `#backing-mechanics` alias.
  const twins: BoardTile[] = backingMetrics
    ? [{
        key: "backing-metrics",
        render: (stripForm) => (
          <BackingMetricsCard view={backingMetrics} id={BACKING_METRICS_ANCHOR_ID} stripForm={stripForm} />
        ),
      }]
    : [];
  const rows: BoardRow[] = [];
  if (custody && custodyUndisclosed) {
    rows.push({ key: "custody", node: <CustodyModule summary={custody} variant="tile" stripForm /> });
  }
  if (shared.custodyNotReviewed) {
    rows.push({
      key: "custody",
      node: <EvidenceStateStrip id="custody" title="Custody" state="not-reviewed" density="main" />,
    });
  }

  return (
    <PillarBoard id="backing-evidence" title="Backing evidence" visibility={visibility}>
      <BoardTileGrid tiles={tiles} twins={twins} rows={rows} />
    </PillarBoard>
  );
}

function ExitBoard({
  shared,
  transferReview,
  viewModel,
  visibility,
}: {
  shared: DetailSharedModules;
  transferReview: TransferReviewView | null;
  viewModel: ReadyDetailViewModel;
  visibility: PillarEvidenceBoardVisibility;
}) {
  return (
    <PillarBoard id="exit-evidence" title="Exit evidence" visibility={visibility}>
      {shared.hasRedemption ? (
        <RedemptionRouteSection
          entry={viewModel.redemptionBackstop}
          reportCard={viewModel.reportCard}
          coinId={viewModel.coin.id}
          variant="module"
        />
      ) : shared.redemptionNotReviewed ? (
        <EvidenceStateStrip id="redemption" title="Redemption route" state="not-reviewed" density="main" />
      ) : null}
      {/* The xl rail carries the Access posture card; below xl this strip
          keeps it with the exit evidence it scores. */}
      <AccessPosturePanel variant="strip" className="xl:hidden" rows={shared.accessRows} review={transferReview} />
    </PillarBoard>
  );
}

function ControlBoard({
  shared,
  transferReview,
  viewModel,
  visibility,
}: {
  shared: DetailSharedModules;
  transferReview: TransferReviewView | null;
  viewModel: ReadyDetailViewModel;
  visibility: PillarEvidenceBoardVisibility;
}) {
  const { coin } = viewModel;
  const { controlRoles, failureDomains, bridgingForm, bridgingPlaceholder, regulatoryStanding } = shared;
  const oracleSummary = coin.oracleRiskSummary ?? null;
  const oracleSize = oracleSummary ? oracleModuleSize(oracleSummary) : null;
  // Multi-branch collateral pricing needs the full width; a not-applicable
  // review is one strip line. Both keep the Price feed's place after Mint.
  const oracleFullWidth = oracleSummary !== null && (oracleSize === "module" || oracleSummary.notApplicable);
  const bridgeSummary = coin.bridgeRouteRiskSummary ?? null;
  const blacklistabilitySummary = coin.blacklistabilitySummary ?? null;

  const tiles: BoardTile[] = [];
  if (oracleSummary && !oracleFullWidth) {
    tiles.push({
      key: "oracle",
      render: (stripForm) => (
        <OracleLiquidationSection summary={oracleSummary} controlRoles={controlRoles} variant="tile" stripForm={stripForm} />
      ),
    });
  }
  if (bridgingForm === "tile") {
    tiles.push({
      key: "bridging",
      render: (stripForm) => (
        <BridgingDeploymentsModule
          summary={bridgeSummary}
          failureDomains={failureDomains}
          controlRoles={controlRoles}
          variant="tile"
          stripForm={stripForm}
        />
      ),
    });
  }
  if (blacklistabilitySummary) {
    tiles.push({
      key: "freeze-seizure",
      render: (stripForm) => (
        <FreezeSeizureModule
          summary={blacklistabilitySummary}
          transferReview={transferReview}
          symbol={coin.symbol}
          variant="tile"
          stripForm={stripForm}
        />
      ),
    });
  }
  // The xl rail carries the Regulatory standing card; below xl this twin
  // owns `#jurisdiction` (the passport's Jurisdiction and MiCA target).
  const twins: BoardTile[] = regulatoryStanding
    ? [{
        key: "regulatory",
        render: (stripForm) => <RegulatoryStandingCard view={regulatoryStanding} id="jurisdiction" stripForm={stripForm} />,
      }]
    : [];
  const rows: BoardRow[] = [];
  if (bridgingForm === "strip") {
    rows.push({
      key: "bridging",
      node: (
        <BridgingDeploymentsModule
          summary={bridgeSummary}
          failureDomains={failureDomains}
          controlRoles={controlRoles}
          variant="tile"
          stripForm
        />
      ),
    });
  }
  if (bridgingPlaceholder) {
    rows.push({
      key: "bridging",
      node: (
        <EvidenceStateStrip
          id="bridging"
          title="Bridging & deployments"
          state={bridgingPlaceholder.state}
          reason={bridgingPlaceholder.reason}
          density="main"
        />
      ),
    });
  }
  if (shared.regulatoryNotReviewed) {
    rows.push({
      key: "regulatory",
      belowXlOnly: true,
      node: <EvidenceStateStrip id="jurisdiction" title="Regulatory standing" state="not-reviewed" density="main" />,
    });
  }

  return (
    <PillarBoard id="control-evidence" title="Control evidence" visibility={visibility}>
      {shared.hasMintAuthority ? (
        <MintAuthoritySection
          profile={viewModel.mintAuthority}
          symbol={coin.symbol}
          controlRoles={controlRoles}
          controlPosture={shared.controlPosture}
          variant="module"
        />
      ) : (
        <EvidenceStateStrip id="mint-authority" title="Mint Authority" state="not-reviewed" density="main" />
      )}
      {oracleSummary && oracleFullWidth ? (
        <OracleLiquidationSection summary={oracleSummary} controlRoles={controlRoles} variant={oracleSize ?? "module"} />
      ) : null}
      <BoardTileGrid tiles={tiles} twins={twins} rows={rows} />
    </PillarBoard>
  );
}

export function DetailRiskContextSections({
  activeBannerId,
  contextHasContent,
  failureScenario,
  frozenNote,
  mechanismBacking,
  parentLiquidationEngine,
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
  // half; a live-feed-only module would leave a mostly empty box beside the score.
  const pairScoreAndReserves = showScoreCard && hasReviewedSlices;
  const evidenceAnchors = resolvePillarEvidenceAnchors(sharedModules);

  return (
    <>
      {/* Risk zone = the Safety Score's spine: the Mechanism primer, the
          score beside Reserves, the live stress layer, then each pillar's
          evidence board in pillar order. */}
      <div id="overview" ref={overviewGateRef} className="space-y-6 scroll-mt-32">
        {/* `#info` is the passport strip's fallback target for facts that live
            in the strip itself (launch date, jurisdiction without a regulatory
            review), so the section keeps the id even when the coin has no peg
            mechanism to render. Mechanism stays ahead of the score: it is the
            "how this coin holds its peg" primer the pillars assume. */}
        <section id="info" className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6">
          {viewModel.coin.pegMechanism ? (
            <PegStabilityCard
              meta={viewModel.coin}
              resolvedMechanismArchetype={resolvedMechanismArchetype}
              isWrapper={isWrapperVariant}
              parentSymbol={isWrapperVariant ? viewModel.variantParent?.symbol : null}
              parentArchetype={parentArchetype}
              parentNavToken={isWrapperVariant ? (viewModel.variantParent?.flags?.navToken ?? null) : null}
              parentLiquidationEngine={isWrapperVariant ? parentLiquidationEngine : null}
              variantKind={viewModel.coin.variantKind ?? null}
              hasReviewedReserves={hasReviewedSlices}
              mechanismBacking={mechanismBacking}
              mechanismReview={sharedModules.mechanismReview}
            />
          ) : null}
        </section>
        {/* Score left, Reserves right at lg+ when both exist and Reserves has
            a reviewed composition; otherwise each takes the full width,
            stacked. `items-start`: opening a disclosure in one half never
            stretches the other. */}
        <div className={cn("grid items-start gap-6", pairScoreAndReserves ? "lg:grid-cols-2" : undefined)}>
          <section id="report-card" className={cn("min-w-0", SECTION_SCROLL_MT)}>
            {reportCard && reportCardsResponse ? (
              <StablecoinSafetyScoreV9Card
                card={reportCard}
                identity={reportCardsResponse.safetyScoreIdentity}
                publicationHealth={reportCardsResponse.publicationHealth}
                updatedAtMs={viewModel.reportCardUpdatedAt}
                stablecoinName={viewModel.coin.name}
                stablecoinSymbol={viewModel.coin.symbol}
                logoSrc={viewModel.logoSrc}
                evidenceAnchors={evidenceAnchors}
              />
            ) : null}
          </section>
          {showReserves ? (
            <div className="min-w-0">
              <ReservesSection
                coin={viewModel.coin}
                reserves={viewModel.reserves}
                reserveFetchError={viewModel.reserveFetchError}
                onRetry={viewModel.refetchReserves ?? undefined}
                isFetching={viewModel.isFetchingReserves}
                isLoading={reservesLoading}
                qualitySummary={qualitySummary}
                lookThrough={viewModel.coin.reserveLookThrough ?? null}
              />
            </div>
          ) : null}
        </div>
        {showDepegResolver ? (
          <StablecoinDepegResolverCard stablecoinId={viewModel.id} logoSrc={viewModel.logoSrc} />
        ) : null}
        {/* How it breaks: a curated hypothetical failure path, rendered only
            for a publishable record (a marked draft on a dev server). It sits
            directly under the score and reserves, ahead of the pillar
            evidence, because it narrates the path that evidence weighs. */}
        {failureScenario ? (
          <div className="space-y-6">
            <SectionBanner
              id="how-it-breaks"
              label="How it breaks"
              icon={Unlink}
              active={activeBannerId === "how-it-breaks"}
            />
            <FailureScenarioModule selection={failureScenario} />
          </div>
        ) : null}
        {/* Scrollspy marker: the Risk pill lights again below the interleaved
            module, so the evidence boards are not labelled "How it breaks". */}
        {failureScenario ? <div id="risk-evidence-resume" aria-hidden="true" /> : null}

        {/* The live stress layer sits beside the structural score, before the
            pillar evidence (decision S4). A frozen archive or a NAV token
            states why it is absent, under the module's own title. */}
        {sharedModules.dewsPlaceholder ? (
          <EvidenceStateStrip
            title="Depeg Early Warning"
            state={sharedModules.dewsPlaceholder.state}
            reason={sharedModules.dewsPlaceholder.reason}
            density="main"
            headingLevel="h2"
          />
        ) : (
          <DEWSDetail stablecoinId={viewModel.id} />
        )}

        <BackingBoard shared={sharedModules} visibility={evidenceAnchors.backing} />
        <ExitBoard
          shared={sharedModules}
          transferReview={transferReview}
          viewModel={viewModel}
          visibility={evidenceAnchors.exit}
        />
        <ControlBoard
          shared={sharedModules}
          transferReview={transferReview}
          viewModel={viewModel}
          visibility={evidenceAnchors.control}
        />

        {overviewNotices.length > 0 ? <CoinNotices notices={overviewNotices} /> : null}
        {viewModel.hasFlows ? (
          <>
            {frozenNote}
            <LazySection minHeight={320}>
              <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />
            </LazySection>
          </>
        ) : null}
      </div>

      {/* Without dependency context the zone holds only the below-xl reference
          copies: no banner at any width (it would mislabel them), and at xl+
          nothing renders, matching the scrollspy, which drops the pill. */}
      <div className={cn("space-y-6", contextHasContent ? undefined : "xl:hidden")}>
        {contextHasContent ? (
          <SectionBanner id="context" label="Context" icon={ChartPie} active={activeBannerId === "context"} />
        ) : null}
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
