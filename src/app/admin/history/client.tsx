"use client";

import { useState } from "react";
import { useReleaseMetadata } from "@/hooks/use-release-metadata";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { HistorySection } from "../sections/history-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function HistoryClient() {
  const statusQuery = useStatus();
  const [historyWindow, setHistoryWindow] = useState<StatusHistoryWindow>("24h");
  const historyQuery = useStatusHistory(historyWindow);
  const releaseMetadataState = useReleaseMetadata();
  const handleRefresh = () => {
    void refetchQueryGroup([statusQuery.refetch, historyQuery.refetch], {
      warnLabel: "[refetch] Some incident-history queries failed to refresh",
    });
  };

  return (
    <WorkspaceStatusBoundary
      data={statusQuery.data}
      error={statusQuery.error instanceof Error ? statusQuery.error : null}
      isLoading={statusQuery.isLoading}
      onRetry={handleRefresh}
    >
      {(data) => {
        const allTransitions = historyQuery.data?.transitions ?? data.timeline;
        return (
          <HistorySection
            allTransitions={allTransitions}
            latestTransition={allTransitions[0] ?? null}
            reserveComposition={data.reserveComposition}
            releaseMetadataState={releaseMetadataState}
            nowSeconds={data.timestamp}
            historyWindow={historyWindow}
            setHistoryWindow={setHistoryWindow}
            historyLoading={historyQuery.isLoading}
          />
        );
      }}
    </WorkspaceStatusBoundary>
  );
}
