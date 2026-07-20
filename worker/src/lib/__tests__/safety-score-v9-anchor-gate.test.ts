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
    card("usdt-tether", 80),
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

function verdict(report: V9AnchorGateReport, rule: string) {
  const found = report.verdicts.find((entry) => entry.rule === rule);
  if (!found) throw new Error(`Report is missing verdict for rule ${rule}`);
  return found;
}

describe("evaluateSafetyScoreV9AnchorGate", () => {
  it("passes a fully coherent anchor set", () => {
    const report = evaluateSafetyScoreV9AnchorGate({ cards: passingCards() });
    expect(report.decision).toBe("gate-passed");
    expect(report.verdicts.every((entry) => entry.status === "pass")).toBe(true);
    expect(report.appliedRulings).toEqual([]);
    expect(report.pendingRulings).toEqual([]);
  });

  it("fails an anchor below its policy-derived threshold", () => {
    const report = evaluateSafetyScoreV9AnchorGate({ cards: withScore(passingCards(), "bold-liquity", 82) });
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
    const report = evaluateSafetyScoreV9AnchorGate({ cards: withScore(passingCards(), "pusd-polymarket", 72) });
    expect(report.decision).toBe("gate-passed");
  });

  it("still evaluates pair rules in both directions (machinery retained for future pairs)", () => {
    const contract: V9AnchorContract = {
      ...SAFETY_SCORE_V9_ANCHOR_CONTRACT_V1,
      relative: [{ kind: "pair", id: "pyusd-paypal", overId: "pusd-polymarket", label: "test pair rule" }],
    };
    const rule = "relative:pyusd-paypal>=pusd-polymarket";

    const passing = evaluateSafetyScoreV9AnchorGate({ cards: passingCards(), contract });
    expect(passing.decision).toBe("gate-passed");
    expect(verdict(passing, rule).status).toBe("pass");
    expect(verdict(passing, rule).observed).toBe("71 vs 64");

    const inverted = evaluateSafetyScoreV9AnchorGate({
      cards: withScore(passingCards(), "pusd-polymarket", 72),
      contract,
    });
    expect(inverted.decision).toBe("no-go");
    const entry = verdict(inverted, rule);
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("relative-inversion");
    expect(entry.observed).toBe("71 vs 72");

    const missing = evaluateSafetyScoreV9AnchorGate({
      cards: withoutId(passingCards(), "pusd-polymarket"),
      contract,
    });
    expect(verdict(missing, rule).code).toBe("asset-missing");
  });

  it("fails USDC dominance when another centralized fiat asset outscores it", () => {
    const cards = [...passingCards(), card("wusd-synthetic", 91, "tbill")];
    const report = evaluateSafetyScoreV9AnchorGate({ cards });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("relative-inversion");
    expect(entry.detail).toContain("wusd-synthetic 91");
    // Non-fiat archetypes do not enter the comparison set.
    expect(verdict(report, "anchor:usdc-circle").status).toBe("pass");
  });

  it("fails a max-score adverse pin above its bound", () => {
    const report = evaluateSafetyScoreV9AnchorGate({
      cards: withScore(passingCards(), "usdd-tron-dao-reserve", 40),
    });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "adverse:usdd-tron-dao-reserve");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("adverse-above-bound");
    expect(entry.required).toBe("score ≤ 39");
  });

  it("fails a max-grade adverse pin once the score leaves the grade band", () => {
    const report = evaluateSafetyScoreV9AnchorGate({ cards: withScore(passingCards(), "eurs-stasis", 40) });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "adverse:eurs-stasis");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("adverse-above-bound");
    expect(entry.required).toBe("grade ≤ F (score < 40)");
  });

  it("fails explicitly when an anchor asset is missing from the card set", () => {
    const report = evaluateSafetyScoreV9AnchorGate({ cards: withoutId(passingCards(), "bold-liquity") });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "anchor:bold-liquity");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("asset-missing");
  });

  it("treats exactly-at-threshold scores as passing", () => {
    const cards = [
      card("usdc-circle", 83),
      card("bold-liquity", 83, "cdp"),
      card("usdt-tether", 70),
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
    const report = evaluateSafetyScoreV9AnchorGate({ cards });
    expect(report.decision).toBe("gate-passed");
  });

  it("applies the ruled D-F/D-G/D-H/D-I thresholds as the defaults", () => {
    const cards = withScore(
      withScore(
        withScore(withScore(passingCards(), "usdt-tether", 72), "ausd-agora", 62),
        "zchf-frankencoin",
        64,
      ),
      "usdg-paxos",
      61,
    );
    const report = evaluateSafetyScoreV9AnchorGate({ cards });
    expect(report.decision).toBe("gate-passed");
    expect(verdict(report, "anchor:usdt-tether").required).toBe("score ≥ 70 (B)");
    expect(verdict(report, "anchor:ausd-agora").required).toBe("score ≥ 60 (C+)");
    expect(verdict(report, "anchor:zchf-frankencoin").required).toBe("score ≥ 60 (C+)");
    expect(verdict(report, "anchor:usdg-paxos").required).toBe("score ≥ 60 (C+)");

    const below = evaluateSafetyScoreV9AnchorGate({ cards: withScore(cards, "ausd-agora", 59) });
    expect(below.decision).toBe("no-go");
    expect(verdict(below, "anchor:ausd-agora").status).toBe("fail");
  });

  it("rejects an unknown pending-ruling id", () => {
    expect(() => evaluateSafetyScoreV9AnchorGate({ cards: passingCards(), applyRulings: ["D-Z"] })).toThrow(
      "Unknown anchor-gate pending ruling: D-Z",
    );
  });

  it("resolves every declared anchor threshold from the candidate policy", () => {
    const report = evaluateSafetyScoreV9AnchorGate({ cards: passingCards() });
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
});
