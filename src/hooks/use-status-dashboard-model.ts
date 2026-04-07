"use client";

import { useCallback, useEffect, useState } from "react";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/api-hooks";
import { useRequestSourceStats } from "@/hooks/use-request-source-stats";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";

export function useStatusDashboardModel() {
  const { data, isLoading, error, refetch: refetchStatus, dataUpdatedAt: statusUpdatedAt } = useStatus();
  const { data: healthData, error: healthError, refetch: refetchHealth, dataUpdatedAt: healthUpdatedAt } = useHealth();
  const {
    data: probes,
    isLoading: probesLoading,
    error: probesError,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
  } = useEndpointProbes();
  const [historyWindow, setHistoryWindow] = useState<StatusHistoryWindow>("24h");
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    refetch: refetchHistory,
    dataUpdatedAt: historyUpdatedAt,
  } = useStatusHistory(historyWindow);
  const {
    data: requestSourceStats,
    error: requestSourceError,
    isLoading: requestSourceLoading,
    refetch: refetchRequestSourceStats,
    dataUpdatedAt: requestSourceUpdatedAt,
  } = useRequestSourceStats();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchStatus();
    refetchHealth();
    refetchProbes();
    refetchHistory();
    refetchRequestSourceStats();
  }, [refetchHealth, refetchHistory, refetchProbes, refetchRequestSourceStats, refetchStatus]);

  const criticalUpdatedAts = [statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0]
    .filter((value) => value > 0);
  const lastUpdated = criticalUpdatedAts.length > 0 ? Math.min(...criticalUpdatedAts) : 0;

  if (!data) {
    return {
      data,
      error,
      handleRefresh,
      healthData,
      healthError,
      historyData,
      historyError,
      historyLoading,
      historyWindow,
      isLoading,
      lastUpdated,
      model: null,
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
    error,
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
      },
      nowMs,
      healthError: healthError instanceof Error ? healthError : null,
      probesError: probesError instanceof Error ? probesError : null,
      historyError: historyError instanceof Error ? historyError : null,
      requestSourceError: requestSourceError instanceof Error ? requestSourceError : null,
      historyTransitions: historyData?.transitions,
    }),
    probes,
    probesError,
    probesLoading,
    requestSourceError,
    requestSourceLoading,
    requestSourceStats,
    setHistoryWindow,
  };
}
