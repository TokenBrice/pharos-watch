"use client";

import { useStatus } from "@/hooks/use-status";
import { PipelineSection } from "../sections/pipeline-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function PipelineClient() {
  const statusQuery = useStatus();
  const handleRefresh = () => {
    void statusQuery.refetch();
  };

  return (
    <WorkspaceStatusBoundary
      data={statusQuery.data}
      error={statusQuery.error instanceof Error ? statusQuery.error : null}
      isLoading={statusQuery.isLoading}
      onRetry={handleRefresh}
    >
      {(data) => <PipelineSection data={data} />}
    </WorkspaceStatusBoundary>
  );
}
