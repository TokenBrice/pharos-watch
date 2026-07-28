import { describe, expect, it } from "vitest";
import { buildLaunchPromotions, buildSafetyChanges } from "../telegram-alert-changes";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

describe("telegram alert change builders", () => {
  describe("buildSafetyChanges", () => {
    it("suppresses methodology-version-only grade changes", () => {
      const current: SafetySnapshot = {
        "usdc-circle": {
          grade: "C+",
          score: 61,
          methodologyVersion: "9.0",
        },
      };
      const previous: SafetySnapshot = {
        "usdc-circle": {
          grade: "B",
          score: 72,
          methodologyVersion: "9.1",
        },
      };

      const result = buildSafetyChanges(current, previous, () => "USDC");

      expect(result).toEqual({ changes: [], suppressedMethodologyChanges: 1 });
    });

    it.each([
      ["quarantine", true, false],
      ["recovery", false, true],
    ])("suppresses an operational %s grade transition", (
      _label,
      currentAffected,
      previousAffected,
    ) => {
      const result = buildSafetyChanges(
        {
          alpha: {
            grade: currentAffected ? "NR" : "A",
            score: currentAffected ? null : 85,
            methodologyVersion: "9.0",
            operationallyAffected: currentAffected,
          },
        },
        {
          alpha: {
            grade: previousAffected ? "NR" : "A",
            score: previousAffected ? null : 85,
            methodologyVersion: "9.0",
            operationallyAffected: previousAffected,
          },
        },
        () => "ALPHA",
      );

      expect(result).toEqual({
        changes: [],
        suppressedMethodologyChanges: 0,
      });
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
