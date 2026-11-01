"use client";

import Link from "next/link";
import { useState } from "react";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import type { StaleQuery } from "@/components/stale-data-banner";
import { useHydrated } from "@/hooks/use-hydrated";
import { deriveDataHealth, type DataHealthInfo } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
import { FlowGaugeHero } from "@/components/flow-gauge-hero";
import { FlowWeekReceipt } from "@/components/flow-week-receipt";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { ShareButton } from "@/components/share-button";
import { ModuleDisclosure, MODULE_FOLD_RHYTHM_CLASS } from "@/components/stablecoin-detail/module-disclosure";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import type { FaqItem } from "@/lib/faq";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const TIME_RANGES: { value: number; label: string }[] = [
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
];

const SYNC_CADENCE_MIN = Math.round(CRON_INTERVALS["sync-mint-burn"] / 60);

const FLOWS_SHELL_PROPS = {
  breadcrumbName: "Mint/Burn Flows",
  path: "/flows/",
  title: "Mint/Burn Flows",
  methodology: {
    version: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  },
  header: "instrument",
  headerActions: <ShareButton ogPath={API_PATHS.ogPage("flows")} />,
  leadParagraphs: [
    "Minting and redemption on each issuance chain, against its own 30-day norm.",
    "Net flow says whether tokens are being minted or burned right now. Pressure vs the 30-day norm says whether today's activity is stronger or weaker than each coin's recent pace, and the Bank Run Gauge weights that pressure by each coin's tracked supply.",
  ],
  leadDisclosureLabel: "How flows are measured",
} as const;

/**
 * The worst degraded or stale reading among queries that served data, judged
 * the same way the shared banner judges it (`deriveDataHealth` with the
 * endpoint preset). Before hydration the saved generation is the clock, as in
 * `StaleDataBanner`, so the server and first client render agree.
 */
function worstServedDataHealth(queries: readonly StaleQuery[], hydrated: boolean): DataHealthInfo | null {
  let worst: DataHealthInfo | null = null;
  for (const query of queries) {
    if (!(query.hasData ?? query.dataUpdatedAt > 0)) continue;
    const preset = query.preset ? DATA_HEALTH_PRESETS[query.preset] : null;
    const info = deriveDataHealth(
      {
        label: query.label ?? preset?.label ?? "Mint/Burn Flows",
        dataUpdatedAt: query.dataUpdatedAt,
        staleTime: query.staleTime ?? preset?.staleTime ?? DATA_HEALTH_PRESETS.mintBurnFlows.staleTime,
        hasData: true,
        error: query.error,
        meta: query.meta ?? null,
      },
      hydrated ? undefined : query.dataUpdatedAt,
    );
    if (info.state !== "degraded" && info.state !== "stale") continue;
    if (!worst || (worst.state === "degraded" && info.state === "stale")) worst = info;
  }
  return worst;
}

export default function FlowsClient({ faqItems }: { faqItems: readonly FaqItem[] }) {
  const hydrated = useHydrated();
  // The overview already needs the authoritative weekly window. Start the chart
  // there too; the 30-day variant is fetched only when the reader selects it.
  const [hours, setHours] = useState(168);
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
    meta: weeklyMeta,
    isLoading: isWeeklyQueryLoading,
    error: weeklyError,
    dataUpdatedAt: weeklyUpdatedAt,
    refetch: refetchWeekly,
  } = useMintBurnFlows(168, { enabled: !isWeeklyFromChart });

  const chartData = isChartFromSummary ? summaryData : chartQueryData;
  const chartMeta = isChartFromSummary ? summaryMeta : chartQueryMeta;
  const isChartLoading = isChartFromSummary ? isSummaryLoading : isChartQueryLoading;
  const chartError = isChartFromSummary ? summaryError : chartQueryError;
  const chartUpdatedAt = isChartFromSummary ? summaryUpdatedAt : chartQueryUpdatedAt;
  const isWeeklyLoading = isWeeklyFromChart ? isChartLoading : isWeeklyQueryLoading;

  const gauge = summaryData?.gauge ?? null;
  const coins = summaryData?.coins ?? [];
  const hourly = chartData?.hourly ?? [];
  const weeklyHourly = (isWeeklyFromChart ? chartData?.hourly : weeklyData?.hourly) ?? [];
  const error = summaryError ?? chartError ?? (!isWeeklyFromChart ? weeklyError : null);
  const hasData = !!summaryData || !!chartData;
  const scopeLabel = summaryData?.scope?.label ?? "Configured issuance chains";
  const sync = summaryData?.sync ?? chartData?.sync ?? null;
  const freshnessQueries: StaleQuery[] = [
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
    ...(!isWeeklyFromChart
      ? [
          {
            label: "Mint/Burn Flows (Weekly)",
            dataUpdatedAt: weeklyUpdatedAt,
            error: weeklyError,
            hasData: !!weeklyData,
            meta: weeklyMeta,
          },
        ]
      : []),
  ];
  // Ops state with data in hand is a hero chip, never a body callout: the banner
  // stays only for the no-data case (hard errors keep their own notice).
  const showDataHealthBanner = !hasData;
  const dataHealth = worstServedDataHealth(freshnessQueries, hydrated);

  return (
    <FeaturePageShell {...FLOWS_SHELL_PROPS}>
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
        queries={freshnessQueries}
        showFreshnessBanner={showDataHealthBanner}
      />

      {summaryData == null && !isSummaryLoading ? (
        // The 24h aggregate owns the hero and the table: a missing payload is a
        // failed read, never a zero-coin pass. The page-level notice reports it
        // when nothing else loaded; with the chart in hand that notice is silent,
        // so the failed 24h read is reported where its modules would have rendered.
        chartData ? <QueryErrorNotice error={summaryError} onRetry={() => void refetchSummary()} /> : null
      ) : (
        <>
          <FlowGaugeHero
            gauge={gauge}
            coins={coins}
            sync={sync}
            window={summaryData?.window}
            dataHealth={dataHealth}
            isLoading={isSummaryLoading}
          />

          <section id="data" tabIndex={-1} aria-label="Per-coin flows">
            <FlowTable coins={coins} isLoading={isSummaryLoading} />
          </section>
        </>
      )}

      <section aria-labelledby="chart-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="chart-heading" className="pharos-label">
            Aggregate flows
          </h2>
          <ControlPillToggle
            className="flex gap-1"
            ariaLabel="Time range"
            options={TIME_RANGES}
            value={hours}
            onChange={setHours}
            buttonClassName="min-h-11 px-3.5 md:min-h-9"
          />
        </div>
        <div className="mt-3 pharos-chart-stage">
          <FlowChart hourly={hourly} isLoading={isChartLoading} publishedWindow={chartData?.window} />
        </div>
      </section>

      <div className={MODULE_FOLD_RHYTHM_CLASS}>
        <ModuleDisclosure label="7-day receipt">
          <FlowWeekReceipt
            coins={coins}
            weeklyHourly={weeklyHourly}
            scopeLabel={scopeLabel}
            isLoading={isSummaryLoading || isWeeklyLoading}
          />
        </ModuleDisclosure>
        <ModuleDisclosure label="How to read flows">
          <div className="space-y-4">
            <div className="max-w-prose space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>
                Mint and burn totals are useful, but the pressure shift is the stress signal: it asks whether the
                current flow is unusual for that coin, not just whether mints outnumber burns today.
              </p>
              <p>
                Read sharp burn pressure alongside depeg alerts, DEX liquidity, and redemption-backstop coverage before
                treating it as a standalone bank-run signal.
              </p>
            </div>
            <FaqSection items={faqItems} title="Mint/burn flow FAQ" includeJsonLd />
          </div>
        </ModuleDisclosure>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/50 pt-4 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Source: on-chain mint and burn events, {scopeLabel.toLowerCase()}</span>
          <span aria-hidden="true">·</span>
          <span>Critical-lane sync every {SYNC_CADENCE_MIN} min</span>
          {sync?.lastSuccessfulSyncAt != null ? (
            <FreshnessIndicator
              compact
              updatedAtMs={sync.lastSuccessfulSyncAt * 1000}
              staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * 1000}
              labelPrefix="Critical-lane sync"
            />
          ) : null}
        </div>
        <Link href="/timeline/?type=mint_burn.*" className="pharos-focus-ring hover:text-foreground">
          See all mint/burn events on the Timeline →
        </Link>
      </footer>
    </FeaturePageShell>
  );
}
