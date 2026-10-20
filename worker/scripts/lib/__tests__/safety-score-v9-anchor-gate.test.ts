import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { describe, expect, it } from "vitest";
import {
  evaluateSafetyScoreV9AnchorGate,
  type V9AnchorContract,
  type V9AnchorGateCard,
  type V9AnchorGateReport,
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
function passingCards(overrides: Record<string, number> = {}): V9AnchorGateCard[] {
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
  ].map((entry) => entry.id in overrides ? card(entry.id, overrides[entry.id], entry.archetype) : entry);
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
  it("fails an anchor below its policy-derived threshold", () => {
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "bold-liquity", 82) });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "anchor:bold-liquity");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("anchor-below-threshold");
    expect(entry.required).toBe("score ≥ 83 (A)");
  });

  it("matches the pinned baseline verdict JSON for every live rule kind", () => {
    const report = evaluateAtCaptureClock({ cards: passingCards() });
    expect(report.decision).toBe("gate-passed");
    expect(report.verdicts.filter((entry) => [
      "anchor:bold-liquity", "relative:usdc-circle>=archetype(fiat-cash|tbill)", "adverse:eurs-stasis",
    ].includes(entry.rule))).toEqual([
      {
        rule: "anchor:bold-liquity", kind: "anchor", status: "pass", code: "pass",
        observed: "84 (A)", required: "score ≥ 83 (A)",
        detail: "bold-liquity meets the A-anchor threshold",
      },
      {
        rule: "relative:usdc-circle>=archetype(fiat-cash|tbill)", kind: "relative", status: "pass", code: "pass",
        observed: "usdc-circle 90", required: "usdc-circle score ≥ every other fiat-cash/tbill asset score",
        detail: "usdc-circle 90 is not below any other fiat-cash/tbill asset",
      },
      {
        rule: "adverse:eurs-stasis", kind: "adverse", status: "pass", code: "pass",
        observed: "20 (F)", required: "grade ≤ F (score < 40)",
        detail: "eurs-stasis stays pinned at 20",
      },
    ]);
  });

  it("fails USDC dominance when another centralized fiat asset outscores it", () => {
    const cards = [...passingCards(), card("wusd-synthetic", 91, "tbill")];
    const report = evaluateAtCaptureClock({ cards });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("relative-inversion");
    expect(entry.detail).toContain("wusd-synthetic 91");
  });

  it("excludes higher-scoring CDP and unknown-archetype peers from fiat dominance", () => {
    const report = evaluateAtCaptureClock({
      cards: [...passingCards(), card("cdp-peer", 99, "cdp"), card("unknown-peer", 100, null)],
    });
    expect(verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)").status).toBe("pass");
    expect(report.decision).toBe("gate-passed");
  });

  it("fails a max-grade adverse pin once the score leaves the grade band", () => {
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "eurs-stasis", 40) });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "adverse:eurs-stasis");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("adverse-above-bound");
    expect(entry.required).toBe("grade ≤ F (score < 40)");
  });

  it("resolves the max-grade boundary from the supplied policy", () => {
    const policy = structuredClone(V9_CANDIDATE_POLICY_V1);
    policy.policy.semantic.formula.gradeThresholds =
      policy.policy.semantic.formula.gradeThresholds.map((entry) =>
        entry.grade === "D" ? { ...entry, minScore: 45 } : entry);
    const report = evaluateAtCaptureClock({ cards: withScore(passingCards(), "eurs-stasis", 44), policy });
    expect(report.decision).toBe("gate-passed");
    expect(verdict(report, "adverse:eurs-stasis").required).toBe("grade ≤ F (score < 45)");
    const above = evaluateAtCaptureClock({ cards: withScore(passingCards(), "eurs-stasis", 45), policy });
    expect(verdict(above, "adverse:eurs-stasis").code).toBe("adverse-above-bound");
  });

  it("keeps archetype rule identities and violation details stable across card order", () => {
    const cards = [...passingCards(), card("z-peer", 92, "tbill"), card("a-peer", 91)];
    const contract: V9AnchorContract = {
      schemaVersion: 1, anchors: [], adverse: [],
      relative: [{ kind: "archetype-set", id: "usdc-circle", archetypes: ["tbill", "fiat-cash"], label: "leader" }],
    };
    const report = evaluateAtCaptureClock({ cards, contract });
    expect(report).toEqual(evaluateAtCaptureClock({ cards: [...cards].reverse(), contract }));
    const entry = verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)");
    expect(entry.detail).toBe("usdc-circle 90 is outscored by: a-peer 91, z-peer 92");
  });

  it("fails explicitly when an anchor asset is missing from the card set", () => {
    const report = evaluateAtCaptureClock({ cards: withoutId(passingCards(), "bold-liquity") });
    expect(report.decision).toBe("no-go");
    const entry = verdict(report, "anchor:bold-liquity");
    expect(entry.status).toBe("fail");
    expect(entry.code).toBe("asset-missing");
  });

  it("treats exactly-at-threshold scores as passing", () => {
    const cards = passingCards({
      "usdc-circle": 87, "bold-liquity": 83, "usdt-tether": 87,
      "dai-makerdao": 70, "sdai-sky": 65, "sbold-k3-capital": 65,
      "lusd-liquity": 65, "pyusd-paypal": 65, "ausd-agora": 60,
      "rlusd-ripple": 70, "zchf-frankencoin": 60, "fxusd-f-x-protocol": 70,
      "eurs-stasis": 39,
    });
    const report = evaluateAtCaptureClock({ cards });
    expect(report.decision).toBe("gate-passed");
  });

  it("applies the current production-calibration thresholds as the defaults", () => {
    const cards = passingCards({ "usdt-tether": 87, "ausd-agora": 62, "zchf-frankencoin": 64, "usdg-paxos": 61 });
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

  it("changes the anchor decision when the supplied policy raises its grade threshold", () => {
    const cards = passingCards();
    expect(evaluateAtCaptureClock({ cards }).decision).toBe("gate-passed");
    const policy = structuredClone(V9_CANDIDATE_POLICY_V1);
    policy.policy.semantic.formula.gradeThresholds =
      policy.policy.semantic.formula.gradeThresholds.map((entry) =>
        entry.grade === "A" ? { ...entry, minScore: 85 } : entry);
    const report = evaluateAtCaptureClock({ cards, policy });
    expect(report.decision).toBe("no-go");
    expect(verdict(report, "anchor:bold-liquity").code).toBe("anchor-below-threshold");
  });

  it("rejects a policy missing the anchor's selected grade", () => {
    const policy = structuredClone(V9_CANDIDATE_POLICY_V1);
    policy.policy.semantic.formula.gradeThresholds =
      policy.policy.semantic.formula.gradeThresholds.filter((entry) => entry.grade !== "A");
    expect(() => evaluateAtCaptureClock({ cards: passingCards(), policy })).toThrow(
      "Policy carries no grade threshold for A",
    );
  });

  it("fails closed for missing, unrated and pipeline-gap required assets in every live rule kind", () => {
    const cases: Array<{ contract: V9AnchorContract; rule: string; cards: V9AnchorGateCard[] }> = [
      {
        contract: { schemaVersion: 1, anchors: [{ id: "required", minGrade: "A", label: "anchor" }], relative: [], adverse: [] },
        rule: "anchor:required", cards: [card("required", null)],
      },
      {
        contract: { schemaVersion: 1, anchors: [], adverse: [], relative: [{ kind: "archetype-set", id: "required", archetypes: ["fiat-cash"], label: "leader" }] },
        rule: "relative:required>=archetype(fiat-cash)", cards: [card("required", null), card("peer", 80)],
      },
      {
        contract: { schemaVersion: 1, anchors: [], relative: [], adverse: [{ kind: "max-grade", id: "required", maxGrade: "F", label: "pin" }] },
        rule: "adverse:required", cards: [card("required", null)],
      },
    ];
    for (const { contract, rule, cards } of cases) {
      for (const ratingStatus of ["not-rated", "pipeline-gap"] as const) {
        const report = evaluateAtCaptureClock({
          contract, cards: cards.map((entry) => entry.id === "required" ? { ...entry, ratingStatus } : entry),
        });
        expect(report.decision).toBe("no-go");
        expect(verdict(report, rule).code).toBe(ratingStatus === "pipeline-gap" ? "asset-pipeline-gap" : "asset-not-rated");
      }
      const missing = evaluateAtCaptureClock({ contract, cards: withoutId(cards, "required") });
      expect(missing.decision).toBe("no-go");
      expect(verdict(missing, rule).code).toBe("asset-missing");
    }
  });

  it("ignores unrated optional comparison peers", () => {
    const report = evaluateAtCaptureClock({ cards: [...passingCards(), card("unrated-peer", null)] });
    expect(report.decision).toBe("gate-passed");
    expect(verdict(report, "relative:usdc-circle>=archetype(fiat-cash|tbill)").status).toBe("pass");
  });

  it("rejects conflicting duplicate identities regardless of order", () => {
    for (const scores of [[90, 10], [10, 90]]) {
      expect(() => evaluateAtCaptureClock({
        cards: [...withoutId(passingCards(), "usdc-circle"), ...scores.map((score) => card("usdc-circle", score))],
      })).toThrow("Anchor gate received duplicate card id: usdc-circle");
    }
  });

  describe("time-boxed anchor amendments (owner ruling D-J)", () => {
    const PYUSD_RESTORE_SEC = 1823558400; // 2027-10-15T00:00:00Z

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

  });
});
