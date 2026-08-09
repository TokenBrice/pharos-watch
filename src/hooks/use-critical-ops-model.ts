"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHealth } from "@/hooks/api-hooks";
import { useQuerySlices } from "@/hooks/use-query-slice";
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
  const { status, health, probes } = useQuerySlices({
    status: statusQuery,
    health: healthQuery,
    probes: probesQuery,
  });
  const nowMs = useStalenessBoundaryNow([status.dataUpdatedAt, health.dataUpdatedAt, probes.dataUpdatedAt]);

  const handleRefresh = useCallback(() => {
    void refetchQueryGroup([statusQuery.refetch, healthQuery.refetch, probesQuery.refetch], {
      warnLabel: "[refetch] Some critical operator evidence failed to refresh",
    });
  }, [healthQuery.refetch, probesQuery.refetch, statusQuery.refetch]);

  const requiredUpdatedAt = [status.dataUpdatedAt, health.dataUpdatedAt, probes.dataUpdatedAt];
  const hasCompleteRequiredEvidence =
    status.data != null &&
    health.data != null &&
    probes.data !== undefined &&
    requiredUpdatedAt.every((value) => value > 0);
  const lastUpdated = hasCompleteRequiredEvidence ? Math.min(...requiredUpdatedAt) : 0;
  const initialLoadError = status.data == null && status.error instanceof Error ? status.error : null;
  const backgroundStatusError = status.data != null && status.error instanceof Error ? status.error : null;
  const healthError = health.error instanceof Error ? health.error : null;
  const probesError = probes.error instanceof Error ? probes.error : null;

  const model = useMemo(
    () =>
      status.data
        ? buildStatusDashboardData({
            data: status.data,
            healthData: health.data,
            probes: probes.data,
            probeLabel: "Critical browser probes",
            querySyncs: {
              statusUpdatedAt: status.dataUpdatedAt,
              healthUpdatedAt: health.dataUpdatedAt,
              probesUpdatedAt: probes.dataUpdatedAt,
              historyUpdatedAt: 0,
              requestSourceUpdatedAt: 0,
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
    [backgroundStatusError, health, healthError, nowMs, probes, probesError, status],
  );

  return {
    backgroundStatusError,
    data: status.data,
    handleRefresh,
    healthData: health.data,
    initialLoadError,
    isLoading: status.isLoading,
    lastUpdated,
    model,
    probes: probes.data,
    probesLoading: probes.isLoading,
  };
}
