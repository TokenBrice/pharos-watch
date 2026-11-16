"use client";

import type { ReactNode, Ref } from "react";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { Hourglass, Sparkles } from "lucide-react";
import { LazySection } from "@/components/lazy-section";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ContractDeployments } from "@/components/stablecoin-detail/contract-deployments";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { TapeForCoinTeaser } from "@/components/tape/tape-for-coin-teaser";
import { useMintBurnEvents } from "@/hooks/use-mint-burn-flows";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import {
  BlacklistHistorySection,
  FlowHistorySection,
  HistoryTabs,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

/**
 * Flow History lists counted events only; with none in the retained ledger the
 * module would be explanations alone, so it is hidden. The probe reads the
 * feed's own first page (same query key, deduplicated) behind the module's
 * viewport gate; loading and failed reads still mount the module, which owns
 * those states.
 */
function CountedFlowHistory({ stablecoinId }: { stablecoinId: string }) {
  const { data, isLoading, isError } = useMintBurnEvents(stablecoinId, { scope: "counted", limit: 10, offset: 0 });
  if (!isLoading && !isError && data != null && data.events.length === 0) return null;
  return <FlowHistorySection stablecoinId={stablecoinId} />;
}

interface DetailHistoryExploreSectionsProps {
  activeBannerId: string;
  depegHistoryPreview: ReactNode;
  exploreNextContent: ReactNode;
  frozenNote: ReactNode;
  historyActive: boolean;
  historyGateRef: Ref<HTMLDivElement>;
  viewModel: ReadyDetailViewModel;
}

export function DetailHistoryExploreSections({
  activeBannerId,
  depegHistoryPreview,
  exploreNextContent,
  frozenNote,
  historyActive,
  historyGateRef,
  viewModel,
}: DetailHistoryExploreSectionsProps) {
  // A frozen archive and a card outside `rated` carry no current-publication grade,
  // so Grade History must not date a streak at the grade-history cron's writing run.
  const currentlyRated = viewModel.reportCard
    ? viewModel.reportCard.ratingStatus === "rated"
    : viewModel.coin.status === "frozen"
      ? false
      : null;
  return (
    <>
      {/* Gaps sit only between non-empty children: a module that renders
          nothing leaves an empty wrapper, which must not add a gap. */}
      <div ref={historyGateRef} className="[&>:not(:empty)~:not(:empty)]:mt-6">
        <SectionBanner id="history" label="History" icon={Hourglass} active={activeBannerId === "history"} />
        {frozenNote}
        <section id="coin-timeline" aria-label="Coin event timeline" className="xl:hidden">
          <LazySection minHeight={180}>
            <TapeForCoinTeaser coinId={viewModel.id} supplyUsd={viewModel.mcap} />
          </LazySection>
        </section>
        <HistoryTabs
          stablecoinId={viewModel.id}
          isNavToken={viewModel.isNavToken}
          historyActive={historyActive}
          currentlyRated={currentlyRated}
          depegHistoryPreview={depegHistoryPreview}
          observationStartedAt={viewModel.pegScoreResult?.observationStartedAt ?? null}
          hasPriceData={isObservedPrice(viewModel.coinData) && viewModel.coinData.price != null}
          depegEventCoverageLimited={viewModel.pegScoreResult?.depegEventCoverageLimited === true}
          historyCoverage={viewModel.pegScoreResult?.historyCoverage ?? null}
          recent90d={viewModel.pegScoreResult?.recent90d ?? null}
          liveGrade={viewModel.reportCard?.ratingStatus === "rated" && viewModel.reportCard.grade != null
            ? { grade: viewModel.reportCard.grade, score: viewModel.reportCard.score }
            : null}
        />
        {/* No reserve on these two: a reserve outlives the mount while on
            screen, so a module shorter than it (or hidden) left a blank band. */}
        {viewModel.hasFlowHistory ? (
          <LazySection>
            <CountedFlowHistory stablecoinId={viewModel.id} />
          </LazySection>
        ) : null}
        {viewModel.hasBlacklist ? (
          <SectionErrorBoundary name="blacklist-history">
            <LazySection>
              <BlacklistHistorySection stablecoinId={viewModel.id} symbol={viewModel.blacklistSymbol!} />
            </LazySection>
          </SectionErrorBoundary>
        ) : null}
      </div>

      {/* Below xl the rail's reference cards close the dossier, stacked full
          width: outbound links (with the attestation link) as one compact row,
          then the contract tiles. Side by side, the short links card left a
          blank column beside the tall contracts card. They own `#attestation`
          and `#contracts` here; the xl rail copies are their twins. */}
      <div className="grid gap-4 xl:hidden">
        <KeyLinksCard meta={viewModel.coin} anchors />
        <ContractDeployments coinId={viewModel.coin.id} contracts={viewModel.coin.contracts ?? []} />
      </div>

      {/* Prerendered, not viewport-gated: its links are crawlable without JS
          and need no live data. */}
      {exploreNextContent ? (
        <div className="space-y-6">
          <SectionBanner id="explore" label="Explore" icon={Sparkles} active={activeBannerId === "explore"} />
          {exploreNextContent}
        </div>
      ) : null}
    </>
  );
}
