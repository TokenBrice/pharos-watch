"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHealth } from "@/hooks/api-hooks";
import { useEndpointProbes } from "@/hooks/use-endpoint-probes";
import { useStatus } from "@/hooks/use-status";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { buildStatusDashboardData, STATUS_DASHBOARD_FRESHNESS_POLICY } from "@/lib/status-dashboard-model";

/**
 * Model-evaluation clock that ticks only when required evidence refreshes or
 * crosses its staleness boundary, instead of free-running every few seconds.
 *
 * Relative-time labels self-update inside leaf components (see
 * `FreshnessIndicator`), so the structural dashboard model only needs to
 * rebuild when a query's evidence state (`current` -> `stale`) can actually
 * change.
 */
function useStalenessBoundaryNow(updatedAtValues: readonly number[]): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const boundaryKey = updatedAtValues.join(",");

  useEffect(() => {
    // Evidence ages are floored to whole seconds before the stale comparison,
    // so a query only reads as stale at the first whole second past the
    // policy budget.
    const staleAtOffsetMs = (Math.floor(STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs / 1_000) + 1) * 1_000;
    const boundaries = boundaryKey
      .split(",")
      .map(Number)
      .filter((updatedAtMs) => updatedAtMs > 0)
      .map((updatedAtMs) => updatedAtMs + staleAtOffsetMs);
    let timer: number | null = null;

    const scheduleNextBoundary = () => {
      const now = Date.now();
      const next = boundaries.reduce<number | null>(
        (earliest, boundary) => (boundary > now && (earliest == null || boundary < earliest) ? boundary : earliest),
        null,
      );
      if (next == null) return;
      timer = window.setTimeout(tick, next - now + 1);
    };

    const tick = () => {
      timer = null;
      setNowMs(Date.now());
      scheduleNextBoundary();
    };

    // Re-anchor immediately when evidence refreshes, then sleep until the
    // next staleness boundary.
    timer = window.setTimeout(tick, 0);
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [boundaryKey]);

  return nowMs;
}

export function useCriticalOpsModel() {
  const statusQuery = useStatus();
  const healthQuery = useHealth();
  const probesQuery = useEndpointProbes({ mode: "critical" });
  const nowMs = useStalenessBoundaryNow([
    statusQuery.dataUpdatedAt,
    healthQuery.dataUpdatedAt,
    probesQuery.dataUpdatedAt,
  ]);

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

  const statusData = statusQuery.data;
  const healthData = healthQuery.data;
  const probesData = probesQuery.data;
  const healthError = healthQuery.error instanceof Error ? healthQuery.error : null;
  const probesError = probesQuery.error instanceof Error ? probesQuery.error : null;
  const statusUpdatedAt = statusQuery.dataUpdatedAt;
  const healthUpdatedAt = healthQuery.dataUpdatedAt;
  const probesUpdatedAt = probesQuery.dataUpdatedAt;
  const statusErrorUpdatedAt = statusQuery.errorUpdatedAt;
  const healthErrorUpdatedAt = healthQuery.errorUpdatedAt;
  const probesErrorUpdatedAt = probesQuery.errorUpdatedAt;

  const model = useMemo(
    () =>
      statusData
        ? buildStatusDashboardData({
            data: statusData,
            healthData,
            probes: probesData,
            probeLabel: "Critical browser probes",
            querySyncs: {
              statusUpdatedAt,
              healthUpdatedAt,
              probesUpdatedAt,
              historyUpdatedAt: 0,
              requestSourceUpdatedAt: 0,
              statusAttemptedAt: Math.max(statusUpdatedAt, statusErrorUpdatedAt),
              healthAttemptedAt: Math.max(healthUpdatedAt, healthErrorUpdatedAt),
              probesAttemptedAt: Math.max(probesUpdatedAt, probesErrorUpdatedAt),
            },
            nowMs,
            statusError: backgroundStatusError,
            healthError,
            probesError,
            historyError: null,
            requestSourceError: null,
            historyTransitions: undefined,
          })
        : null,
    [
      backgroundStatusError,
      healthData,
      healthError,
      healthErrorUpdatedAt,
      healthUpdatedAt,
      nowMs,
      probesData,
      probesError,
      probesErrorUpdatedAt,
      probesUpdatedAt,
      statusData,
      statusErrorUpdatedAt,
      statusUpdatedAt,
    ],
  );

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
