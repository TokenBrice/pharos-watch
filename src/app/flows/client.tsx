"use client";

import { useState } from "react";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { FlowPressureReceipt } from "@/components/flow-pressure-receipt";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";

const TIME_RANGES = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
] as const;

const FLOWS_SHELL_PROPS = {
  breadcrumbName: "Mint/Burn Flows",
  path: "/flows/",
  title: "Mint/Burn Flows",
  statusBadge: {
    status: "mature" as const,
    version: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  },
  methodology: {
    version: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  leadParagraphs: [
    "Minting and redemption flows on each tracked stablecoin's configured issuance chain.",
    "Net flow tells you whether tokens are being minted or burned right now. Pressure Shift vs 30D tells you whether today's activity is stronger or weaker than each coin's recent norm, and the Bank Run Gauge aggregates that baseline-relative pressure across tracked issuance and redemption activity.",
  ],
} as const;

function FlowsHeaderSupplement({
  scopeLabel,
  syncWarning,
}: {
  scopeLabel: string;
  syncWarning: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
          {scopeLabel}
        </span>
      </div>
      {syncWarning ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {syncWarning}
        </div>
      ) : null}
    </div>
  );
}

export default function FlowsClient() {
  const [hours, setHours] = useState(720);
  const {
    data: summaryData,
    meta: summaryMeta,
    isLoading: isSummaryLoading,
    error: summaryError,
    dataUpdatedAt: summaryUpdatedAt,
    refetch: refetchSummary,
  } = useMintBurnFlows(24);
  const {
    data: chartData,
    meta: chartMeta,
    isLoading: isChartLoading,
    error: chartError,
    dataUpdatedAt: chartUpdatedAt,
    refetch: refetchChart,
  } = useMintBurnFlows(hours);
  const {
    data: weeklyData,
    isLoading: isWeeklyLoading,
    refetch: refetchWeekly,
  } = useMintBurnFlows(168);

  const gauge = summaryData?.gauge;
  const coins = summaryData?.coins ?? [];
  const hourly = chartData?.hourly ?? [];
  const weeklyHourly = (hours === 168 ? chartData?.hourly : weeklyData?.hourly) ?? [];
  const error = summaryError ?? chartError;
  const hasData = !!summaryData || !!chartData;
  const scopeLabel = summaryData?.scope?.label ?? "Configured issuance chains";
  const syncWarning = summaryData?.sync?.warning ?? chartData?.sync?.warning ?? null;
  // When a sync warning is active, suppress the generic stale-data banner to
  // avoid stacking two banners. The sync warning already conveys pipeline lag.
  const showDataHealthBanner = !syncWarning;

  return (
    <FeaturePageShell
      {...FLOWS_SHELL_PROPS}
      headerSupplement={<FlowsHeaderSupplement scopeLabel={scopeLabel} syncWarning={syncWarning} />}
    >
      <QueryErrorNotice
        error={error}
        hasData={hasData}
        onRetry={() => {
          void refetchSummary();
          void refetchWeekly();
          if (hours !== 24) {
            void refetchChart();
          }
        }}
      />
      {showDataHealthBanner ? (
        <StaleDataBanner
          queries={[
            {
              preset: "mintBurnFlows",
              dataUpdatedAt: summaryUpdatedAt,
              error: summaryError,
              hasData: !!summaryData,
              meta: summaryMeta,
            },
            ...(hours !== 24
              ? [{
                  label: "Mint/Burn Flows (Chart)",
                  dataUpdatedAt: chartUpdatedAt,
                  error: chartError,
                  hasData: !!chartData,
                  meta: chartMeta,
                }]
              : []),
          ]}
        />
      ) : null}

      <section aria-label="Mint/burn overview">
        <FlowBrrrOverview
          gauge={gauge ?? null}
          coins={coins}
          weeklyHourly={weeklyHourly}
          isLoading={isSummaryLoading || (hours !== 168 && isWeeklyLoading)}
        />
        {!isSummaryLoading ? (
          <FlowPressureReceipt
            gauge={gauge ?? null}
            coins={coins}
            weeklyHourly={weeklyHourly}
            scopeLabel={scopeLabel}
            syncWarning={syncWarning}
          />
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Coverage badges flag coins that are still bootstrapping, lagging, or
          missing enough history for full long-window comparisons. Values marked
          partial reflect only the covered history window.
        </p>
      </section>

      <section aria-labelledby="table-heading">
        <h2 id="table-heading" className="pharos-kicker">
          Per-Coin Flows
        </h2>
        <div className="mt-3">
          <FlowTable coins={coins} isLoading={isSummaryLoading} />
        </div>
      </section>

      <section aria-labelledby="chart-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="chart-heading"
            className="pharos-kicker"
          >
            Aggregate Flows
          </h2>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(hours)}
            onValueChange={(value) => {
              if (value) setHours(Number(value));
            }}
            aria-label="Time range"
          >
            {TIME_RANGES.map((range) => (
              <ToggleGroupItem key={range.value} value={range.value}>
                {range.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="mt-3">
          <FlowChart hourly={hourly} isLoading={isChartLoading} />
        </div>
      </section>
    </FeaturePageShell>
  );
}
