"use client";

import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import type { EndpointProbeResult, HealthResponse } from "@shared/types";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { StatusSection, StatusSummaryBadge } from "@/components/status/page-primitives";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";

interface PublicStatusReliabilitySectionProps {
  healthData: HealthResponse;
  probes: EndpointProbeResult[] | undefined;
  probesLoading: boolean;
  probeSummary: BrowserProbeSummary | null;
}

export function PublicStatusReliabilitySection({
  healthData,
  probes,
  probesLoading,
  probeSummary,
}: PublicStatusReliabilitySectionProps) {
  const publicImpactCircuits = Object.fromEntries(
    Object.entries(healthData.circuits).filter(([key]) => isPublicImpactCircuitKey(key)),
  );
  const openCircuits = Object.values(publicImpactCircuits).filter((circuit) => circuit.state === "open").length;
  const halfOpenCircuits = Object.values(publicImpactCircuits).filter((circuit) => circuit.state === "half-open").length;

  return (
    <StatusSection
      id="reliability"
      title="Route probes, breakers, and cache pressure"
      accentClassName="border-l-amber-500 bg-[linear-gradient(180deg,oklch(0.99_0.006_80_/_0.98),oklch(0.968_0.012_80_/_0.98)_46%,oklch(0.952_0.014_248_/_0.99))] shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:bg-[linear-gradient(180deg,rgba(24,18,10,0.42),rgba(7,10,18,0.94))] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)]"
      summary={
        <>
          {probeSummary && probeSummary.failCount > 0 && (
            <StatusSummaryBadge
              label="Probe Failures"
              value={`${probeSummary.failCount}/${probeSummary.sampleCount}`}
              status="degraded"
            />
          )}
          {openCircuits > 0 && (
            <StatusSummaryBadge label="Open Breakers" value={String(openCircuits)} status="stale" />
          )}
          {halfOpenCircuits > 0 && (
            <StatusSummaryBadge label="Half-open" value={String(halfOpenCircuits)} status="degraded" />
          )}
        </>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <EndpointHealthGrid
          probes={probes}
          isLoading={probesLoading}
          groups={["public"]}
          description="Browser-origin probe loop from this public session. It covers public canary routes; freshness Warning headers are treated as data-health signals."
          footnote="Admin and manual action paths are intentionally excluded from the public probe board."
        />
        <CircuitBreakerTable circuits={publicImpactCircuits} />
      </div>
      <CacheFreshnessTable caches={healthData.caches} />
    </StatusSection>
  );
}
