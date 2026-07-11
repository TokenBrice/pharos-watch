"use client";

import { useCallback, useEffect, useState } from "react";
import { useReleaseMetadata } from "@/hooks/use-release-metadata";
import { useAdminActionLog } from "@/hooks/use-admin-action-log";
import { useApiKeyAuditLog } from "@/hooks/use-api-key-audit-log";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  buildIncidentHistoryUrl,
  deriveWorkerVersionEvidence,
  parseIncidentHistoryQuery,
  type IncidentHistoryFilters,
  type IncidentHistoryQuery,
} from "@/lib/incident-history-view-model";
import { HistorySection } from "../sections/history-section";
import { WorkspaceStatusBoundary } from "../workspace-status-boundary";

export default function HistoryClient() {
  const statusQuery = useStatus();
  const [historyState, setHistoryState] = useState<IncidentHistoryQuery>(DEFAULT_INCIDENT_HISTORY_QUERY);
  const historyQuery = useStatusHistory(historyState.window);
  const releaseMetadataState = useReleaseMetadata();
  const adminActionLogQuery = useAdminActionLog();
  const credentialAuditQuery = useApiKeyAuditLog("global");

  useEffect(() => {
    const syncFromUrl = () => setHistoryState(parseIncidentHistoryQuery(window.location.search));
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  const updateHistoryState = useCallback((patch: Partial<IncidentHistoryQuery>) => {
    setHistoryState((current) => {
      const next = { ...current, ...patch };
      window.history.replaceState(window.history.state, "", buildIncidentHistoryUrl(window.location, next));
      return next;
    });
  }, []);

  const setHistoryWindow = useCallback(
    (window: StatusHistoryWindow) => updateHistoryState({ window }),
    [updateHistoryState],
  );
  const setHistoryFilters = useCallback(
    (patch: Partial<IncidentHistoryFilters>) => updateHistoryState(patch),
    [updateHistoryState],
  );
  const handleRefresh = () => {
    void refetchQueryGroup(
      [statusQuery.refetch, historyQuery.refetch, adminActionLogQuery.refetch, credentialAuditQuery.refetch],
      {
        warnLabel: "[refetch] Some incident-history queries failed to refresh",
      },
    );
  };

  return (
    <WorkspaceStatusBoundary
      data={statusQuery.data}
      error={statusQuery.error instanceof Error ? statusQuery.error : null}
      isLoading={statusQuery.isLoading}
      onRetry={handleRefresh}
    >
      {(data) => {
        const hasHistoryData = historyQuery.data != null;
        const historyError = historyQuery.error instanceof Error ? historyQuery.error : null;
        const allTransitions = hasHistoryData ? historyQuery.data.transitions : data.timeline;
        const historyCompleteness =
          hasHistoryData && !historyError
            ? historyQuery.data.hasMore === false
              ? ("complete" as const)
              : historyQuery.data.hasMore === true
                ? ("truncated" as const)
                : ("unknown" as const)
            : ("unknown" as const);
        const historyEvidence = hasHistoryData
          ? historyError
            ? {
                source: "history" as const,
                state: "stale" as const,
                completeness: historyCompleteness,
                message: `History refresh failed; showing retained history data. ${historyError.message}`,
              }
            : {
                source: "history" as const,
                state: "ready" as const,
                completeness: historyCompleteness,
                message:
                  historyCompleteness === "complete"
                    ? "Showing the complete persisted transition window."
                    : historyCompleteness === "truncated"
                      ? "The history result reached its row limit; older transitions in the selected window are omitted."
                      : "History loaded, but the API could not determine whether the selected window is complete.",
              }
          : historyError
            ? {
                source: "status-fallback" as const,
                state: "error" as const,
                completeness: "unknown" as const,
                message: `History query failed; showing only transitions included in the current status response. ${historyError.message}`,
              }
            : {
                source: "status-fallback" as const,
                state: "loading" as const,
                completeness: "unknown" as const,
                message: "History is loading; showing only transitions included in the current status response.",
              };
        const workerVersionEvidence = deriveWorkerVersionEvidence(data);
        return (
          <HistorySection
            allTransitions={allTransitions}
            latestTransition={allTransitions[0] ?? null}
            reserveComposition={data.reserveComposition}
            releaseMetadataState={releaseMetadataState}
            workerVersionEvidence={workerVersionEvidence}
            adminActionLog={{
              entries: adminActionLogQuery.data?.entries ?? [],
              error: adminActionLogQuery.error,
              isLoading: adminActionLogQuery.isLoading,
              isFetching: adminActionLogQuery.isFetching,
              onRetry: () => void adminActionLogQuery.refetch(),
            }}
            credentialAudit={{
              entries: credentialAuditQuery.data?.entries ?? [],
              error: credentialAuditQuery.error,
              isLoading: credentialAuditQuery.isLoading,
              isFetching: credentialAuditQuery.isFetching,
              onRetry: () => void credentialAuditQuery.refetch(),
            }}
            nowSeconds={data.timestamp}
            transitionsLast24h={data.summary.transitionsLast24h}
            historyWindow={historyState.window}
            historyFilters={historyState}
            setHistoryWindow={setHistoryWindow}
            setHistoryFilters={setHistoryFilters}
            historyLoading={historyQuery.isLoading}
            historyEvidence={historyEvidence}
          />
        );
      }}
    </WorkspaceStatusBoundary>
  );
}
