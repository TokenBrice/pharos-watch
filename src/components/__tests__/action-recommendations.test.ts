import { describe, expect, it } from "vitest";
import { deriveStatusActionRecommendations, getRecommendedActionsForCause } from "@/lib/status/action-recommendations";
import type { StatusCause, StatusResponse } from "@shared/types";

function makeCronStatus(overrides?: Partial<StatusResponse["crons"][string]>): StatusResponse["crons"][string] {
  return {
    lastRun: null,
    recentRuns: [],
    expectedIntervalSec: 900,
    healthy: true,
    ...overrides,
  };
}

describe("status action recommendations", () => {
  it("maps data-quality causes to relevant actions", () => {
    const cause: StatusCause = {
      code: "missing_prices_stale",
      layer: "data-quality",
      severity: "critical",
      message: "Missing price ratio is stale.",
    };

    expect(getRecommendedActionsForCause(cause).map((action) => action.path)).toEqual([
      "/api/backfill-cg-prices",
    ]);
  });

  it("recommends cron recovery actions for unhealthy jobs", () => {
    const recommendations = deriveStatusActionRecommendations({
      causes: {
        availability: [],
        dataQuality: [],
        overall: [],
      },
      crons: {
        "sync-blacklist": makeCronStatus({
          healthy: false,
          recentRuns: [
            { startedAt: 10, durationMs: 1, status: "error" },
            { startedAt: 9, durationMs: 1, status: "error" },
          ],
        }),
        "compute-dews": makeCronStatus({
          healthy: false,
          recentRuns: [{ startedAt: 10, durationMs: 1, status: "skipped_locked" }],
        }),
      },
    });

    expect(recommendations.map((item) => item.action.path)).toEqual([
      "/api/reset-blacklist-sync",
      "/api/backfill-dews",
    ]);
    expect(recommendations[0]?.severity).toBe("critical");
    expect(recommendations[1]?.severity).toBe("warning");
  });
});
