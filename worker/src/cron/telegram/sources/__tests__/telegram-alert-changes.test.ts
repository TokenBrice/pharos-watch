import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import {
  applyDewsExitHysteresis,
  buildSafetyChanges,
  holdSuppressedSafetyBaselines,
  planDewsAlerts,
  reseedSafetyBaseline,
} from "../telegram-alert-changes";
import type { DewsCandidateSnapshot, DewsRow, DewsSnapshot, SafetySnapshot } from "../telegram-alert-snapshots";

const DWELL = TELEGRAM_ALERT_POLICY.safety.dwellSec;
const COOLDOWN = TELEGRAM_ALERT_POLICY.safety.downgradeCooldownSec;
const T0 = 1_000_000;

const ratedRow = (grade: string, score: number, extra: Partial<SafetySnapshot[string]> = {}) => ({
  grade, score, ratingStatus: "rated", partialEvidence: null, methodologyVersion: "10.26", ...extra,
}) as SafetySnapshot[string];

const noSuppression = {
  suppressedMethodologyChanges: 0,
  suppressedPendingDwellSafetyChanges: 0,
  suppressedMinorSafetyChanges: 0,
  suppressedUpgradeSafetyChanges: 0,
  suppressedCooldownSafetyChanges: 0,
};

/** Replays dispatch runs: detect against the baseline, then persist the next baseline. */
function runSafety(baseline: SafetySnapshot, current: SafetySnapshot, nowSec: number) {
  const summary = buildSafetyChanges(current, baseline, (id) => id.toUpperCase(), nowSec);
  return { summary, baseline: holdSuppressedSafetyBaselines(current, baseline, nowSec) };
}

describe("telegram alert change builders", () => {
  describe("buildSafetyChanges", () => {
    it("holds a severe downgrade until it has persisted for the dwell, then alerts once", () => {
      let baseline: SafetySnapshot = { a: ratedRow("B", 72) };
      const dropped = { a: ratedRow("C", 58) };

      let run = runSafety(baseline, dropped, T0);
      expect(run.summary.changes).toEqual([]);
      expect(run.summary.suppressedPendingDwellSafetyChanges).toBe(1);
      expect(run.baseline.a).toMatchObject({ grade: "B", pendingKind: "severe-downgrade", pendingSinceSec: T0 });

      run = runSafety(run.baseline, dropped, T0 + DWELL - 1);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.a!.pendingSinceSec).toBe(T0);

      run = runSafety(run.baseline, dropped, T0 + DWELL);
      expect(run.summary.changes).toEqual([
        { stablecoinId: "a", symbol: "A", oldGrade: "B", newGrade: "C", oldScore: 72, newScore: 58 },
      ]);
      baseline = run.baseline;
      expect(baseline.a).toMatchObject({ grade: "C", lastAlertedAtSec: T0 + DWELL });
      expect(baseline.a!.pendingSinceSec).toBeUndefined();

      expect(runSafety(baseline, dropped, T0 + DWELL + 1800).summary.changes).toEqual([]);
    });

    it("drops a flap that recovers inside the dwell and restarts the clock on the next drop", () => {
      const healthy = { iusd: ratedRow("C", 55) };
      const flap = { iusd: ratedRow("D", 49) };
      let run = runSafety(healthy, flap, T0);
      run = runSafety(run.baseline, healthy, T0 + 1800);
      expect(run.summary).toMatchObject({ changes: [], ...noSuppression });
      expect(run.baseline.iusd!.pendingSinceSec).toBeUndefined();

      run = runSafety(run.baseline, flap, T0 + 4 * 3600);
      run = runSafety(run.baseline, flap, T0 + 4 * 3600 + DWELL - 1);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.iusd!.pendingSinceSec).toBe(T0 + 4 * 3600);
    });

    it("keeps one dwell clock while the grade moves within the severe range and reports the latest grade", () => {
      let run = runSafety({ a: ratedRow("B", 72) }, { a: ratedRow("D", 45) }, T0);
      run = runSafety(run.baseline, { a: ratedRow("F", 20) }, T0 + DWELL);
      expect(run.summary.changes).toEqual([expect.objectContaining({ oldGrade: "B", newGrade: "F" })]);
    });

    it("treats a drop into D or F as severe at any size and one-notch drops above D as minor", () => {
      const result = buildSafetyChanges(
        { x: ratedRow("D", 45), y: ratedRow("F", 19), eurc: ratedRow("A-", 81) },
        {
          x: ratedRow("C-", 50, { pendingKind: "severe-downgrade", pendingSinceSec: T0 - DWELL }),
          y: ratedRow("D", 40, { pendingKind: "severe-downgrade", pendingSinceSec: T0 - DWELL }),
          eurc: ratedRow("A", 83),
        },
        (id) => id,
        T0,
      );
      expect(result.changes.map((change) => change.stablecoinId)).toEqual(["x", "y"]);
      expect(result.suppressedMinorSafetyChanges).toBe(1);
    });

    it("keeps the last alerted row through minor steps so they add up to a severe move", () => {
      let run = runSafety({ a: ratedRow("A", 83) }, { a: ratedRow("A-", 81) }, T0);
      expect(run.summary.suppressedMinorSafetyChanges).toBe(1);
      expect(run.baseline.a!.grade).toBe("A");
      run = runSafety(run.baseline, { a: ratedRow("B+", 78) }, T0 + 1800);
      expect(run.summary.suppressedPendingDwellSafetyChanges).toBe(1);
      run = runSafety(run.baseline, { a: ratedRow("B+", 78) }, T0 + 1800 + DWELL);
      expect(run.summary.changes).toEqual([expect.objectContaining({ oldGrade: "A", newGrade: "B+" })]);
    });

    it("never sends upgrades live and adopts a held upgrade as the new baseline after the dwell", () => {
      let run = runSafety({ a: ratedRow("D", 40) }, { a: ratedRow("B", 72) }, T0);
      expect(run.summary).toMatchObject({ changes: [], suppressedUpgradeSafetyChanges: 1 });
      expect(run.baseline.a).toMatchObject({ grade: "D", pendingKind: "upgrade", pendingSinceSec: T0 });
      run = runSafety(run.baseline, { a: ratedRow("B", 72) }, T0 + DWELL);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.a!.grade).toBe("B");
      expect(run.baseline.a!.pendingKind).toBeUndefined();
    });

    it("restarts the dwell when a pending upgrade turns into a severe downgrade", () => {
      let run = runSafety({ a: ratedRow("B", 72) }, { a: ratedRow("A", 85) }, T0);
      run = runSafety(run.baseline, { a: ratedRow("C", 58) }, T0 + DWELL);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.a).toMatchObject({ grade: "B", pendingKind: "severe-downgrade", pendingSinceSec: T0 + DWELL });
    });

    it("holds a second severe downgrade through the cooldown and sends it when the cooldown ends", () => {
      // B -> D alerted at T0; D -> F at T0 + 10h must not be lost.
      const alertedAt = T0;
      let run = runSafety({ a: ratedRow("D", 40, { lastAlertedAtSec: alertedAt }) }, { a: ratedRow("F", 20) }, alertedAt + 10 * 3600);
      run = runSafety(run.baseline, { a: ratedRow("F", 20) }, alertedAt + 10 * 3600 + DWELL);
      expect(run.summary).toMatchObject({ changes: [], suppressedCooldownSafetyChanges: 1 });
      expect(run.baseline.a).toMatchObject({
        grade: "D", lastAlertedAtSec: alertedAt, pendingKind: "severe-downgrade", pendingSinceSec: alertedAt + 10 * 3600,
      });
      run = runSafety(run.baseline, { a: ratedRow("F", 20) }, alertedAt + COOLDOWN);
      expect(run.summary.changes).toEqual([expect.objectContaining({ oldGrade: "D", newGrade: "F" })]);
      expect(run.baseline.a).toMatchObject({ grade: "F", lastAlertedAtSec: alertedAt + COOLDOWN });
    });

    it.each([
      ["a pipeline gap", { grade: null, score: null, ratingStatus: "pipeline-gap", partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: ["A"] }, methodologyVersion: "10.26" }],
      ["an operational quarantine", { grade: "NR", score: null, ratingStatus: "not-rated", partialEvidence: null, methodologyVersion: "10.26", operationallyAffected: true }],
    ])("keeps the pending dwell and cooldown clocks through %s", (_label, gapRow) => {
      let run = runSafety({ a: ratedRow("B", 72, { lastAlertedAtSec: T0 - COOLDOWN }) }, { a: ratedRow("D", 45) }, T0);
      run = runSafety(run.baseline, { a: gapRow as SafetySnapshot[string] }, T0 + 3600);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.a).toMatchObject({
        grade: "B", pendingKind: "severe-downgrade", pendingSinceSec: T0, lastAlertedAtSec: T0 - COOLDOWN,
      });
      run = runSafety(run.baseline, { a: ratedRow("D", 45) }, T0 + DWELL);
      expect(run.summary.changes).toEqual([expect.objectContaining({ oldGrade: "B", newGrade: "D" })]);
    });

    it.each(["same", "missing-current", "missing-previous"] as const)(
      "compares across %s methodology versions",
      (methodology) => {
        const result = buildSafetyChanges(
          { alpha: ratedRow("C", 58, { methodologyVersion: methodology === "missing-current" ? null : "9.0" }) },
          { alpha: ratedRow("A", 85, { methodologyVersion: methodology === "missing-previous" ? null : "9.0", pendingKind: "severe-downgrade", pendingSinceSec: T0 - DWELL }) },
          () => "ALPHA",
          T0,
        );
        expect(result.changes).toHaveLength(1);
      },
    );

    it("treats a first rating after NR as an upgrade, not a live severe downgrade", () => {
      const unrated: SafetySnapshot[string] = {
        grade: "NR", score: null, ratingStatus: "not-rated", partialEvidence: null, methodologyVersion: "10.26",
      };
      const rated = ratedRow("B", 70);

      // NR is the known unavailable rating (rank -1), so leaving it improves on
      // the same ladder the routing predicate uses; upgrades are never sent live.
      let run = runSafety({ alpha: unrated }, { alpha: rated }, T0);
      expect(run.summary).toMatchObject({
        changes: [], suppressedUpgradeSafetyChanges: 1, suppressedCooldownSafetyChanges: 0,
      });
      expect(run.baseline.alpha).toMatchObject({ grade: "NR", pendingKind: "upgrade", pendingSinceSec: T0 });

      run = runSafety(run.baseline, { alpha: rated }, T0 + DWELL);
      expect(run.summary.changes).toEqual([]);
      expect(run.baseline.alpha).toMatchObject({ grade: "B" });
      expect(run.baseline.alpha!.lastAlertedAtSec).toBeUndefined();

      // The silent upgrade did not spend the downgrade cooldown: a genuine
      // severe downgrade right after it still fires once its own dwell passes.
      const downgraded = { alpha: ratedRow("D", 44) };
      run = runSafety(run.baseline, downgraded, T0 + DWELL + 1800);
      expect(run.summary.changes).toEqual([]);
      run = runSafety(run.baseline, downgraded, T0 + 2 * DWELL + 1800);
      expect(run.summary.changes).toEqual([
        { stablecoinId: "alpha", symbol: "ALPHA", oldGrade: "B", newGrade: "D", oldScore: 70, newScore: 44 },
      ]);
    });

    it("does not turn score-only movement or a new coin into a grade transition", () => {
      const result = buildSafetyChanges(
        { alpha: ratedRow("A", 89), newcomer: ratedRow("B", 70) },
        { alpha: ratedRow("A", 85) },
        () => "ALPHA",
        T0,
      );
      expect(result).toMatchObject({ changes: [], ...noSuppression });
    });

    it("emits nothing when the current snapshot is unavailable", () => {
      expect(buildSafetyChanges(null, { alpha: ratedRow("A", 85) }, () => "ALPHA", T0))
        .toMatchObject({ changes: [], ...noSuppression });
    });

    it("suppresses methodology-version-only grade changes and advances the baseline", () => {
      const current = { usdc: ratedRow("C+", 61, { methodologyVersion: "9.0" }) };
      const previous = { usdc: ratedRow("B", 72, { methodologyVersion: "9.1" }) };
      expect(buildSafetyChanges(current, previous, () => "USDC", T0))
        .toMatchObject({ changes: [], ...noSuppression, suppressedMethodologyChanges: 1 });
      expect(holdSuppressedSafetyBaselines(current, previous, T0).usdc!.grade).toBe("C+");
    });

    it.each([
      ["quarantine", true, false],
      ["recovery", false, true],
    ])("suppresses an operational %s grade transition", (_label, currentAffected, previousAffected) => {
      const row = (affected: boolean) => affected
        ? { grade: "NR", score: null, ratingStatus: "not-rated", partialEvidence: null, methodologyVersion: "9.0", operationallyAffected: true } as SafetySnapshot[string]
        : ratedRow("A", 85, { operationallyAffected: false });
      expect(buildSafetyChanges({ alpha: row(currentAffected) }, { alpha: row(previousAffected) }, () => "ALPHA", T0))
        .toMatchObject({ changes: [], ...noSuppression });
    });

    it.each(["entering", "recovering"] as const)("uses an %s pipeline gap as a silent baseline", (transition) => {
      const rated = ratedRow("A", 85);
      const gap: SafetySnapshot[string] = { grade: null, score: null, ratingStatus: "pipeline-gap", methodologyVersion: "10.26",
        partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["backing", "exit"], causes: ["A"] } };
      expect(buildSafetyChanges(
        { alpha: transition === "entering" ? gap : rated },
        { alpha: transition === "entering" ? rated : gap },
        () => "ALPHA",
        T0,
      )).toMatchObject({ changes: [], ...noSuppression });
    });

    it("suppresses a null grade even when its status is inconsistent", () => {
      const previous: SafetySnapshot = { alpha: ratedRow("B", 72) };
      const current: SafetySnapshot = { alpha: { ...previous.alpha, grade: null } };
      expect(buildSafetyChanges(current, previous, () => "ALPHA", T0).changes).toEqual([]);
      expect(buildSafetyChanges(previous, current, () => "ALPHA", T0).changes).toEqual([]);
    });
  });

  describe("holdSuppressedSafetyBaselines", () => {
    it("carries the cooldown clock onto an advanced row and strips stale pending fields", () => {
      const persisted = holdSuppressedSafetyBaselines(
        { a: ratedRow("B", 73, { pendingKind: "upgrade", pendingSinceSec: 1 }) },
        { a: ratedRow("B", 72, { lastAlertedAtSec: 5, pendingKind: "upgrade", pendingSinceSec: 1 }) },
        T0,
      );
      expect(persisted.a).toEqual(ratedRow("B", 73, { lastAlertedAtSec: 5 }));
    });
  });

  describe("reseedSafetyBaseline", () => {
    const previous = {
      a: ratedRow("B", 72, { pendingKind: "severe-downgrade", pendingSinceSec: T0, lastAlertedAtSec: T0 - COOLDOWN }),
      b: ratedRow("A", 85, { lastAlertedAtSec: T0 - 20 }),
    };
    const current = { a: ratedRow("D", 45), b: ratedRow("A", 86), c: ratedRow("C", 55) };

    it("carries pending rows and cooldown clocks across a comparable reseed", () => {
      const seeded = reseedSafetyBaseline(current, previous, true);
      expect(seeded.a).toBe(previous.a);
      expect(seeded.b).toEqual(ratedRow("A", 86, { lastAlertedAtSec: T0 - 20 }));
      expect(seeded.c).toEqual(current.c);
      // The resumed dwell still fires on schedule.
      expect(buildSafetyChanges(current, seeded, (id) => id, T0 + DWELL).changes).toHaveLength(1);
    });

    it("takes current rows silently across an incomparable identity (methodology release)", () => {
      const seeded = reseedSafetyBaseline(current, previous, false);
      expect(seeded.a).toEqual(ratedRow("D", 45, { lastAlertedAtSec: T0 - COOLDOWN }));
      expect(buildSafetyChanges(current, seeded, (id) => id, T0 + DWELL)).toMatchObject({ changes: [], ...noSuppression });
    });
  });

  describe("planDewsAlerts", () => {
    const row = (band: string, score: number, computedAt = T0): DewsRow =>
      ({ stablecoin_id: "alpha", score, band, signals_json: null, computed_at: computedAt });
    const plan = (
      rows: DewsRow[],
      alertable: DewsSnapshot,
      observed: DewsSnapshot,
      candidates: DewsCandidateSnapshot = {},
      nowSec = T0,
    ) => planDewsAlerts(rows, alertable, observed, candidates, () => "ALPHA", nowSec);

    it("holds an escalation until a second DEWS computation confirms it", () => {
      const first = plan([row("WARNING", 60, T0)], { alpha: "ALERT" }, { alpha: "ALERT" });
      expect(first.changes).toEqual([]);
      expect(first.suppressedPendingDewsEscalations).toBe(1);
      expect(first.nextAlertable).toEqual({ alpha: "ALERT" });
      expect(first.nextObserved).toEqual({ alpha: "WARNING" });

      // Another dispatch run over the same computation does not count twice.
      const sameComputation = plan([row("WARNING", 60, T0)], first.nextAlertable, first.nextObserved, first.nextCandidates);
      expect(sameComputation.changes).toEqual([]);

      const second = plan([row("WARNING", 61, T0 + 1800)], first.nextAlertable, first.nextObserved, first.nextCandidates);
      expect(second.changes).toEqual([expect.objectContaining({ oldBand: "ALERT", newBand: "WARNING", score: 61 })]);
      expect(second.nextAlertable).toEqual({ alpha: "WARNING" });
      expect(second.nextCandidates).toEqual({});
    });

    it("drops a one-computation spike (eMXN 23 to 59 to 23)", () => {
      const spike = plan([row("WARNING", 59, T0)], {}, { alpha: "WATCH" });
      expect(spike.changes).toEqual([]);
      const back = plan([row("WATCH", 23, T0 + 1800)], spike.nextAlertable, spike.nextObserved, spike.nextCandidates);
      expect(back.changes).toEqual([]);
      expect(back.nextCandidates.alpha).toEqual({ quietSinceSec: T0 });
    });

    it("leaves a band only once the score falls more than the margin below its lower bound", () => {
      // WARNING starts at 56; the exit margin keeps 51..55 in WARNING.
      expect(applyDewsExitHysteresis(54, "ALERT", "WARNING")).toBe("WARNING");
      expect(applyDewsExitHysteresis(51, "ALERT", "WARNING")).toBe("WARNING");
      expect(applyDewsExitHysteresis(50, "ALERT", "WARNING")).toBe("ALERT");
      // Steps down one band at a time from DANGER.
      expect(applyDewsExitHysteresis(52, "ALERT", "DANGER")).toBe("WARNING");
      expect(applyDewsExitHysteresis(62, "DANGER", "WARNING")).toBe("DANGER");
      expect(applyDewsExitHysteresis(54, "ALERT", undefined)).toBe("ALERT");

      // 54 <-> 62 straddling the ALERT/WARNING boundary stays in WARNING: no re-alert.
      const held = plan([row("ALERT", 54, T0 + 1800)], { alpha: "WARNING" }, { alpha: "WARNING" });
      expect(held.nextObserved).toEqual({ alpha: "WARNING" });
      expect(held.changes).toEqual([]);
      expect(held.suppressedDewsDeescalations).toBe(0);
    });

    it("keeps counting a pending escalation that eases but stays above the alerted band", () => {
      const first = plan([row("DANGER", 80, T0)], {}, { alpha: "CALM" });
      expect(first.changes).toEqual([]);
      const eased = plan([row("WARNING", 60, T0 + 1800)], first.nextAlertable, first.nextObserved, first.nextCandidates);
      expect(eased.suppressedDewsDeescalations).toBe(0);
      expect(eased.changes).toEqual([expect.objectContaining({ oldBand: "CALM", newBand: "WARNING" })]);
      expect(eased.nextAlertable).toEqual({ alpha: "WARNING" });
    });

    it("drops de-escalations within the alertable range and advances the alertable baseline", () => {
      const result = plan([row("WARNING", 60)], { alpha: "DANGER" }, { alpha: "DANGER" });
      expect(result.changes).toEqual([]);
      expect(result.suppressedDewsDeescalations).toBe(1);
      expect(result.nextAlertable).toEqual({ alpha: "WARNING" });
    });

    it("labels a rise from below the alertable range from the observed band", () => {
      const result = plan(
        [row("WARNING", 60, T0 + 1800)],
        { alpha: "DANGER" },
        { alpha: "CALM" },
        { alpha: { computedAt: T0, computations: 1 } },
      );
      expect(result.changes).toEqual([expect.objectContaining({ oldBand: "CALM", newBand: "WARNING" })]);
    });

    it("still dedupes a return to the same alert band after a short dip", () => {
      expect(plan([row("DANGER", 80)], { alpha: "DANGER" }, { alpha: "WATCH" }).changes).toEqual([]);
    });

    it("clears the alertable baseline after the quiet window so a later alert states the real prior band", () => {
      const quiet = TELEGRAM_ALERT_POLICY.dews.baselineResetQuietSec;
      const calm = plan([row("WATCH", 20)], { alpha: "DANGER" }, { alpha: "WATCH" }, { alpha: { quietSinceSec: T0 } }, T0 + quiet - 1);
      expect(calm.nextAlertable).toEqual({ alpha: "DANGER" });
      const reset = plan([row("WATCH", 20)], { alpha: "DANGER" }, { alpha: "WATCH" }, { alpha: { quietSinceSec: T0 } }, T0 + quiet);
      expect(reset.nextAlertable).toEqual({});
      expect(reset.resetDewsBaselines).toBe(1);
      expect(reset.nextCandidates).toEqual({ alpha: { quietSinceSec: T0 } });
    });
  });
});
