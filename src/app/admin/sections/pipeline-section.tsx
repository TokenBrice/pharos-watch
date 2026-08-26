"use client";

import { useMemo } from "react";
import type { StatusResponse } from "@shared/types";
import { CoinGeckoPriceDiffCard } from "@/components/status/coingecko-price-diff";
import { DatasetFreshnessTable } from "@/components/status/dataset-freshness-table";
import { D1UsageCard } from "@/components/status/d1-usage-card";
import { LiquidityHealthCard } from "@/components/status/liquidity-health";
import { MetadataIntegrityCard } from "@/components/status/metadata-integrity-card";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";
import { PipelineIntegrityPanel } from "@/components/status/pipeline-integrity-panel";
import { PipelineLoaderSummary } from "@/components/status/pipeline-loader-summary";
import { PipelineQualityTable } from "@/components/status/pipeline-quality-table";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";
import { ReserveSyncHealthCard } from "@/components/status/reserve-sync-health";
import { ScoreImpactPanel } from "@/components/status/score-impact-panel";
import { SummaryBadge } from "@/components/status/page-primitives";
import { YieldHealthCard } from "@/components/status/yield-health";
import { createWorkspaceModeIds, WorkspaceModeTabs } from "@/components/status/workspace-mode-tabs";
import { useWorkspaceMode } from "@/hooks/use-workspace-mode";
import {
  buildPipelineIntegrityModel,
  buildPipelineModeSummaries,
  buildPipelineQualityModel,
  collectPipelineLoaderErrors,
  deriveInitialPipelineMode,
  PIPELINE_MODES,
} from "@/lib/pipeline-workspace-model";
import { getStatusTone } from "@/lib/status-dashboard-model";

export interface PipelineSectionProps {
  data: StatusResponse;
}

const PIPELINE_MODE_IDS = createWorkspaceModeIds("pipeline");

export function PipelineSection({ data }: PipelineSectionProps) {
  const defaultMode = useMemo(() => deriveInitialPipelineMode(data), [data]);
  const { activeMode, selectMode } = useWorkspaceMode({ modes: PIPELINE_MODES, defaultMode });
  const modeSummaries = useMemo(() => buildPipelineModeSummaries(data), [data]);
  const loaderErrors = useMemo(() => collectPipelineLoaderErrors(data), [data]);
  const qualityModel = useMemo(() => buildPipelineQualityModel(data), [data]);
  const integrityModel = useMemo(() => buildPipelineIntegrityModel(data), [data]);

  const renderActiveMode = () => {
    switch (activeMode) {
      case "quality":
        return <PipelineQualityTable model={qualityModel} />;
      case "markets":
        return (
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
        );
      case "reserves":
        return (
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
        );
      case "yield":
        return <YieldHealthCard health={data.yieldHealth} error={data.sectionErrors.yieldHealth} />;
      case "storage":
        return (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]">
            <DatasetFreshnessTable datasetFreshness={data.datasetFreshness} nowSeconds={data.timestamp} />
            <D1UsageCard summary={data.d1Usage} error={data.sectionErrors.d1Usage} nowSeconds={data.timestamp} />
          </div>
        );
      case "integrity":
        return <PipelineIntegrityPanel model={integrityModel} />;
    }
  };

  const qualityTone = getStatusTone(data.dataQualityStatus);

  return (
    <section
      id="pipeline"
      aria-labelledby="pipeline-title"
      className="min-w-0 max-w-full space-y-5 scroll-mt-[var(--ops-sticky-offset)]"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Data Pipeline</p>
          <h1 id="pipeline-title" className="text-2xl font-bold leading-tight text-foreground">
            Pipeline Health
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Thresholds, publication integrity, and source coverage organized by operator workflow.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <SummaryBadge label="Data quality" value={qualityTone.label} className={qualityTone.badgeClassName} />
          <SummaryBadge label="Loader issues" value={String(loaderErrors.length)} />
          <SummaryBadge
            label="Selected view"
            value={modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Quality"}
          />
        </div>
      </div>

      <PipelineLoaderSummary errors={loaderErrors} />
      <WorkspaceModeTabs
        activeMode={activeMode}
        modes={modeSummaries}
        onModeChange={selectMode}
        ariaLabel="Pipeline views"
        className="w-full"
        tabClassName="min-w-[6.5rem]"
        {...PIPELINE_MODE_IDS}
      />
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        Pipeline view: {modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Quality"}
      </p>

      <div
        id={PIPELINE_MODE_IDS.getPanelId(activeMode)}
        role="tabpanel"
        aria-labelledby={PIPELINE_MODE_IDS.getTabId(activeMode)}
        tabIndex={0}
        className="min-w-0"
      >
        <h2 className="sr-only">
          {modeSummaries.find((mode) => mode.id === activeMode)?.label ?? "Quality"} pipeline view
        </h2>
        {renderActiveMode()}
      </div>
    </section>
  );
}
