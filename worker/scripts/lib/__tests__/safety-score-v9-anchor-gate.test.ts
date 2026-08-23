import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { describe, expect, it } from "vitest";
import {
  SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1,
  evaluateSafetyScoreV9AnchorGate,
  type V9AnchorContract,
  type V9AnchorGateCard,
  type V9AnchorGateReport,
  type V9RelativeRule,
} from "../safety-score-v9-anchor-gate";

function gradeForScore(score: number | null): V9Grade {
  if (score === null) return "NR";
  return (
    V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds.find((threshold) => score >= threshold.minScore)
      ?.grade ?? "F"
  );
}

function card(id: string, score: number | null, archetype: string | null = "fiat-cash"): V9AnchorGateCard {
  return { id, score, grade: gradeForScore(score), archetype };
}

/** Synthetic fully-coherent set: every ruled anchor exactly satisfied or better. */
function passingCards(): V9AnchorGateCard[] {
  return [
    card("usdc-circle", 90),
    card("bold-liquity", 84, "cdp"),
    card("usdt-tether", 87),
    card("dai-makerdao", 72, "cdp"),
    card("sdai-sky", 70, "wrapper"),
    card("sbold-k3-capital", 70, "wrapper"),
    card("lusd-liquity", 76, "cdp"),
    card("pyusd-paypal", 71),
    card("pusd-polymarket", 64),
    card("usdg-paxos", 70),
    card("ausd-agora", 70),
    card("rlusd-ripple", 70),
    card("zchf-frankencoin", 70),
    card("fxusd-f-x-protocol", 70),
    card("buidl-blackrock", 70, "tbill"),
    card("usdd-tron-dao-reserve", 39, "cdp"),
    card("u-united-stables", 32),
    card("usdai-usd-ai", 39, "rwa-credit-fund"),
    card("eurs-stasis", 20),
    card("mim-abracadabra", 0, "cdp"),
    card("tusd-trueusd", 54),
  ];
}

function withScore(cards: V9AnchorGateCard[], id: string, score: number): V9AnchorGateCard[] {
  return cards.map((entry) => (entry.id === id ? { ...entry, score, grade: gradeForScore(score) } : entry));
}

function withoutId(cards: V9AnchorGateCard[], id: string): V9AnchorGateCard[] {
  return cards.filter((entry) => entry.id !== id);
}

/**
 * 2026-08-23 publication clock — inside the pyusd-paypal time box, so these
 * cases see the eased contract that shipped with owner ruling D-J.
 */
const CAPTURE_CLOCK_SEC = 1787500014;

function evaluateAtCaptureClock(
  input: Omit<Parameters<typeof evaluateSafetyScoreV9AnchorGate>[0], "asOfSec">,
): V9AnchorGateReport {
  return evaluateSafetyScoreV9AnchorGate({ ...input, asOfSec: CAPTURE_CLOCK_SEC });
}

function verdict(report: V9AnchorGateReport, rule: string) {
  const found = report.verdicts.find((entry) => entry.rule === rule);
  if (!found) throw new Error(`Report is missing verdict for rule ${rule}`);
  return found;
}

describe("evaluateSafetyScoreV9AnchorGate", () => {
  it("passes a fully coherent anchor set", () => {
    const report = evaluateAtCaptureClock({ cards: passingCards() });
    expect(report.decision).toBe("gate-passed");
    expect(report.verdicts.every((entry) => entry.status === "pass")).toBe(true);
    expect(report.appliedRulings).toEqual([]);
    expect(report.pendingRulings).toEqual([]);
  });

  it("fails an anchor below its policy-derived threshold", () => {
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "bold-liquity", 82) });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "anchor:bold-liquity");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("anchor-below-threshold");
    expect(entry.required).toBe("score ≥ 83 (A)");
  });

  it("no longer pins the superseded PYUSD ≥ PUSD relative rule", () => {
    // Owner ruling 2026-07-20: the inversion is honest measurement (PYUSD wins
    // backing +11.4 and control +10; pUSD wins exit +21.96), so the rule was
    // removed rather than tuned around. See the contract's supersession note.
    const relativeRules: readonly V9RelativeRule[] = SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1.relative;
    expect(
      relativeRules.some(
        (rule) => rule.kind === "pair" && rule.id === "pyusd-paypal" && rule.overId === "pusd-polymarket",
      ),
    ).toBe(false);
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "pusd-polymarket", 72) });
    expect(report.decision).toBe("gate-passed");
  });

  it("still evaluates pair rules in both directions (machinery retained for future pairs)", () => {
    const contract: V9AnchorContract = {
      ...SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1,
      relative: [{ kind: "pair", id: "pyusd-paypal", overId: "pusd-polymarket", label: "test pair rule" }],
    };
    const rule = "relative:pyusd-paypal>=pusd-polymarket";

    const passing = evaluateAtCaptureClock({ cards: passingCards(), contract });
    expect(passing.decision).toBe("gate-passed");
    expect(verdict(passing, rule).status).toBe("pass");
    expect(verdict(passing, rule).observed).toBe("71 vs 64");

    const inverted = evaluateAtCaptureClock({
      cards: withScore(passingCards(), "pusd-polymarket", 72),
      contract,
    });
    expect(inverted.decision).toBe("no-go");
    const entry = verdict(inverted, rule);
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("relative-inversion");
    expect(entry.observed).toBe("71 vs 72");

    const missing = evaluateAtCaptureClock({
      cards: withoutId(passingCards(), "pusd-polymarket"),
      contract,
    });
    expect(verdict(missing, rule).code).toBe("asset-missing");
  });

  it("fails USDC dominance when another centralized fiat asset outscores it", () => {
    const cards = [...passingCards(), card("wusd-synthetic", 91, "tbill")];
    const report = evaluateAtCaptureClock({ cards });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("relative-inversion");
    expect(entry.detail).toContain("wusd-synthetic 91");
    // Non-fiat archetypes do not enter the comparison set.
    expect(verdict(report, "anchor:usdc-circle").status).toBe("pass");
  });

  it("fails a max-score adverse pin above its bound", () => {
    // The production contract retired its last max-score pin (U released
    // 2026-08-08 after pre-drifting in production), so the rule kind is
    // exercised through an injected contract, mirroring the pair-rule test.
    const contract: V9AnchorContract = {
      ...SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1,
      adverse: [{ kind: "max-score", id: "u-united-stables", maxScore: 32, label: "U adverse pin" }],
    };
    const report = evaluateAtCaptureClock({
      cards: withScore(passingCards(), "u-united-stables", 33),
      contract,
    });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "adverse:u-united-stables");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("adverse-above-bound");
    expect(entry.required).toBe("score ≤ 32");
  });

  it("fails a max-grade adverse pin once the score leaves the grade band", () => {
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "eurs-stasis", 40) });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "adverse:eurs-stasis");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("adverse-above-bound");
    expect(entry.required).toBe("grade ≤ F (score < 40)");
  });

  it("fails explicitly when an anchor asset is missing from the card set", () => {
    const report = evaluateAtCaptureClock({ cards: withoutId(passingCards(), "bold-liquity") });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "anchor:bold-liquity");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("asset-missing");
  });

  it("treats exactly-at-threshold scores as passing", () => {
    const cards = [
      // USDC must also meet the relative fiat-dominance rule once the USDT
      // anchor is pinned at the higher A+ floor.
      card("usdc-circle", 87),
      card("bold-liquity", 83, "cdp"),
      card("usdt-tether", 87),
      card("dai-makerdao", 70, "cdp"),
      card("sdai-sky", 65, "wrapper"),
      card("sbold-k3-capital", 65, "wrapper"),
      card("lusd-liquity", 75, "cdp"),
      card("pyusd-paypal", 70),
      card("pusd-polymarket", 70),
      card("usdg-paxos", 60),
      card("ausd-agora", 60),
      card("rlusd-ripple", 70),
      card("zchf-frankencoin", 60),
      card("fxusd-f-x-protocol", 70),
      card("usdd-tron-dao-reserve", 39, "cdp"),
      card("u-united-stables", 32),
      card("usdai-usd-ai", 39, "rwa-credit-fund"),
      card("eurs-stasis", 39),
      card("mim-abracadabra", 39, "cdp"),
      card("tusd-trueusd", 54),
    ];
    const report = evaluateAtCaptureClock({ cards });
    expect(report.decision).toBe("gate-passed");
  });

  it("applies the current production-calibration thresholds as the defaults", () => {
    const cards = withScore(
      withScore(
        withScore(withScore(passingCards(), "usdt-tether", 87), "ausd-agora", 62),
        "zchf-frankencoin",
        64,
      ),
      "usdg-paxos",
      61,
    );
    const report = evaluateAtCaptureClock({ cards });
    expect(report.decision).toBe("gate-passed");
    expect(verdict(report, "anchor:usdt-tether").required).toBe("score ≥ 87 (A+)");
    expect(verdict(report, "anchor:dai-makerdao").required).toBe("score ≥ 70 (B)");
    expect(verdict(report, "anchor:sdai-sky").required).toBe("score ≥ 65 (B-)");
    expect(verdict(report, "anchor:sbold-k3-capital").required).toBe("score ≥ 65 (B-)");
    expect(verdict(report, "anchor:ausd-agora").required).toBe("score ≥ 60 (C+)");
    expect(verdict(report, "anchor:zchf-frankencoin").required).toBe("score ≥ 60 (C+)");
    expect(report.verdicts.some((entry) => entry.rule === "anchor:usdg-paxos")).toBe(false);

    const usdtBelow = evaluateAtCaptureClock({
      cards: withScore(cards, "usdt-tether", 86),
    });
    expect(usdtBelow.decision).toBe("no-go");
    expect(verdict(usdtBelow, "anchor:usdt-tether").status).toBe("fail");

    const below = evaluateAtCaptureClock({ cards: withScore(cards, "ausd-agora", 59) });
    expect(below.decision).toBe("no-go");
    expect(verdict(below, "anchor:ausd-agora").status).toBe("fail");
  });

  it("rejects an unknown pending-ruling id", () => {
    expect(() => evaluateAtCaptureClock({ cards: passingCards(), applyRulings: ["D-Z"] })).toThrow(
      "Unknown anchor-gate pending ruling: D-Z",
    );
  });

  it("resolves every declared anchor threshold from the candidate policy", () => {
    const report = evaluateAtCaptureClock({ cards: passingCards() });
    const thresholds = new Map(report.gradeThresholds.map((entry) => [entry.grade, entry.minScore]));
    expect(thresholds.get("A")).toBe(83);
    expect(thresholds.get("A-")).toBe(80);
    expect(thresholds.get("B+")).toBe(75);
    expect(thresholds.get("B")).toBe(70);
    expect(thresholds.get("C+")).toBe(60);
    expect(report.verdicts).toHaveLength(
      SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1.anchors.length +
        SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1.relative.length +
        SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1.adverse.length,
    );
  });

  describe("time-boxed anchor amendments (owner ruling D-J)", () => {
    const PYUSD_RESTORE_SEC = 1823558400; // 2027-10-15T00:00:00Z

    it("applies the eased grade while the box is open", () => {
      // 69 clears B- (65) but not B (70): the easement is what passes it.
      const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "pyusd-paypal", 69) });
      expect(verdict(report, "anchor:pyusd-paypal").status).toBe("pass");
      expect(verdict(report, "anchor:pyusd-paypal").required).toBe("score ≥ 65 (B-)");
      expect(report.decision).toBe("gate-passed");
    });

    it("restores the stricter grade the instant the box expires, with no edit", () => {
      const report = evaluateSafetyScoreV9AnchorGate({
        cards: withScore(passingCards(), "pyusd-paypal", 69),
        asOfSec: PYUSD_RESTORE_SEC,
      });
      expect(verdict(report, "anchor:pyusd-paypal").required).toBe("score ≥ 70 (B)");
      expect(verdict(report, "anchor:pyusd-paypal").status).toBe("fail");
      expect(report.decision).toBe("no-go");
    });

    it("keeps the easement one second before expiry", () => {
      const report = evaluateSafetyScoreV9AnchorGate({
        cards: withScore(passingCards(), "pyusd-paypal", 69),
        asOfSec: PYUSD_RESTORE_SEC - 1,
      });
      expect(verdict(report, "anchor:pyusd-paypal").required).toBe("score ≥ 65 (B-)");
      expect(verdict(report, "anchor:pyusd-paypal").status).toBe("pass");
    });

    it("fails closed when no clock can resolve a time-boxed anchor", () => {
      // Omitting the clock must not silently keep an expired easement alive.
      expect(() => evaluateSafetyScoreV9AnchorGate({ cards: passingCards() })).toThrow(
        "Anchor gate needs asOfSec to resolve time-boxed anchor(s): pyusd-paypal",
      );
    });

    it("holds lusd-liquity at its amended B- without a time box", () => {
      // Ruling D-I is open-ended: 65 passes, and it stays eased after D-J lapses.
      for (const asOfSec of [CAPTURE_CLOCK_SEC, PYUSD_RESTORE_SEC]) {
        const report = evaluateSafetyScoreV9AnchorGate({
          cards: withScore(passingCards(), "lusd-liquity", 65),
          asOfSec,
        });
        expect(verdict(report, "anchor:lusd-liquity").required).toBe("score ≥ 65 (B-)");
        expect(verdict(report, "anchor:lusd-liquity").status).toBe("pass");
      }
    });
  });
});
