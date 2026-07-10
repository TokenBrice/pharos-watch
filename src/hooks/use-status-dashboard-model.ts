"use client";

import { useCallback, useEffect, useState } from "react";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/api-hooks";
import { useRequestSourceStats } from "@/hooks/use-request-source-stats";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";
import { refetchQueryGroup } from "@/lib/query-refetch-group";

export function useStatusDashboardModel() {
  const {
    data,
    isLoading,
    error,
    refetch: refetchStatus,
    dataUpdatedAt: statusUpdatedAt,
    errorUpdatedAt: statusErrorUpdatedAt,
  } = useStatus();
  const {
    data: healthData,
    error: healthError,
    refetch: refetchHealth,
    dataUpdatedAt: healthUpdatedAt,
    errorUpdatedAt: healthErrorUpdatedAt,
  } = useHealth();
  const {
    data: probes,
    isLoading: probesLoading,
    error: probesError,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
    errorUpdatedAt: probesErrorUpdatedAt,
  } = useEndpointProbes();
  const [historyWindow, setHistoryWindow] = useState<StatusHistoryWindow>("24h");
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    refetch: refetchHistory,
    dataUpdatedAt: historyUpdatedAt,
    errorUpdatedAt: historyErrorUpdatedAt,
  } = useStatusHistory(historyWindow);
  const {
    data: requestSourceStats,
    error: requestSourceError,
    isLoading: requestSourceLoading,
    refetch: refetchRequestSourceStats,
    dataUpdatedAt: requestSourceUpdatedAt,
    errorUpdatedAt: requestSourceErrorUpdatedAt,
  } = useRequestSourceStats();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    void refetchQueryGroup([refetchStatus, refetchHealth, refetchProbes, refetchHistory, refetchRequestSourceStats], {
      warnLabel: "[refetch] Some status dashboard queries failed to refresh",
    });
  }, [refetchHealth, refetchHistory, refetchProbes, refetchRequestSourceStats, refetchStatus]);

  const criticalUpdatedAts = [statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0];
  const hasCompleteRequiredEvidence =
    data != null && healthData != null && probes !== undefined && criticalUpdatedAts.every((value) => value > 0);
  const lastUpdated = hasCompleteRequiredEvidence ? Math.min(...criticalUpdatedAts) : 0;
  const initialLoadError = data == null && error instanceof Error ? error : null;
  const backgroundStatusError = data != null && error instanceof Error ? error : null;

  if (!data) {
    return {
      data,
      handleRefresh,
      healthData,
      healthError,
      historyData,
      historyError,
      historyLoading,
      historyWindow,
      initialLoadError,
      isLoading,
      lastUpdated,
      model: null,
      backgroundStatusError,
      hasRetainedStatusData: false,
      probes,
      probesError,
      probesLoading,
      requestSourceError,
      requestSourceLoading,
      requestSourceStats,
      setHistoryWindow,
    };
  }

  return {
    data,
    handleRefresh,
    healthData,
    healthError,
    historyData,
    historyError,
    historyLoading,
    historyWindow,
    isLoading,
    lastUpdated,
    model: buildStatusDashboardData({
      data,
      healthData,
      probes,
      querySyncs: {
        statusUpdatedAt: statusUpdatedAt ?? 0,
        healthUpdatedAt: healthUpdatedAt ?? 0,
        probesUpdatedAt: probesUpdatedAt ?? 0,
        historyUpdatedAt: historyUpdatedAt ?? 0,
        requestSourceUpdatedAt: requestSourceUpdatedAt ?? 0,
        statusAttemptedAt: Math.max(statusUpdatedAt ?? 0, statusErrorUpdatedAt ?? 0),
        healthAttemptedAt: Math.max(healthUpdatedAt ?? 0, healthErrorUpdatedAt ?? 0),
        probesAttemptedAt: Math.max(probesUpdatedAt ?? 0, probesErrorUpdatedAt ?? 0),
        historyAttemptedAt: Math.max(historyUpdatedAt ?? 0, historyErrorUpdatedAt ?? 0),
        requestSourceAttemptedAt: Math.max(requestSourceUpdatedAt ?? 0, requestSourceErrorUpdatedAt ?? 0),
      },
      nowMs,
      statusError: backgroundStatusError,
      healthError: healthError instanceof Error ? healthError : null,
      probesError: probesError instanceof Error ? probesError : null,
      historyError: historyError instanceof Error ? historyError : null,
      requestSourceError: requestSourceError instanceof Error ? requestSourceError : null,
      historyTransitions: historyData?.transitions,
    }),
    probes,
    probesError,
    probesLoading,
    backgroundStatusError,
    hasRetainedStatusData: backgroundStatusError != null,
    initialLoadError,
    requestSourceError,
    requestSourceLoading,
    requestSourceStats,
    setHistoryWindow,
  };
}
