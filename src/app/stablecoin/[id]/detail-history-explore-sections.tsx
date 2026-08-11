"use client";

import type { ReactNode, Ref } from "react";
import { Hourglass, Sparkles } from "lucide-react";
import { LazySection } from "@/components/lazy-section";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import {
  BlacklistHistorySection,
  DdrTrackRecordSection,
  DepegHistory,
  FlowHistorySection,
  SafetyScoreHistorySection,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

interface DetailHistoryExploreSectionsProps {
  activeBannerId: string;
  exploreNextContent: ReactNode;
  faqContent: ReactNode;
  frozenNote: ReactNode;
  historyGateRef: Ref<HTMLDivElement>;
  viewModel: ReadyDetailViewModel;
}

export function DetailHistoryExploreSections({
  activeBannerId,
  exploreNextContent,
  faqContent,
  frozenNote,
  historyGateRef,
  viewModel,
}: DetailHistoryExploreSectionsProps) {
  return (
    <>
      <div ref={historyGateRef} className="space-y-6">
        <SectionBanner id="history" label="History" icon={Hourglass} active={activeBannerId === "history"} />
        {frozenNote}
        <section id="coin-timeline" aria-label="Coin event timeline" className="xl:hidden">
          <TapeForCoinTeaser coinId={viewModel.id} />
        </section>
        <LazySection minHeight={220}>
          <SafetyScoreHistorySection stablecoinId={viewModel.id} />
        </LazySection>
        {!viewModel.isNavToken ? (
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
                historyCoverage={viewModel.pegScoreResult?.historyCoverage ?? null}
                recent90d={viewModel.pegScoreResult?.recent90d ?? null}
              />
            </LazySection>
          </section>
        ) : null}
        {/* Directly after the incident history it grades: DepegHistory is what
            happened, this is how Pharos's frozen forecasts scored against it.
            No reserved height — the module is absent for most coins. */}
        {!viewModel.isNavToken ? (
          <LazySection>
            <DdrTrackRecordSection stablecoinId={viewModel.id} />
          </LazySection>
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

      {exploreNextContent ? (
        <div className="space-y-6">
          <SectionBanner id="explore" label="Explore" icon={Sparkles} active={activeBannerId === "explore"} />
          {exploreNextContent}
        </div>
      ) : null}
      {faqContent}
    </>
  );
}
