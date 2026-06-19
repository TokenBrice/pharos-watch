import { describe, expect, it } from "vitest";
import type { EndpointProbeResult } from "@shared/types";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { buildBrowserProbeSummary, buildStatusDashboardData } from "../status-dashboard-model";

const BASE_STATUS = makeHealthyStatusResponse();
const BASE_HEALTH = makeHealthyHealthResponse();

describe("status dashboard model", () => {
  it("treats semantic degradation as an unhealthy browser probe", () => {
    const probes: EndpointProbeResult[] = [
      {
        path: "/api/health",
        status: 200,
        latencyMs: 80,
        semanticStatus: "degraded",
        semanticDetail: "Mint/burn sync warning",
        semanticScope: "health",
      },
      {
        path: "/api/stablecoins",
        status: 200,
        latencyMs: 40,
      },
    ];

    expect(buildBrowserProbeSummary(probes, 10_000)).toEqual({
      sampleCount: 2,
      passCount: 1,
      failCount: 1,
      degradedCount: 1,
      staleCount: 0,
      p95LatencyMs: 80,
      status: "degraded",
      updatedAt: 10,
    });
  });

  it("uses the oldest critical query timestamp as the freshness floor", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        statusUpdatedAt: 900_000,
        healthUpdatedAt: 870_000,
        probesUpdatedAt: 900_000,
        historyUpdatedAt: 900_000,
        requestSourceUpdatedAt: 900_000,
      },
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.clientDataAgeSec).toBe(130);
    expect(model.clientDataStale).toBe(true);
    expect(model.querySyncs.find((sync) => sync.key === "health")?.stale).toBe(true);
    expect(model.notices.some((notice) => notice.id === "client-stale")).toBe(true);
  });

});
