import { vi } from "vitest";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";
import {
  STATUS_FIXTURE_NOW_MS,
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
} from "@/test-utils/status-fixtures";

export function makeCriticalOpsResult({ initialLoadError = null }: { initialLoadError?: Error | null } = {}) {
  const data = makeHealthyStatusResponse();
  const healthData = makeHealthyHealthResponse();
  const model = buildStatusDashboardData({
    data,
    healthData,
    probes: [
      { path: "/api/health", status: 200, latencyMs: 20 },
      { path: "/api/status", status: 200, latencyMs: 30 },
    ],
    probeLabel: "Critical browser probes",
    querySyncs: {
      statusUpdatedAt: STATUS_FIXTURE_NOW_MS,
      healthUpdatedAt: STATUS_FIXTURE_NOW_MS,
      probesUpdatedAt: STATUS_FIXTURE_NOW_MS,
      historyUpdatedAt: 0,
      requestSourceUpdatedAt: 0,
    },
    nowMs: STATUS_FIXTURE_NOW_MS,
    healthError: null,
    probesError: null,
    historyError: null,
    requestSourceError: null,
    historyTransitions: undefined,
  });

  return {
    data: initialLoadError ? undefined : data,
    handleRefresh: vi.fn(),
    healthData: initialLoadError ? undefined : healthData,
    initialLoadError,
    isLoading: false,
    lastUpdated: initialLoadError ? 0 : STATUS_FIXTURE_NOW_MS,
    model: initialLoadError ? null : model,
  };
}
