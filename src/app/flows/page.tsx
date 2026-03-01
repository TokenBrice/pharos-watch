"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_20MIN } from "@/hooks/use-api-query";
import { FlowGauge } from "@/components/flow-gauge";
import { FlowChart } from "@/components/flow-chart";
import { FlowTable } from "@/components/flow-table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const TIME_RANGES = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
] as const;

function FlowsPageInner() {
  const [hours, setHours] = useState(24);
  const { data, isLoading, isError, error, dataUpdatedAt } =
    useMintBurnFlows(undefined, hours);

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
        <h1 className="text-4xl font-extrabold tracking-tighter">
          Mint/Burn Flows
        </h1>
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

      {/* New feature notice */}
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-200">
        This is a new feature, data collection work is in progress: please be
        patient.
      </div>

      {/* Error / stale banner */}
      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Signal lost. {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}
      {!isError && (
        <StaleDataBanner
          queries={[
            { label: "Mint/Burn Flows", dataUpdatedAt, staleTime: CRON_20MIN },
          ]}
        />
      )}

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
    <Suspense>
      <FlowsPageInner />
    </Suspense>
  );
}
