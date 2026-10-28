"use client";

import type { ReactNode, Ref } from "react";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { Hourglass, Sparkles } from "lucide-react";
import { LazySection } from "@/components/lazy-section";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import { TapeForCoinTeaser } from "@/components/tape-for-coin-teaser";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import {
  BlacklistHistorySection,
  FlowHistorySection,
  HistoryTabs,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

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
  return (
    <>
      <div ref={historyGateRef} className="space-y-6">
        <SectionBanner id="history" label="History" icon={Hourglass} active={activeBannerId === "history"} />
        {frozenNote}
        <section id="coin-timeline" aria-label="Coin event timeline" className="xl:hidden">
          <LazySection minHeight={180}>
            <TapeForCoinTeaser coinId={viewModel.id} />
          </LazySection>
        </section>
        {/* The synchronous shell owns the retained-ledger preview and keeps the
            390px live-portion reserve; its live modules stay viewport-gated. */}
        <HistoryTabs
          stablecoinId={viewModel.id}
          isNavToken={viewModel.isNavToken}
          historyActive={historyActive}
          depegHistoryPreview={depegHistoryPreview}
          observationStartedAt={viewModel.pegScoreResult?.observationStartedAt ?? null}
          hasPriceData={isObservedPrice(viewModel.coinData) && viewModel.coinData.price != null}
          depegEventCoverageLimited={viewModel.pegScoreResult?.depegEventCoverageLimited === true}
          historyCoverage={viewModel.pegScoreResult?.historyCoverage ?? null}
          recent90d={viewModel.pegScoreResult?.recent90d ?? null}
          scoreWindowIncidentCount={viewModel.pegScoreResult?.eventCount ?? null}
        />
        {viewModel.hasFlowHistory ? (
          <LazySection minHeight={340}>
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
