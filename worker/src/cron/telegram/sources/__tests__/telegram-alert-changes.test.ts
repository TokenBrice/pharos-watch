import { describe, expect, it } from "vitest";
import {
  SAFETY_AVAILABILITY_HOLD_MAX_SEC,
  SAFETY_RUNTIME_AVAILABILITY_REASON_CODES,
  buildLaunchPromotions,
  buildSafetyChanges,
  holdSuppressedSafetyBaselines,
} from "../telegram-alert-changes";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

describe("telegram alert change builders", () => {
  describe("buildSafetyChanges", () => {
    it.each(["same", "missing-current", "missing-previous"] as const)(
      "emits a real grade transition with %s methodology",
      (methodology) => {
        expect(buildSafetyChanges(
          { alpha: { grade: "B", score: 72, ratingStatus: "rated", partialEvidence: null, methodologyVersion: methodology === "missing-current" ? null : "9.0" } },
          { alpha: { grade: "A", score: 85, ratingStatus: "rated", partialEvidence: null, methodologyVersion: methodology === "missing-previous" ? null : "9.0" } },
          (id) => id === "alpha" ? "ALPHA" : "WRONG",
        )).toEqual({
          changes: [{ stablecoinId: "alpha", symbol: "ALPHA", oldGrade: "A", newGrade: "B", oldScore: 85, newScore: 72 }],
          suppressedMethodologyChanges: 0,
          suppressedRuntimeAvailabilityChanges: 0,
          suppressedMinorSafetyChanges: 0,
          heldBaselineIds: [],
          availabilityHeldIds: [],
        });
      },
    );

    it("does not turn score-only movement or a new coin into a grade transition", () => {
      expect(buildSafetyChanges(
        { alpha: { grade: "A", score: 89, ratingStatus: "rated", partialEvidence: null, methodologyVersion: null }, newcomer: { grade: "B", score: 70, ratingStatus: "rated", partialEvidence: null, methodologyVersion: null } },
        { alpha: { grade: "A", score: 85, ratingStatus: "rated", partialEvidence: null, methodologyVersion: null } },
        () => "ALPHA",
      )).toEqual({ changes: [], suppressedMethodologyChanges: 0, suppressedRuntimeAvailabilityChanges: 0, suppressedMinorSafetyChanges: 0, heldBaselineIds: [], availabilityHeldIds: [] });
    });

    it("emits nothing when the current snapshot is unavailable", () => {
      expect(buildSafetyChanges(null, { alpha: { grade: "A", score: 85, ratingStatus: "rated", partialEvidence: null, methodologyVersion: null } }, () => "ALPHA"))
        .toEqual({ changes: [], suppressedMethodologyChanges: 0, suppressedRuntimeAvailabilityChanges: 0, suppressedMinorSafetyChanges: 0, heldBaselineIds: [], availabilityHeldIds: [] });
    });
    it("suppresses methodology-version-only grade changes", () => {
      const current: SafetySnapshot = {
        "usdc-circle": {
          grade: "C+",
          score: 61,
          ratingStatus: "rated",
          partialEvidence: null,
          methodologyVersion: "9.0",
        },
      };
      const previous: SafetySnapshot = {
        "usdc-circle": {
          grade: "B",
          score: 72,
          ratingStatus: "rated",
          partialEvidence: null,
          methodologyVersion: "9.1",
        },
      };

      const result = buildSafetyChanges(current, previous, () => "USDC");

      expect(result).toEqual({ changes: [], suppressedMethodologyChanges: 1, suppressedRuntimeAvailabilityChanges: 0, suppressedMinorSafetyChanges: 0, heldBaselineIds: [], availabilityHeldIds: [] });
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
            ratingStatus: currentAffected ? "not-rated" : "rated",
            partialEvidence: null,
            methodologyVersion: "9.0",
            operationallyAffected: currentAffected,
          },
        },
        {
          alpha: {
            grade: previousAffected ? "NR" : "A",
            score: previousAffected ? null : 85,
            ratingStatus: previousAffected ? "not-rated" : "rated",
            partialEvidence: null,
            methodologyVersion: "9.0",
            operationallyAffected: previousAffected,
          },
        },
        () => "ALPHA",
      );

      expect(result).toEqual({
        changes: [],
        suppressedMethodologyChanges: 0,
        suppressedRuntimeAvailabilityChanges: 0,
        suppressedMinorSafetyChanges: 0,
        heldBaselineIds: [],
        availabilityHeldIds: [],
      });
    });

    const ratedRow = (grade: string, score: number, reasonCodes: string[] | null = []) => ({
      grade, score, ratingStatus: "rated", partialEvidence: null, methodologyVersion: "10.25",
      v9Explain: { reasons: [], ...(reasonCodes ? { reasonCodes } : {}), bindingCap: null, weakestPillar: null, pillars: {} },
    }) as unknown as SafetySnapshot[string];

    it("derives availability codes from the V9 responsibility authority", () => {
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("missing-runtime-route-evidence")).toBe(true);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("runtime-bridge-materiality-unavailable")).toBe(true);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("missing-peg-input")).toBe(true);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("correlated-exit-routes")).toBe(false);
      // Reviewer-authored integration findings must still alert.
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("material-dependency-unavailable")).toBe(false);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("bounded-mechanism-review")).toBe(false);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("unsupported-same-notional-route")).toBe(false);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("material-bridge-supply-unmatched")).toBe(false);
      expect(SAFETY_RUNTIME_AVAILABILITY_REASON_CODES.has("missing-mint-authority")).toBe(false);
    });

    it("suppresses and holds a grade flip caused by a runtime availability code toggling", () => {
      const result = buildSafetyChanges(
        { iusd: ratedRow("D", 49, ["missing-runtime-route-evidence"]) },
        { iusd: ratedRow("B", 72) },
        () => "IUSD",
      );
      expect(result).toMatchObject({ changes: [], suppressedRuntimeAvailabilityChanges: 1, heldBaselineIds: ["iusd"] });
      expect(buildSafetyChanges(
        { iusd: ratedRow("B", 72) },
        { iusd: ratedRow("D", 49, ["missing-runtime-route-evidence"]) },
        () => "IUSD",
      ).suppressedRuntimeAvailabilityChanges).toBe(1);
    });

    it("treats a baseline without persisted reason codes as unknown, not toggled", () => {
      const result = buildSafetyChanges(
        { a: ratedRow("D", 45, ["missing-runtime-route-evidence"]) },
        { a: ratedRow("B", 72, null) },
        () => "A",
      );
      expect(result.changes).toHaveLength(1);
    });

    it("suppresses a grade flip when partial evidence appears or changes shape", () => {
      const partial = (pillars: string[]) => ({ ...ratedRow("C-", 50), partialEvidence: { pillars } }) as unknown as SafetySnapshot[string];
      expect(buildSafetyChanges({ wm: partial(["control"]) }, { wm: ratedRow("B", 70) }, () => "WM"))
        .toMatchObject({ changes: [], suppressedRuntimeAvailabilityChanges: 1 });
      expect(buildSafetyChanges({ wm: { ...partial(["exit"]), grade: "B" } as SafetySnapshot[string] }, { wm: partial(["control"]) }, () => "WM"))
        .toMatchObject({ changes: [], suppressedRuntimeAvailabilityChanges: 1 });
    });

    it("keeps a large move when the same availability code persists on both sides", () => {
      const codes = ["runtime-bridge-materiality-unavailable"];
      const result = buildSafetyChanges({ a: ratedRow("C", 55, codes) }, { a: ratedRow("B+", 76, codes) }, () => "A");
      expect(result.changes).toHaveLength(1);
    });

    it("suppresses one-notch moves but keeps drops into D or F", () => {
      const minor = buildSafetyChanges(
        { eurc: ratedRow("A-", 81), ybold: ratedRow("C+", 64) },
        { eurc: ratedRow("A", 83), ybold: ratedRow("C", 58) },
        (id) => id,
      );
      expect(minor.changes).toEqual([]);
      expect(minor.suppressedMinorSafetyChanges).toBe(2);

      const severe = buildSafetyChanges(
        { x: ratedRow("D", 45), y: ratedRow("F", 19), z: ratedRow("D", 47) },
        { x: ratedRow("C-", 50), y: ratedRow("D", 40), z: ratedRow("F", 20) },
        (id) => id,
      );
      // x: C- -> D and y: D -> F alert; z: F -> D is a one-notch upgrade.
      expect(severe.changes.map((change) => change.stablecoinId)).toEqual(["x", "y"]);
      expect(severe.suppressedMinorSafetyChanges).toBe(1);
    });

    describe("holdSuppressedSafetyBaselines", () => {
      it("keeps the last alerted row so one-notch steps still add up to an alert", () => {
        const start = { a: ratedRow("A", 83) };
        const step1 = { a: ratedRow("A-", 81) };
        const baseline1 = holdSuppressedSafetyBaselines(step1, start, 1_000);
        expect(baseline1.a!.grade).toBe("A");
        const step2 = { a: ratedRow("B+", 78) };
        expect(buildSafetyChanges(step2, baseline1, () => "A").changes).toHaveLength(1);
      });

      it("holds through an availability gap so the flip back is silent and a persisting drop still alerts", () => {
        const healthy = { iusd: ratedRow("C", 55) };
        const gap = { iusd: ratedRow("D", 49, ["missing-runtime-route-evidence"]) };
        const held = holdSuppressedSafetyBaselines(gap, healthy, 1_000);
        expect(held.iusd!.grade).toBe("C");
        // Input returns at the same grade: no change.
        expect(buildSafetyChanges(healthy, held, () => "IUSD").changes).toEqual([]);
        // Input returns but the grade really fell: alert against the held row.
        expect(buildSafetyChanges({ iusd: ratedRow("F", 20) }, held, () => "IUSD").changes).toHaveLength(1);
      });

      it("alerts once an availability-driven drop persists past the hold cap", () => {
        const healthy = { iusd: ratedRow("C", 55) };
        const gap = { iusd: ratedRow("D", 49, ["missing-runtime-route-evidence"]) };
        let baseline = holdSuppressedSafetyBaselines(gap, healthy, 1_000);
        expect(baseline.iusd!.heldSinceSec).toBe(1_000);
        baseline = holdSuppressedSafetyBaselines(gap, baseline, 1_000 + 3_600);
        expect(baseline.iusd!.heldSinceSec).toBe(1_000);
        expect(buildSafetyChanges(gap, baseline, () => "IUSD", 1_000 + 3_600).changes).toEqual([]);
        const late = 1_000 + SAFETY_AVAILABILITY_HOLD_MAX_SEC;
        expect(buildSafetyChanges(gap, baseline, () => "IUSD", late).changes).toHaveLength(1);
        // The emitted change advances the baseline and clears the hold.
        expect(holdSuppressedSafetyBaselines(gap, baseline, late).iusd!.heldSinceSec).toBeUndefined();
      });

      it("persists current rows unchanged when nothing is suppressed", () => {
        const current = { a: ratedRow("C", 55) };
        expect(holdSuppressedSafetyBaselines(current, { a: ratedRow("A", 83) }, 1_000)).toBe(current);
      });
    });

    it.each(["entering", "recovering"] as const)("uses an %s pipeline gap as a silent baseline", (transition) => {
      const rated: SafetySnapshot[string] = { grade: "A", score: 85, ratingStatus: "rated", partialEvidence: null, methodologyVersion: "10.01" };
      const gap: SafetySnapshot[string] = { grade: null, score: null, ratingStatus: "pipeline-gap", methodologyVersion: "10.01",
        partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"] } };
      expect(buildSafetyChanges(
        { alpha: transition === "entering" ? gap : rated },
        { alpha: transition === "entering" ? rated : gap },
        () => "ALPHA",
      )).toEqual({ changes: [], suppressedMethodologyChanges: 0, suppressedRuntimeAvailabilityChanges: 0, suppressedMinorSafetyChanges: 0, heldBaselineIds: [], availabilityHeldIds: [] });
    });

    it("suppresses a null grade even when its status is inconsistent", () => {
      const previous: SafetySnapshot = { alpha: { grade: "B", score: 72, ratingStatus: "rated", partialEvidence: null, methodologyVersion: null } };
      const current: SafetySnapshot = { alpha: { ...previous.alpha, grade: null } };
      expect(buildSafetyChanges(current, previous, () => "ALPHA").changes).toEqual([]);
      expect(buildSafetyChanges(previous, current, () => "ALPHA").changes).toEqual([]);
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
