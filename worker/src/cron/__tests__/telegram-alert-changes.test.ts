import { describe, expect, it } from "vitest";
import { buildLaunchPromotions, buildSafetyChanges } from "../telegram-alert-changes";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

describe("telegram alert change builders", () => {
  describe("buildSafetyChanges", () => {
    it.each(["same", "missing-current", "missing-previous"] as const)(
      "emits a real grade transition with %s methodology",
      (methodology) => {
        expect(buildSafetyChanges(
          { alpha: { grade: "B", score: 72, methodologyVersion: methodology === "missing-current" ? null : "9.0" } },
          { alpha: { grade: "A", score: 85, methodologyVersion: methodology === "missing-previous" ? null : "9.0" } },
          (id) => id === "alpha" ? "ALPHA" : "WRONG",
        )).toEqual({
          changes: [{ stablecoinId: "alpha", symbol: "ALPHA", oldGrade: "A", newGrade: "B", oldScore: 85, newScore: 72 }],
          suppressedMethodologyChanges: 0,
        });
      },
    );

    it("does not turn score-only movement or a new coin into a grade transition", () => {
      expect(buildSafetyChanges(
        { alpha: { grade: "A", score: 89, methodologyVersion: null }, newcomer: { grade: "B", score: 70, methodologyVersion: null } },
        { alpha: { grade: "A", score: 85, methodologyVersion: null } },
        () => "ALPHA",
      )).toEqual({ changes: [], suppressedMethodologyChanges: 0 });
    });

    it("emits nothing when the current snapshot is unavailable", () => {
      expect(buildSafetyChanges(null, { alpha: { grade: "A", score: 85, methodologyVersion: null } }, () => "ALPHA"))
        .toEqual({ changes: [], suppressedMethodologyChanges: 0 });
    });
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
