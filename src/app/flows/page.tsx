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
} from "@/lib/mint-burn-flow-version";

const TIME_RANGES = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
] as const;

function FlowsPageInner() {
  const [hours, setHours] = useState(720);
  const {
    data: summaryData,
    isLoading: isSummaryLoading,
    error: summaryError,
    dataUpdatedAt: summaryUpdatedAt,
    refetch: refetchSummary,
  } = useMintBurnFlows(24);
  const {
    data: chartData,
    isLoading: isChartLoading,
    error: chartError,
    dataUpdatedAt: chartUpdatedAt,
    refetch: refetchChart,
  } = useMintBurnFlows(hours);

  const gauge = summaryData?.gauge;
  const coins = summaryData?.coins ?? [];
  const hourly = chartData?.hourly ?? [];
  const error = summaryError ?? chartError;
  const hasData = !!summaryData || !!chartData;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">Mint/Burn Flows</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">
          Mint/Burn Flows
          <FeatureStatusBadge
            status="experimental"
            version={MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}
          />
        </h1>
        <p className="text-xs text-muted-foreground">
          Methodology {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.{" "}
          <Link
            href={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH}
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            Version history &rarr;
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          Real-time minting and redemption flows for tracked stablecoins.
        </p>
        <p className="text-sm text-muted-foreground">
          When more stablecoins are being burned than minted, it signals
          redemption pressure &mdash; a potential early warning for bank-run
          dynamics. The Bank Run Gauge aggregates this activity into a single
          score, while the per-coin table and flow chart let you drill into
          individual assets.
        </p>
      </div>

      {/* Error / stale banner */}
      <QueryErrorNotice
        error={error}
        hasData={hasData}
        onRetry={() => {
          void refetchSummary();
          if (hours !== 24) {
            void refetchChart();
          }
        }}
      />
      <StaleDataBanner
        queries={[
          {
            preset: "mintBurnFlows",
            dataUpdatedAt: summaryUpdatedAt,
            error: summaryError,
            hasData: !!summaryData,
          },
          ...(hours !== 24
            ? [{
              label: "Mint/Burn Flows (Chart)",
              dataUpdatedAt: chartUpdatedAt,
              error: chartError,
              hasData: !!chartData,
            }]
            : []),
        ]}
      />

      {/* Section 1: Experimental meme-style overview */}
      <section aria-label="BRRRR overview">
        <FlowBrrrOverview
          gauge={gauge ?? null}
          coins={coins}
          isLoading={isSummaryLoading}
        />
      </section>

      {/* Section 2: Per-coin flow table */}
      <section aria-labelledby="table-heading">
        <h2 id="table-heading" className="text-lg font-semibold tracking-tight">
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
            className="text-lg font-semibold tracking-tight"
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
