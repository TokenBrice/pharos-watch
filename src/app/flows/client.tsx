"use client";

import Link from "next/link";
import { useState } from "react";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
import { FlowBrrrOverview } from "@/components/flow-brrr-overview";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { cn } from "@/lib/utils";
import type { FaqItem } from "@/lib/faq";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const TIME_RANGES = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
] as const;

const FLOWS_SHELL_PROPS = {
  breadcrumbName: "Mint/Burn Flows",
  path: "/flows/",
  title: "Mint/Burn Flows",
  methodology: {
    version: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  leadParagraphs: [
    "Minting and redemption flows on each tracked stablecoin's configured issuance chain.",
  ],
} as const;

function FlowsHeaderSupplement({ syncWarning }: { syncWarning: string | null }) {
  return (
    <div className="space-y-3">
      <p className="pharos-lead hidden sm:block">
        Net flow tells you whether tokens are being minted or burned right now. Pressure Shift vs 30D tells you
        whether today&apos;s activity is stronger or weaker than each coin&apos;s recent norm, and the Bank Run Gauge
        aggregates that baseline-relative pressure across tracked issuance and redemption activity.
      </p>
      {syncWarning ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {syncWarning}
        </div>
      ) : null}
    </div>
  );
}

export default function FlowsClient({ faqItems }: { faqItems: readonly FaqItem[] }) {
  const [hours, setHours] = useState(720);
  const {
    data: summaryData,
    meta: summaryMeta,
    isLoading: isSummaryLoading,
    error: summaryError,
    dataUpdatedAt: summaryUpdatedAt,
    refetch: refetchSummary,
  } = useMintBurnFlows(24);
  // When hours === 24 the chart query key matches the summary query (both
  // useMintBurnFlows(24)); reuse summaryData instead of mounting a second hook.
  const isChartFromSummary = hours === 24;
  const {
    data: chartQueryData,
    meta: chartQueryMeta,
    isLoading: isChartQueryLoading,
    error: chartQueryError,
    dataUpdatedAt: chartQueryUpdatedAt,
    refetch: refetchChart,
  } = useMintBurnFlows(hours, { enabled: !isChartFromSummary });
  // When hours === 168 the weekly series is the same query as the chart;
  // derive weeklyHourly from chartData and skip the dedicated weekly query.
  const isWeeklyFromChart = hours === 168;
  const {
    data: weeklyData,
    isLoading: isWeeklyQueryLoading,
    refetch: refetchWeekly,
  } = useMintBurnFlows(168, { enabled: !isWeeklyFromChart });

  const chartData = isChartFromSummary ? summaryData : chartQueryData;
  const chartMeta = isChartFromSummary ? summaryMeta : chartQueryMeta;
  const isChartLoading = isChartFromSummary ? isSummaryLoading : isChartQueryLoading;
  const chartError = isChartFromSummary ? summaryError : chartQueryError;
  const chartUpdatedAt = isChartFromSummary ? summaryUpdatedAt : chartQueryUpdatedAt;
  const isWeeklyLoading = isWeeklyFromChart ? isChartLoading : isWeeklyQueryLoading;

  const gauge = summaryData?.gauge;
  const coins = summaryData?.coins ?? [];
  const hourly = chartData?.hourly ?? [];
  const weeklyHourly = (isWeeklyFromChart ? chartData?.hourly : weeklyData?.hourly) ?? [];
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
      headerSupplement={<FlowsHeaderSupplement syncWarning={syncWarning} />}
    >
      <QueryFreshnessNotices
        error={error}
        hasData={hasData}
        onRetry={() => {
          void refetchSummary();
          if (!isWeeklyFromChart) {
            void refetchWeekly();
          }
          if (!isChartFromSummary) {
            void refetchChart();
          }
        }}
        queries={[
          {
            preset: "mintBurnFlows",
            dataUpdatedAt: summaryUpdatedAt,
            error: summaryError,
            hasData: !!summaryData,
            meta: summaryMeta,
          },
          ...(!isChartFromSummary
            ? [
                {
                  label: "Mint/Burn Flows (Chart)",
                  dataUpdatedAt: chartUpdatedAt,
                  error: chartError,
                  hasData: !!chartData,
                  meta: chartMeta,
                },
              ]
            : []),
        ]}
        showFreshnessBanner={showDataHealthBanner}
      />

      <div className="flex flex-col gap-6">
        <section aria-label="Mint/burn overview" className="order-1">
          <FlowBrrrOverview
            gauge={gauge ?? null}
            coins={coins}
            weeklyHourly={weeklyHourly}
            isLoading={isSummaryLoading || (hours !== 168 && isWeeklyLoading)}
            scopeLabel={scopeLabel}
            syncWarning={syncWarning}
          />
        </section>

        <section id="data" tabIndex={-1} aria-label="Per-coin flows" className="order-3 md:order-2">
          <FlowTable coins={coins} isLoading={isSummaryLoading} />
        </section>

        <section aria-labelledby="chart-heading" className="order-2 md:order-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="chart-heading" className="pharos-kicker">
              Aggregate Flows
            </h2>
            <div className="flex gap-1" role="group" aria-label="Time range">
              {TIME_RANGES.map((range) => {
                const isActive = hours === range.hours;
                return (
                  <button
                    type="button"
                    key={range.value}
                    onClick={() => setHours(range.hours)}
                    aria-pressed={isActive}
                    className={cn(
                      "pharos-focus-ring pharos-control-pill min-h-11 px-3.5 md:min-h-9",
                      isActive && "pharos-control-pill-active",
                    )}
                  >
                    {range.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-3 pharos-chart-stage">
            <FlowChart hourly={hourly} isLoading={isChartLoading} />
          </div>
        </section>

        <section className="order-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="pharos-card-shell px-4 py-4">
            <p className="pharos-kicker">Flow Interpretation</p>
            <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>
                Mint and burn totals are useful, but the pressure shift is the stress signal: it asks whether the
                current flow is unusual for that coin, not just whether mints outnumber burns today.
              </p>
              <p>
                Read sharp burn pressure alongside depeg alerts, DEX liquidity, and redemption-backstop coverage before
                treating it as a standalone bank-run signal.
              </p>
            </div>
          </div>
          <FaqSection items={faqItems} title="Mint/Burn Flow FAQ" includeJsonLd />
        </section>

        <div className="order-5 flex justify-end">
          <Link
            href="/timeline/?type=mint_burn.*"
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground"
          >
            See all mint/burn events on the Timeline →
          </Link>
        </div>
      </div>
    </FeaturePageShell>
  );
}
