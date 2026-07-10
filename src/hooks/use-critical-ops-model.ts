"use client";

import { useCallback, useEffect, useState } from "react";
import { useHealth } from "@/hooks/api-hooks";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useStatus } from "@/hooks/use-status";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";

export function useCriticalOpsModel() {
  const statusQuery = useStatus();
  const healthQuery = useHealth();
  const probesQuery = useEndpointProbes({ mode: "critical" });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    void refetchQueryGroup([statusQuery.refetch, healthQuery.refetch, probesQuery.refetch], {
      warnLabel: "[refetch] Some critical operator evidence failed to refresh",
    });
  }, [healthQuery.refetch, probesQuery.refetch, statusQuery.refetch]);

  const requiredUpdatedAt = [statusQuery.dataUpdatedAt, healthQuery.dataUpdatedAt, probesQuery.dataUpdatedAt];
  const hasCompleteRequiredEvidence =
    statusQuery.data != null &&
    healthQuery.data != null &&
    probesQuery.data !== undefined &&
    requiredUpdatedAt.every((value) => value > 0);
  const lastUpdated = hasCompleteRequiredEvidence ? Math.min(...requiredUpdatedAt) : 0;
  const initialLoadError = statusQuery.data == null && statusQuery.error instanceof Error ? statusQuery.error : null;
  const backgroundStatusError =
    statusQuery.data != null && statusQuery.error instanceof Error ? statusQuery.error : null;

  const model = statusQuery.data
    ? buildStatusDashboardData({
        data: statusQuery.data,
        healthData: healthQuery.data,
        probes: probesQuery.data,
        probeLabel: "Critical browser probes",
        querySyncs: {
          statusUpdatedAt: statusQuery.dataUpdatedAt,
          healthUpdatedAt: healthQuery.dataUpdatedAt,
          probesUpdatedAt: probesQuery.dataUpdatedAt,
          historyUpdatedAt: 0,
          requestSourceUpdatedAt: 0,
          statusAttemptedAt: Math.max(statusQuery.dataUpdatedAt, statusQuery.errorUpdatedAt),
          healthAttemptedAt: Math.max(healthQuery.dataUpdatedAt, healthQuery.errorUpdatedAt),
          probesAttemptedAt: Math.max(probesQuery.dataUpdatedAt, probesQuery.errorUpdatedAt),
        },
        nowMs,
        statusError: backgroundStatusError,
        healthError: healthQuery.error instanceof Error ? healthQuery.error : null,
        probesError: probesQuery.error instanceof Error ? probesQuery.error : null,
        historyError: null,
        requestSourceError: null,
        historyTransitions: undefined,
      })
    : null;

  return {
    backgroundStatusError,
    data: statusQuery.data,
    handleRefresh,
    healthData: healthQuery.data,
    initialLoadError,
    isLoading: statusQuery.isLoading,
    lastUpdated,
    model,
    probes: probesQuery.data,
    probesLoading: probesQuery.isLoading,
  };
}
