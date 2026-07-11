"use client";

import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/api-hooks";
import { useRequestSourceStats } from "@/hooks/use-request-source-stats";
import { useStatus } from "@/hooks/use-status";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildBrowserProbeSummary } from "@/lib/status-dashboard-model";
import { ReliabilitySection } from "../sections/reliability-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function ReliabilityClient() {
  const statusQuery = useStatus();
  const healthQuery = useHealth();
  const probesQuery = useEndpointProbes({ mode: "full" });
  const requestSourceQuery = useRequestSourceStats();
  const browserProbeSummary = buildBrowserProbeSummary(probesQuery.data, probesQuery.dataUpdatedAt);
  const handleRefresh = () => {
    void refetchQueryGroup(
      [statusQuery.refetch, healthQuery.refetch, probesQuery.refetch, requestSourceQuery.refetch],
      { warnLabel: "[refetch] Some reliability queries failed to refresh" },
    );
  };

  return (
    <WorkspaceStatusBoundary
      data={statusQuery.data}
      error={statusQuery.error instanceof Error ? statusQuery.error : null}
      isLoading={statusQuery.isLoading}
      onRetry={handleRefresh}
    >
      {(data) => (
        <ReliabilitySection
          data={data}
          healthData={healthQuery.data}
          healthError={healthQuery.error?.message ?? null}
          healthLoading={healthQuery.isLoading}
          browserProbeSummary={browserProbeSummary}
          probes={probesQuery.data}
          probesError={probesQuery.error?.message ?? null}
          probesLoading={probesQuery.isLoading}
          requestSourceStats={requestSourceQuery.data}
          requestSourceError={requestSourceQuery.error?.message ?? null}
          requestSourceLoading={requestSourceQuery.isLoading}
        />
      )}
    </WorkspaceStatusBoundary>
  );
}
