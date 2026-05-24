import { describe, expect, it } from "vitest";
import { buildLaunchPromotions, buildSafetyChanges } from "../telegram-alert-changes";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

describe("telegram alert change builders", () => {
  describe("buildSafetyChanges", () => {
    it("suppresses methodology-version-only grade changes even when explain data is present", () => {
      const current: SafetySnapshot = {
        "usdc-circle": {
          grade: "C+",
          score: 61,
          methodologyVersion: "7.10",
          explain: {
            schemaVersion: 1,
            stages: {
              baseScore: 61,
              postPegScore: 61,
              postNoLiquidityPenaltyScore: 61,
              activeDepegCapScore: null,
              postActiveDepegCapScore: 61,
              scoreBeforeVariantCap: 61,
              finalScore: 61,
              noLiquidityPenaltyApplied: false,
              activeDepegCapApplied: false,
              variantCapApplied: false,
            },
            dimensions: {
              pegStability: { grade: "A", score: 96 },
              liquidity: { grade: "C+", score: 61 },
              resilience: { grade: "B", score: 72 },
              decentralization: { grade: "B", score: 72 },
              dependencyRisk: { grade: "B", score: 72 },
            },
            rawInputs: {
              pegScore: 96,
              activeDepeg: false,
              activeDepegBps: null,
              liquidityScore: 61,
              effectiveExitScore: 61,
              redemptionBackstopScore: null,
              redemptionUsedForLiquidity: false,
              redemptionRouteFamily: null,
              redemptionModelConfidence: null,
              redemptionExclusionReason: null,
              redemptionImmediateCapacityUsd: null,
              redemptionImmediateCapacityRatio: null,
              concentrationHhi: null,
              canBeBlacklisted: false,
              collateralFromLive: false,
              dependencyFromLive: false,
              dependencyCount: 0,
              variantParentId: null,
              navToken: false,
            },
          },
        },
      };
      const previous: SafetySnapshot = {
        "usdc-circle": {
          grade: "B",
          score: 72,
          methodologyVersion: "7.09",
          explain: current["usdc-circle"].explain,
        },
      };

      const result = buildSafetyChanges(current, previous, () => "USDC");

      expect(result).toEqual({ changes: [], suppressedMethodologyChanges: 1 });
    });
  });

  describe("buildLaunchPromotions", () => {
    it("emits a launch alert when a tracked coin leaves the pre-launch set", () => {
      const result = buildLaunchPromotions(
        new Set(["dai-makerdao", "still-prelaunch"]),
        new Set(["still-prelaunch"]),
        new Set(["dai-makerdao", "still-prelaunch"]),
        new Map([
          ["dai-makerdao", { symbol: "DAI", name: "Dai" }],
          ["still-prelaunch", { symbol: "PRE", name: "Still Prelaunch" }],
        ]),
      );

      expect(result).toEqual([{ stablecoinId: "dai-makerdao", symbol: "DAI", name: "Dai" }]);
    });

    it("ignores coins that are still pre-launch, inactive, or missing metadata", () => {
      const result = buildLaunchPromotions(
        new Set(["still-prelaunch", "inactive-coin", "unknown-coin"]),
        new Set(["still-prelaunch"]),
        new Set(["still-prelaunch", "unknown-coin"]),
        new Map([["inactive-coin", { symbol: "OLD", name: "Inactive Coin" }]]),
      );

      expect(result).toEqual([]);
    });
  });
});
