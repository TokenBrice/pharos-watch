import { describe, expect, it } from "vitest";
import { buildActionReadinessChecks, buildReserveRecoveryForecast } from "@/lib/status/admin-ops-insights";
import type { StatusResponse } from "@shared/types";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

function withReservePressure(base: StatusResponse): StatusResponse {
  return {
    ...base,
    reserveComposition: {
      ...base.reserveComposition,
      status: "degraded",
      deferredCoins: 48,
      runBudgetTruncated: true,
      nextCursorStablecoinId: "a7a5-old-vector",
      freshCoverageRatio: 0.7365,
      authoritativeFreshCoverageRatio: 0.7329,
    },
    crons: {
      ...base.crons,
      "sync-live-reserves": {
        lastRun: {
          startedAt: 1_699_998_000,
          durationMs: 720_000,
          status: "error",
          itemCount: 52,
          metadata: {
            synced: 52,
            total: 100,
            deferredCoins: 48,
            runBudgetTruncated: true,
            nextCursorStablecoinId: "a7a5-old-vector",
          },
        },
        recentRuns: [],
        expectedIntervalSec: 14_400,
        healthy: false,
      },
    },
  };
}

describe("admin ops insights", () => {
  it("estimates reserve catch-up from deferred queue and last-run throughput", () => {
    const data = withReservePressure(makeHealthyStatusResponse());

    const forecast = buildReserveRecoveryForecast(data);

    expect(forecast.state).toBe("catching-up");
    expect(forecast.resumeCursor).toBe("a7a5-old-vector");
    expect(forecast.lastThroughput).toBe(52);
    expect(forecast.estimatedRunsToClear).toBe(1);
    expect(forecast.detail).toContain("48 coin(s) remain deferred");
  });

  it("marks writes and stale dashboard data as not ready for manual recovery", () => {
    const data = withReservePressure(makeHealthyStatusResponse());
    data.reserveComposition.writeTimeoutUncertain = 2;

    const checks = buildActionReadinessChecks({
      data,
      healthData: makeHealthyHealthResponse(),
      clientDataStale: true,
      recommendedActions: [],
    });

    expect(checks.find((check) => check.id === "fresh-status-view")?.state).toBe("watch");
    expect(checks.find((check) => check.id === "d1-writes")?.state).toBe("blocked");
    expect(checks.find((check) => check.id === "reserve-cursor")?.state).toBe("watch");
    expect(checks.find((check) => check.id === "manual-actions")?.state).toBe("ready");
  });
});
