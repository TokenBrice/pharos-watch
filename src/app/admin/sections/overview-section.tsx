import type { StatusResponse } from "@shared/types";
import { StatusFacts } from "@/components/status/status-facts";
import { SystemDiagnostics } from "@/components/status/system-diagnostics";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { getStatusTone } from "@/lib/status-dashboard-model";

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
}

export function OverviewSection({
  data,
  handleRefresh,
  overallTone,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  browserProbeSummary,
}: OverviewSectionProps) {
  return (
    <StatusSection
      id="overview"
      kicker="Command Center"
      title="Current incident picture"
      description="Start here for the state holding, the active blockers, and the short path into deeper diagnostics."
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
        <div className="mt-4">
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
