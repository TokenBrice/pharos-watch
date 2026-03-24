"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FeatureStatusBadge } from "@/components/feature-status-badge";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";

const TIME_RANGES = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
] as const;

function FlowsPageInner() {
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
  const scopeLabel = summaryData?.scope?.label ?? "Ethereum-only";
  const syncWarning = summaryData?.sync?.warning ?? chartData?.sync?.warning ?? null;
  const showDataHealthBanner = !syncWarning;

  return (
    <div className="space-y-6 border-t-[3px] border-t-teal-500 pt-5">
      {/* Header */}
      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="pharos-focus-ring hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">Mint/Burn Flows</span>
        </nav>
        <div className="flex max-w-full flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-4xl font-extrabold tracking-tighter">
            Mint/Burn Flows
          </h1>
          <FeatureStatusBadge
            status="mature"
            version={MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}
          />
          <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
            {scopeLabel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Methodology {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.{" "}
          <Link
            href={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH}
            className="pharos-focus-ring underline underline-offset-4 hover:text-foreground transition-colors"
          >
            Version history &rarr;
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          Ethereum minting and redemption flows for tracked stablecoins.
        </p>
        <p className="text-sm text-muted-foreground">
          Net flow tells you whether tokens are being minted or burned right
          now. Pressure Shift vs 30D tells you whether today&apos;s activity is
          stronger or weaker than each coin&apos;s recent norm, and the Bank Run
          Gauge aggregates that baseline-relative pressure across tracked
          Ethereum issuance and redemption activity.
        </p>
        {syncWarning && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            {syncWarning}
          </div>
        )}
      </div>

      {/* Error / stale banner */}
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
      {showDataHealthBanner && (
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
      )}

      <section aria-label="Mint/burn overview">
        <FlowBrrrOverview
          gauge={gauge ?? null}
          coins={coins}
          weeklyHourly={weeklyHourly}
          isLoading={isSummaryLoading || (hours !== 168 && isWeeklyLoading)}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Coverage badges flag coins that are still bootstrapping, lagging, or
          missing enough history for full long-window comparisons. Values marked
          partial reflect only the covered history window.
        </p>
      </section>

      {/* Section 2: Per-coin flow table */}
      <section aria-labelledby="table-heading">
        <h2 id="table-heading" className="pharos-kicker">
          Per-Coin Flows
        </h2>
        <div className="mt-3">
          <FlowTable coins={coins} isLoading={isSummaryLoading} />
        </div>
      </section>

      {/* Section 3: Aggregate flow chart with time range toggle */}
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
            onValueChange={(v) => {
              if (v) setHours(Number(v));
            }}
            aria-label="Time range"
          >
            {TIME_RANGES.map((r) => (
              <ToggleGroupItem key={r.value} value={r.value}>
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="mt-3">
          <FlowChart hourly={hourly} isLoading={isChartLoading} />
        </div>
      </section>

    </div>
  );
}

export default function FlowsPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
      </div>
    }>
      <FlowsPageInner />
    </Suspense>
  );
}
