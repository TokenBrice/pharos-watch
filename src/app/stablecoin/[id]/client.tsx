"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ReportCardDetail } from "@/components/report-card";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import { NoticesAndSummarySection } from "@/components/stablecoin-detail/notices-and-summary-section";
import { ExploitNoticeBanner } from "@/components/exploit-notice-banner";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import {
  useStablecoinDetailViewModel,
  type StablecoinDetailSummary,
} from "@/hooks/use-stablecoin-detail-view-model";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types";

function DetailSectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

const McapChart = dynamic(() => import("@/components/mcap-chart").then((mod) => mod.McapChart), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const DepegHistory = dynamic(
  () => import("@/components/depeg-history").then((mod) => mod.DepegHistory),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const FlowsSection = dynamic(() => import("@/components/stablecoin-detail/flows-section").then((mod) => mod.FlowsSection), {
  loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const KeyInfoCard = dynamic(() => import("@/components/key-info-card").then((mod) => mod.KeyInfoCard), {
  loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const YieldDetailSection = dynamic(() => import("@/components/yield-detail-section"), {
  loading: () => <DetailSectionSkeleton className="h-[420px] w-full rounded-xl" />,
});

const DexLiquidityCard = dynamic(
  () => import("@/components/dex-liquidity-card").then((mod) => mod.DexLiquidityCard),
  {
    loading: () => <DetailSectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const CollateralUsageSection = dynamic(
  () => import("@/components/stablecoin-detail/collateral-usage-section").then((mod) => mod.CollateralUsageSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[200px] w-full rounded-xl" />,
  },
);

const DistributionSection = dynamic(
  () => import("@/components/stablecoin-detail/distribution-section").then((mod) => mod.DistributionSection),
  {
    loading: () => <DetailSectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const SafetyScoreHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/safety-score-history-section").then((mod) => mod.SafetyScoreHistorySection),
  {
    loading: () => <DetailSectionSkeleton className="h-[220px] w-full rounded-xl" />,
  },
);

const DETAIL_SECTIONS = [
  { id: "report-card", label: "Safety Score" },
  { id: "overview", label: "Overview" },
  { id: "price-transparency", label: "Price Sources" },
  { id: "chart", label: "Chart" },
  { id: "distribution", label: "Distribution" },
  { id: "info", label: "Info" },
  { id: "collateral-usage", label: "Collateral Usage" },
  { id: "yield", label: "Yield" },
  { id: "flows", label: "Flows" },
  { id: "liquidity", label: "Liquidity" },
  { id: "history", label: "Depeg History" },
];

function DetailLoadingShell({ coin, logoSrc }: { coin: StablecoinMeta; logoSrc?: string }) {
  return (
    <div className="space-y-6">
      <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              <StablecoinLogo src={logoSrc} name={coin.name} size={56} />
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-extrabold tracking-tighter text-foreground">{coin.name}</h2>
                  <span className="text-base font-mono text-muted-foreground">{coin.symbol}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} ·{" "}
                  {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} ·{" "}
                  {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
                </p>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Pulling in the full research dossier for this stablecoin.
                </p>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Skeleton className="h-10 w-28 rounded-full" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {["Price", "Market Cap", "Supply", "Liquidity"].map((label) => (
            <div key={label} className="rounded-2xl border border-border/60 bg-background/45 px-3.5 py-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-2xl border border-border/60 bg-background/90 px-4 py-3 shadow-[0_16px_40px_oklch(0_0_0_/0.12)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="pharos-kicker">Jump to Section</p>
          <span className="text-[11px] text-muted-foreground">Research dossier loading</span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {["Safety Score", "Overview", "Chart", "Info", "Liquidity"].map((label) => (
            <div
              key={label}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border/60 bg-background px-4 py-2 text-sm text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-6">
        <Skeleton className="h-[320px] rounded-xl" />
        <Skeleton className="h-[420px] rounded-xl" />
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    </div>
  );
}

interface StablecoinDetailClientProps {
  id: string;
  summary: StablecoinDetailSummary | null;
  coin: StablecoinMeta;
  logoSrc?: string;
}

export default function StablecoinDetailClient({ id, summary, coin, logoSrc }: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const viewModel = useStablecoinDetailViewModel({ id, summary, coin, logoSrc });
  const hasCollateralUsage = useMemo(() => {
    return TRACKED_STABLECOINS.some((c) => {
      if (c.id === id) return false;
      return deriveDependencies(c).some((dep) => dep.id === id);
    });
  }, [id]);
  const {
    data: depegHistoryData,
  } = useInfiniteDepegEvents({
    stablecoinId: id,
    enabled: viewModel.status === "ready" && !viewModel.isNavToken,
    autoLoadAll: viewModel.status === "ready" && !viewModel.isNavToken,
  });

  if (viewModel.status === "loading") {
    return <DetailLoadingShell coin={coin} logoSrc={logoSrc} />;
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
        <p className="text-muted-foreground">
          This stablecoin is not part of the tracked Pharos universe.
        </p>
      </div>
    );
  }

  const detailSections = DETAIL_SECTIONS
    .filter((section) => section.id !== "flows" || viewModel.hasFlows)
    .filter((section) => section.id !== "collateral-usage" || hasCollateralUsage);

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
        recordedDepegEventCount={depegHistoryData?.total ?? null}
        pegScoreBorderClass={viewModel.pegScoreBorderClass}
        liquidityData={viewModel.liquidityData}
        liqBorderClass={viewModel.liqBorderClass}
        onOpenFeedback={() => setFeedbackOpen(true)}
      />

      <ExploitNoticeBanner notices={viewModel.coin.notices} />

      <LongformScrollspyNav
        sections={detailSections}
        railLabel="Jump to Section"
        navAriaLabel="Stablecoin detail section navigation"
      />

      <section id="report-card">
        {viewModel.reportCard && (
          <ReportCardDetail
            card={viewModel.reportCard}
            liquidityComponents={viewModel.liquidityData?.scoreComponents ?? null}
          />
        )}
        <div className="mt-4">
          <SafetyScoreHistorySection stablecoinId={viewModel.id} />
        </div>
      </section>

      <NoticesAndSummarySection
        stablecoinId={viewModel.id}
        coin={viewModel.coin}
        summary={viewModel.summary}
        reserves={viewModel.reserves}
        reserveFetchError={viewModel.reserveFetchError}
        redemptionBackstop={viewModel.redemptionBackstop}
        isNavToken={viewModel.isNavToken}
        coinData={viewModel.coinData}
        consensusSources={viewModel.consensusSources}
        agreeSources={viewModel.agreeSources}
        dexPriceCheck={viewModel.dexPriceCheck}
      />

      <section id="chart">
        <McapChart data={viewModel.supplyHistory} />
      </section>

      <section id="distribution">
        <SectionErrorBoundary name="distribution">
          <DistributionSection stablecoinId={viewModel.id} />
        </SectionErrorBoundary>
      </section>

      <section id="info" className="space-y-6">
        <KeyInfoCard meta={viewModel.coin} />
      </section>

      {hasCollateralUsage && <CollateralUsageSection stablecoinId={viewModel.id} />}

      {detailSections.some((section) => section.id === "yield") ? <YieldDetailSection stablecoinId={viewModel.id} /> : null}

      <section id="liquidity">
        <SectionErrorBoundary name="liquidity">
          <DexLiquidityCard stablecoinId={viewModel.id} />
        </SectionErrorBoundary>
      </section>

      <FlowsSection stablecoinId={viewModel.id} hasFlows={viewModel.hasFlows} />

      {!viewModel.isNavToken ? (
        <section id="history">
          <DepegHistory
            stablecoinId={viewModel.id}
            earliestTrackingDate={viewModel.earliestTrackingDate}
            hasPriceData={viewModel.coinData.price != null}
          />
        </section>
      ) : null}

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
