"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ReportCardDetail } from "@/components/report-card";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ChartSection } from "@/components/stablecoin-detail/chart-section";
import { DepegHistorySection } from "@/components/stablecoin-detail/depeg-history-section";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { FlowsSection } from "@/components/stablecoin-detail/flows-section";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import { InfoSection } from "@/components/stablecoin-detail/info-section";
import { LiquiditySection } from "@/components/stablecoin-detail/liquidity-section";
import { NoticesAndSummarySection } from "@/components/stablecoin-detail/notices-and-summary-section";
import {
  useStablecoinDetailViewModel,
  type StablecoinDetailSummary,
} from "@/hooks/use-stablecoin-detail-view-model";
import type { StablecoinMeta } from "@shared/types";

const DETAIL_SECTIONS = [
  { id: "report-card", label: "Safety Score" },
  { id: "overview", label: "Overview" },
  { id: "chart", label: "Chart" },
  { id: "info", label: "Info" },
  { id: "flows", label: "Flows" },
  { id: "liquidity", label: "Liquidity" },
  { id: "history", label: "Depeg History" },
];

interface StablecoinDetailClientProps {
  id: string;
  summary: StablecoinDetailSummary | null;
  coin: StablecoinMeta;
  logoSrc?: string;
}

export default function StablecoinDetailClient({ id, summary, coin, logoSrc }: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const viewModel = useStablecoinDetailViewModel({ id, summary, coin, logoSrc });

  if (viewModel.status === "loading") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[280px] rounded-xl" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  if (viewModel.status === "list-error") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <QueryErrorNotice error={viewModel.listError} hasData={false} onRetry={viewModel.handleRetryAll} />
      </div>
    );
  }

  if (viewModel.status === "not-found") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">This trail leads nowhere.</p>
      </div>
    );
  }

  const detailSections = viewModel.hasFlows
    ? DETAIL_SECTIONS
    : DETAIL_SECTIONS.filter((section) => section.id !== "flows");

  return (
    <div className="space-y-6">
      {viewModel.supplyError != null ? (
        <QueryErrorNotice
          error={viewModel.supplyError}
          hasData={viewModel.supplyHistory.length > 0}
          onRetry={viewModel.handleRetryAll}
        />
      ) : null}

      <StaleDataBanner queries={viewModel.staleQueries} />

      <HeroCard
        coin={viewModel.coin}
        coinData={viewModel.coinData}
        logoSrc={viewModel.logoSrc}
        isNavToken={viewModel.isNavToken}
        mcap={viewModel.mcap}
        supply={viewModel.supply}
        prevDay={viewModel.prevDay}
        prevWeek={viewModel.prevWeek}
        prevMonth={viewModel.prevMonth}
        prev90d={viewModel.prev90d}
        pegRef={viewModel.pegRef}
        deviationBps={viewModel.deviationBps}
        gaugeDeviationBps={viewModel.gaugeDeviationBps}
        usesFallbackPegRate={viewModel.usesFallbackPegRate}
        pegScoreResult={viewModel.pegScoreResult}
        pegScoreBorderClass={viewModel.pegScoreBorderClass}
        liquidityData={viewModel.liquidityData}
        liqBorderClass={viewModel.liqBorderClass}
        onOpenFeedback={() => setFeedbackOpen(true)}
      />

      <LongformScrollspyNav
        sections={detailSections}
        railLabel="Jump to Section"
        navAriaLabel="Stablecoin detail section navigation"
      />

      <section id="report-card">
        {viewModel.reportCard && <ReportCardDetail card={viewModel.reportCard} />}
      </section>

      <NoticesAndSummarySection
        stablecoinId={viewModel.id}
        coin={viewModel.coin}
        summary={viewModel.summary}
        reserves={viewModel.reserves}
        isNavToken={viewModel.isNavToken}
      />

      <ChartSection supplyHistory={viewModel.supplyHistory} />

      <InfoSection coin={viewModel.coin} />

      <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />

      <LiquiditySection stablecoinId={viewModel.id} />

      <DepegHistorySection
        stablecoinId={viewModel.id}
        earliestTrackingDate={viewModel.earliestTrackingDate}
        hasPriceData={viewModel.coinData.price != null}
        isNavToken={viewModel.isNavToken}
      />

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType="data-correction"
        stablecoinId={viewModel.coin.id}
        stablecoinName={viewModel.coin.name}
        pegValue={viewModel.coinData.price != null ? `$${viewModel.coinData.price.toFixed(6)}` : undefined}
      />
    </div>
  );
}
