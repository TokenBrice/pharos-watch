"use client";

import { useMemo } from "react";
import { useStatus } from "@/hooks/use-status";
import { buildDashboardCronGroups, countRunningDashboardCrons } from "@/lib/status-dashboard-model";
import { CronsSection } from "../sections/crons-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function CronsClient() {
  const statusQuery = useStatus();
  const cronGroups = useMemo(
    () => (statusQuery.data ? buildDashboardCronGroups(statusQuery.data) : []),
    [statusQuery.data],
  );
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
      {(data) => <CronsSection data={data} runningCrons={countRunningDashboardCrons(data)} cronGroups={cronGroups} />}
    </WorkspaceStatusBoundary>
  );
}
