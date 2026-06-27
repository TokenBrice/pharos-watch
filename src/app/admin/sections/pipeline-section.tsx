"use client";

import { useState } from "react";
import type { StatusResponse } from "@shared/types";
import { CoinGeckoPriceDiffCard } from "@/components/status/coingecko-price-diff";
import { DataQualityCards } from "@/components/status/data-quality-cards";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";
import { D1UsageCard } from "@/components/status/d1-usage-card";
import { DiscoveryCandidatesCard } from "@/components/status/discovery-candidates";
import { LiquidityHealthCard } from "@/components/status/liquidity-health";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";
import { MetadataIntegrityCard } from "@/components/status/metadata-integrity-card";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";
import { ReserveSyncHealthCard } from "@/components/status/reserve-sync-health";
import { ScoreImpactPanel } from "@/components/status/score-impact-panel";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { YieldHealthCard } from "@/components/status/yield-health";
import { getStatusTone } from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

export interface PipelineSectionProps {
  data: StatusResponse;
  handleRefresh: () => void;
}

type PipelineTab = "quality" | "markets" | "reserves" | "yield" | "storage" | "discovery";

const PIPELINE_TABS: Array<{ id: PipelineTab; label: string }> = [
  { id: "quality", label: "Quality" },
  { id: "markets", label: "Markets" },
  { id: "reserves", label: "Reserves" },
  { id: "yield", label: "Yield" },
  { id: "storage", label: "Storage" },
  { id: "discovery", label: "Discovery" },
];

export function deriveInitialPipelineTab(data: StatusResponse): PipelineTab {
  if (
    data.dataQuality.missingPrices > 0 ||
    data.dataQuality.blacklistMissingAmounts > 0 ||
    data.dataQuality.onchainSupplyDivergences > 0
  ) {
    return "quality";
  }
  if (
    (data.coingeckoPriceDiff?.mismatchedCount ?? 0) > 0 ||
    (data.priceSourceHealth?.sourceDistribution.missing ?? 0) > 0
  ) {
    return "markets";
  }
  if (
    data.reserveComposition.status !== "healthy" ||
    data.reserveComposition.deferredCoins > 0 ||
    (data.reserveDrift?.length ?? 0) > 0 ||
    (data.classificationWarnings?.length ?? 0) > 0
  ) {
    return "reserves";
  }
  if (data.yieldHealth?.status && data.yieldHealth.status !== "healthy") {
    return "yield";
  }
  if (data.sectionErrors.d1Usage) {
    return "storage";
  }
  if ((data.discoveryCandidates?.length ?? 0) > 0) {
    return "discovery";
  }
  return "quality";
}

export function PipelineSection({ data, handleRefresh }: PipelineSectionProps) {
  const [activeTab, setActiveTab] = useState<PipelineTab>(() => deriveInitialPipelineTab(data));

  return (
    <StatusSection
      id="pipeline"
      kicker="Data Pipeline"
      title="Pipeline Health"
      accentClassName="border-l-cyan-500"
      summary={
        <>
          <SummaryBadge
            label="Data Quality"
            value={getStatusTone(data.dataQualityStatus).label}
            className={getStatusTone(data.dataQualityStatus).badgeClassName}
          />
          <SummaryBadge label="Missing Prices" value={String(data.dataQuality.missingPrices)} />
          <SummaryBadge label="CG Drift" value={String(data.coingeckoPriceDiff?.mismatchedCount ?? 0)} />
          <SummaryBadge label="Yield" value={data.yieldHealth?.status ?? "—"} />
          <SummaryBadge label="Stale On-chain" value={String(data.dataQuality.staleOnchainSupply)} />
          <SummaryBadge label="Reserve Drift" value={String(data.reserveDrift?.length ?? 0)} />
          <SummaryBadge label="Class Warnings" value={String(data.classificationWarnings?.length ?? 0)} />
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {PIPELINE_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "pharos-focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/60 bg-background/55 text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "quality" ? (
        <div className="rounded-xl border border-border/60 bg-background/35 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-base font-semibold tracking-tight text-foreground">Quality threshold board</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Critical data-quality blockers sort first so the noisiest metrics do not hide the real breakpoints.
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                getStatusTone(data.dataQualityStatus).badgeClassName,
              )}
            >
              {getStatusTone(data.dataQualityStatus).label}
            </span>
          </div>
          <div className="mt-4">
            <DataQualityCards dq={{ ...data.dataQuality, nowSeconds: data.timestamp }} />
          </div>
        </div>
      ) : null}

      {activeTab === "markets" ? (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-2">
            <PriceSourceHealthCard
              health={data.priceSourceHealth}
              error={data.sectionErrors.priceSourceHealth}
              nowSeconds={data.timestamp}
            />
            <LiquidityHealthCard health={data.liquidityHealth} error={data.sectionErrors.liquidityHealth} />
          </div>
          <CoinGeckoPriceDiffCard
            summary={data.coingeckoPriceDiff}
            error={data.sectionErrors.coingeckoPriceDiff}
            nowSeconds={data.timestamp}
          />
        </div>
      ) : null}

      {activeTab === "reserves" ? (
        <div className="space-y-5">
          <ScoreImpactPanel
            reserveComposition={data.reserveComposition}
            reserveDrift={data.reserveDrift}
            classificationWarnings={data.classificationWarnings}
          />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <ReserveSyncHealthCard health={data.reserveComposition} nowSeconds={data.timestamp} />
            <div className="space-y-5">
              <MintBurnReconciliationCard
                summary={data.mintBurnReconciliation}
                error={data.sectionErrors.mintBurnReconciliation}
              />
              <MetadataIntegrityCard
                reserveDrift={data.reserveDrift}
                classificationWarnings={data.classificationWarnings}
                reserveDriftError={data.sectionErrors.reserveDrift}
                classificationWarningsError={data.sectionErrors.classificationWarnings}
              />
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "yield" ? (
        <YieldHealthCard health={data.yieldHealth} error={data.sectionErrors.yieldHealth} />
      ) : null}

      {activeTab === "storage" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]">
          <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />
          <D1UsageCard summary={data.d1Usage} error={data.sectionErrors.d1Usage} nowSeconds={data.timestamp} />
        </div>
      ) : null}

      {activeTab === "discovery" ? (
        <DiscoveryCandidatesCard
          candidates={data.discoveryCandidates}
          error={data.sectionErrors.discoveryCandidates}
          nowSeconds={data.timestamp}
          onDismissed={handleRefresh}
        />
      ) : null}
    </StatusSection>
  );
}
