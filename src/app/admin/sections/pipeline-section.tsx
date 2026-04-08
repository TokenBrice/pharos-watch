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
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { getStatusTone } from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

export interface PipelineSectionProps {
  data: StatusResponse;
  handleRefresh: () => void;
}

export function PipelineSection({ data, handleRefresh }: PipelineSectionProps) {
  return (
    <StatusSection
      id="pipeline"
      kicker="Data Pipeline"
      title="Freshness and coverage"
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
          <SummaryBadge label="Stale On-chain" value={String(data.dataQuality.staleOnchainSupply)} />
          <SummaryBadge label="Reserve Drift" value={String(data.reserveDrift?.length ?? 0)} />
          <SummaryBadge label="Class Warnings" value={String(data.classificationWarnings?.length ?? 0)} />
        </>
      }
    >
      <div className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4">
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

      <div className="grid gap-5 xl:grid-cols-2">
        <PriceSourceHealthCard
          health={data.priceSourceHealth}
          error={data.sectionErrors.priceSourceHealth}
          nowSeconds={data.timestamp}
        />
        <LiquidityHealthCard
          health={data.liquidityHealth}
          error={data.sectionErrors.liquidityHealth}
        />
      </div>

      <CoinGeckoPriceDiffCard
        summary={data.coingeckoPriceDiff}
        error={data.sectionErrors.coingeckoPriceDiff}
        nowSeconds={data.timestamp}
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />
        <ReserveSyncHealthCard health={data.reserveComposition} nowSeconds={data.timestamp} />
        <D1UsageCard
          summary={data.d1Usage}
          error={data.sectionErrors.d1Usage}
          nowSeconds={data.timestamp}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
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

      <DiscoveryCandidatesCard
        candidates={data.discoveryCandidates}
        error={data.sectionErrors.discoveryCandidates}
        nowSeconds={data.timestamp}
        onDismissed={handleRefresh}
      />
    </StatusSection>
  );
}
