"use client";

import { useCriticalOpsModel } from "@/hooks/use-critical-ops-model";
import { ActionsSection } from "../sections/actions-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function ActionsClient() {
  const { data, handleRefresh, healthData, initialLoadError, isLoading, model } = useCriticalOpsModel();

  return (
    <WorkspaceStatusBoundary data={data} error={initialLoadError} isLoading={isLoading} onRetry={handleRefresh}>
      {(status) =>
        model ? (
          <ActionsSection
            data={status}
            healthData={healthData}
            clientDataStale={model.clientDataStale}
            handleRefresh={handleRefresh}
            recommendedActions={model.recommendedActions}
          />
        ) : null
      }
    </WorkspaceStatusBoundary>
  );
}
