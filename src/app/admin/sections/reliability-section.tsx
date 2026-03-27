import type { EndpointProbeResult, HealthResponse, StatusResponse } from "@shared/types";
import { CacheFreshnessTable } from "@/components/status/cache-freshness-table";
import { CircuitBreakerTable } from "@/components/status/circuit-breaker-table";
import { EndpointHealthGrid } from "@/components/status/endpoint-health-grid";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { getStatusTone } from "@/lib/status-dashboard-model";

export interface ReliabilitySectionProps {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  browserProbeSummary: {
    sampleCount: number;
    passCount: number;
    failCount: number;
    status: "healthy" | "degraded" | "stale";
  } | null;
  isReliabilityOpen: boolean;
  setIsReliabilityOpen: (open: boolean) => void;
  probes: EndpointProbeResult[] | undefined;
  probesLoading: boolean;
}

export function ReliabilitySection({
  data,
  healthData,
  browserProbeSummary,
  isReliabilityOpen,
  setIsReliabilityOpen,
  probes,
  probesLoading,
}: ReliabilitySectionProps) {
  return (
    <StatusSection
      id="reliability"
      kicker="Service Health"
      title="Probes, breakers, and cache pressure"
      description="Use this lane when the issue looks like routing, availability, or public-service degradation."
      accentClassName="border-l-amber-500"
      summary={
        <>
          <SummaryBadge
            label="Public Health"
            value={healthData?.status ?? "—"}
            className={healthData ? getStatusTone(healthData.status).badgeClassName : undefined}
          />
          <SummaryBadge
            label="Browser Probes"
            value={browserProbeSummary ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount}` : "—"}
          />
          <SummaryBadge label="Worst Cache" value={`${data.summary.worstCacheRatio.toFixed(2)}x`} />
        </>
      }
    >
      <details
        open={isReliabilityOpen}
        onToggle={(event) => setIsReliabilityOpen(event.currentTarget.open)}
        className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
      >
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Endpoint probes, circuit breakers, and cache freshness
        </summary>
        <div className="mt-4 space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <EndpointHealthGrid probes={probes} isLoading={probesLoading} />
            <CircuitBreakerTable circuits={healthData?.circuits} />
          </div>
          <CacheFreshnessTable caches={data.caches} />
        </div>
      </details>
    </StatusSection>
  );
}
