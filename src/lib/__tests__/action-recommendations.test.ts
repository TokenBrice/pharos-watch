import { describe, expect, it } from "vitest";
import { deriveStatusActionRecommendations } from "../status/action-recommendations";
import type { StatusResponse } from "@shared/types/status";

describe("deriveStatusActionRecommendations", () => {
  it("does not promote reset-blacklist-sync for generic blacklist gap warnings", () => {
    const recommendations = deriveStatusActionRecommendations({
      causes: {
        availability: [],
        dataQuality: [],
        overall: [
          {
            code: "blacklist_gaps_degraded",
            layer: "data-quality",
            severity: "warning",
            message: "Recent or elevated blacklist amount gaps detected.",
          },
        ],
      },
      crons: {} as StatusResponse["crons"],
    });

    expect(recommendations.map((entry) => entry.action.path)).toEqual([
      "/api/backfill-blacklist-current-balances",
      "/api/debug-sync-state",
      "/api/remediate-blacklist-amount-gaps",
    ]);
  });
});
