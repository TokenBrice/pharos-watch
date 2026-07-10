"use client";

import { useMemo } from "react";
import { useStatus } from "@/hooks/use-status";
import { buildDashboardCronGroups, countRunningDashboardCrons } from "@/lib/status-dashboard-model";
import { getCronSeverity, sortCronGroupsBySeverity } from "../cron-severity";
import { CronsSection } from "../sections/crons-section";
import { useAutoExpand } from "../use-auto-expand";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function CronsClient() {
  const statusQuery = useStatus();
  const [isHealthyCronGroupsOpen, setIsHealthyCronGroupsOpen] = useAutoExpand(false);
  const cronGroups = useMemo(
    () => sortCronGroupsBySeverity(statusQuery.data ? buildDashboardCronGroups(statusQuery.data) : []),
    [statusQuery.data],
  );
  const activeCronGroups = cronGroups.filter((group) => group.entries.some(([, cron]) => getCronSeverity(cron) > 0));
  const healthyCronGroups = cronGroups.filter((group) =>
    group.entries.every(([, cron]) => getCronSeverity(cron) === 0),
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
      {(data) => (
        <CronsSection
          data={data}
          runningCrons={countRunningDashboardCrons(data)}
          activeCronGroups={activeCronGroups}
          healthyCronGroups={healthyCronGroups}
          isHealthyCronGroupsOpen={isHealthyCronGroupsOpen}
          setIsHealthyCronGroupsOpen={setIsHealthyCronGroupsOpen}
        />
      )}
    </WorkspaceStatusBoundary>
  );
}
