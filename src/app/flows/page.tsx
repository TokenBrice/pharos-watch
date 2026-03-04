"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FlowGauge } from "@/components/flow-gauge";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
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
  const { data, isLoading, error, dataUpdatedAt, refetch } =
    useMintBurnFlows(hours);

  const gauge = data?.gauge;
  const coins = data?.coins ?? [];
  const hourly = data?.hourly ?? [];

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
            status="testing-in-prod"
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
        hasData={!!data}
        onRetry={() => {
          void refetch();
        }}
      />
      <StaleDataBanner
        queries={[
          { preset: "mintBurnFlows", dataUpdatedAt, error, hasData: !!data },
        ]}
      />

      {/* Section 1: Bank Run Gauge (hero) */}
      <section aria-labelledby="gauge-heading">
        <h2 id="gauge-heading" className="sr-only">
          Bank Run Gauge
        </h2>
        <div className="rounded-xl border bg-card p-6">
          <FlowGauge
            score={gauge?.score ?? null}
            band={gauge?.band ?? null}
            flightToQuality={gauge?.flightToQuality ?? false}
            flightIntensity={gauge?.flightIntensity ?? 0}
            trackedCoins={gauge?.trackedCoins ?? 0}
            isLoading={isLoading}
          />
        </div>
      </section>

      {/* Section 2: Per-coin flow table */}
      <section aria-labelledby="table-heading">
        <h2 id="table-heading" className="text-lg font-semibold tracking-tight">
          Per-Coin Flows
        </h2>
        <div className="mt-3">
          <FlowTable coins={coins} isLoading={isLoading} />
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
          <FlowChart hourly={hourly} isLoading={isLoading} />
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
