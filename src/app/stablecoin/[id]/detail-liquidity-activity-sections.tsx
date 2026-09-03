"use client";

import { useState, type ReactNode, type Ref } from "react";
import { Droplet, HeartPulse } from "lucide-react";
import { LazySection } from "@/components/lazy-section";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { RedemptionBackstopCard } from "@/components/stablecoin-detail/redemption-backstop-card";
import { SectionBanner } from "@/components/stablecoin-detail/section-banner";
import type { StablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import {
  BlacklistSection,
  DexLiquidityCard,
  DistributionSection,
  MarketDataSection,
  McapChart,
  YieldDetailSection,
} from "./detail-lazy-sections";

type ReadyDetailViewModel = Extract<StablecoinDetailViewModel, { status: "ready" }>;

function ExpandableMcapChart({
  stablecoinId,
  supplyHistory,
}: {
  stablecoinId: string;
  supplyHistory: ReadyDetailViewModel["supplyHistory"];
}) {
  const [range, setRange] = useState<TimeRangeOption>("90d");

  return (
    <McapChart
      data={supplyHistory}
      stablecoinId={stablecoinId}
      controlledRange={range}
      onControlledRangeChange={setRange}
      expandHistoryOnWideRange
    />
  );
}

interface DetailLiquidityActivitySectionsProps {
  activeBannerId: string;
  activityGateRef: Ref<HTMLDivElement>;
  frozenNote: ReactNode;
  viewModel: ReadyDetailViewModel;
}

export function DetailLiquidityActivitySections({
  activeBannerId,
  activityGateRef,
  frozenNote,
  viewModel,
}: DetailLiquidityActivitySectionsProps) {
  const hasPriceTransparency = viewModel.coinData.price != null || Boolean(viewModel.dexPriceCheck);
  const showPegChart =
    viewModel.coin.flags.pegCurrency === "USD"
    && !viewModel.isNavToken
    && viewModel.coin.flags.yieldBearing !== true
    && viewModel.supplyHistory.length > 0;

  return (
    <>
      <div className="space-y-6">
        {/* Zone id stays `liquidity` (stable anchor); the label reads "Market"
            because supply history and holder distribution moved here from the
            Context zone, where a market chart went unfound. */}
        <SectionBanner id="liquidity" label="Market" icon={Droplet} active={activeBannerId === "liquidity"} />
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
              <ExpandableMcapChart stablecoinId={viewModel.id} supplyHistory={viewModel.supplyHistory} />
            </LazySection>
          </section>
        )}
        <section id="distribution">
          {frozenNote}
          <SectionErrorBoundary name="distribution">
            <DistributionSection stablecoinId={viewModel.id} />
          </SectionErrorBoundary>
        </section>
        <section id="dex-liquidity">
          {frozenNote}
          <SectionErrorBoundary name="liquidity">
            <LazySection minHeight={360}>
              <DexLiquidityCard stablecoinId={viewModel.id} />
            </LazySection>
          </SectionErrorBoundary>
        </section>

        {(hasPriceTransparency || viewModel.redemptionBackstop) ? (
          <div className="grid grid-cols-1 gap-6">
            {viewModel.redemptionBackstop ? (
              <RedemptionBackstopCard entry={viewModel.redemptionBackstop} />
            ) : null}
            {hasPriceTransparency ? (
              <section id="price" aria-label="Price transparency" className="xl:hidden">
                <PriceTransparencyCard
                  coinData={viewModel.coinData}
                  consensusSources={viewModel.consensusSources ?? []}
                  agreeSources={viewModel.agreeSources ?? []}
                  dexPriceCheck={viewModel.dexPriceCheck}
                />
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <div ref={activityGateRef} className="space-y-6">
        <SectionBanner id="activity" label="Activity" icon={HeartPulse} active={activeBannerId === "activity"} />
        {viewModel.hasYieldSection ? <YieldDetailSection stablecoinId={viewModel.id} /> : null}
        {viewModel.hasBlacklist ? (
          <div>
            {frozenNote}
            <SectionErrorBoundary name="blacklist">
              <LazySection minHeight={320}>
                <BlacklistSection stablecoinId={viewModel.id} symbol={viewModel.blacklistSymbol!} />
              </LazySection>
            </SectionErrorBoundary>
          </div>
        ) : null}
      </div>
    </>
  );
}
