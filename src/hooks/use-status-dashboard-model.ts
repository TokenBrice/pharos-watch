"use client";

import { useCallback, useEffect, useState } from "react";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useHealth } from "@/hooks/api-hooks";
import { useStatusHistory, type StatusHistoryWindow } from "@/hooks/use-status-history";
import { useStatus } from "@/hooks/use-status";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";

export function useStatusDashboardModel(adminKey: string) {
  const { data, isLoading, error, refetch: refetchStatus, dataUpdatedAt: statusUpdatedAt } = useStatus(adminKey);
  const { data: healthData, error: healthError, refetch: refetchHealth, dataUpdatedAt: healthUpdatedAt } = useHealth();
  const {
    data: probes,
    isLoading: probesLoading,
    error: probesError,
    refetch: refetchProbes,
    dataUpdatedAt: probesUpdatedAt,
  } = useEndpointProbes(adminKey);
  const [historyWindow, setHistoryWindow] = useState<StatusHistoryWindow>("24h");
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    refetch: refetchHistory,
  } = useStatusHistory(adminKey, historyWindow);
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
  }, [refetchHealth, refetchHistory, refetchProbes, refetchStatus]);

  const lastUpdated = Math.max(statusUpdatedAt ?? 0, healthUpdatedAt ?? 0, probesUpdatedAt ?? 0);

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
      probesUpdatedAt: probesUpdatedAt ?? 0,
      lastUpdated,
      nowMs,
      healthError: healthError instanceof Error ? healthError : null,
      probesError: probesError instanceof Error ? probesError : null,
      historyError: historyError instanceof Error ? historyError : null,
      historyTransitions: historyData?.transitions,
    }),
    probes,
    probesError,
    probesLoading,
    setHistoryWindow,
  };
}
