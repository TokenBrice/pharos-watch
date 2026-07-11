"use client";

import { useStatus } from "@/hooks/use-status";
import { CommsSection } from "../sections/comms-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function CommsClient() {
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
      {(data) => <CommsSection data={data} />}
    </WorkspaceStatusBoundary>
  );
}
