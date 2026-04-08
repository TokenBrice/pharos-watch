import type { StatusResponse } from "@shared/types";
import { StatusFacts } from "@/components/status/status-facts";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { type DashboardQuerySync, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";

export interface OverviewSectionProps {
  data: StatusResponse;
  handleRefresh: () => void;
  overallTone: ReturnType<typeof getStatusTone>;
  isDiagnosticsOpen: boolean;
  setIsDiagnosticsOpen: (open: boolean) => void;
  browserProbeSummary: {
    sampleCount: number;
    passCount: number;
    failCount: number;
    degradedCount: number;
    staleCount: number;
    p95LatencyMs: number | null;
    status: "healthy" | "degraded" | "stale";
    updatedAt: number | null;
  } | null;
  querySyncs: DashboardQuerySync[];
  clientDataAgeSec: number;
  clientDataStale: boolean;
}

export function OverviewSection({
  data,
  handleRefresh,
  overallTone,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  browserProbeSummary,
  querySyncs,
  clientDataAgeSec,
  clientDataStale,
}: OverviewSectionProps) {
  const statusSync = querySyncs.find((s) => s.key === "status");
  const healthSync = querySyncs.find((s) => s.key === "health");
  const probeSync = querySyncs.find((s) => s.key === "probes");
  const requestSourceSync = querySyncs.find((s) => s.key === "requestSource");

  return (
    <StatusSection
      id="overview"
      kicker="Command Center"
      title="Current incident picture"
      accentClassName="border-l-frost-blue"
      summary={
        <>
          <SummaryBadge label="Overall" value={overallTone.label} className={overallTone.badgeClassName} />
          <SummaryBadge label="Raw" value={data.rawOverallStatus} />
          <SummaryBadge label="Confidence" value={`${(data.confidence * 100).toFixed(1)}%`} />
        </>
      }
    >
      <StatusFacts
        dbHealthy={data.dbHealthy}
        summary={data.summary}
        causes={data.causes}
        onActionFinished={handleRefresh}
      />
      <details
        open={isDiagnosticsOpen}
        onToggle={(event) => setIsDiagnosticsOpen(event.currentTarget.open)}
        className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
      >
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          State machine, probe, and discrepancy diagnostics
        </summary>
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            <SummaryBadge label="State Eval" value={formatTimestampSeconds(data.state.lastEvaluatedAt)} />
            <SummaryBadge label="Status Payload" value={formatTimestampSeconds(data.timestamp)} />
            <SummaryBadge label="Status Fetch" value={formatTimestampSeconds(statusSync?.updatedAtSec)} />
            <SummaryBadge label="Health Fetch" value={formatTimestampSeconds(healthSync?.updatedAtSec)} />
            <SummaryBadge label="Probe Fetch" value={formatTimestampSeconds(probeSync?.updatedAtSec)} />
            <SummaryBadge label="API Mix Fetch" value={formatTimestampSeconds(requestSourceSync?.updatedAtSec)} />
            <SummaryBadge
              label="Sync Floor"
              value={`${clientDataAgeSec}s`}
              className={clientDataStale ? "border-amber-500/30 bg-amber-500/10" : undefined}
            />
          </div>
          <SystemDiagnostics
            state={data.state}
            staleness={data.staleness}
            probe={data.probe}
            discrepancy={data.discrepancy}
            browserProbe={browserProbeSummary}
            error={data.sectionErrors.statusState}
            nowSeconds={data.timestamp}
          />
        </div>
      </details>
    </StatusSection>
  );
}
