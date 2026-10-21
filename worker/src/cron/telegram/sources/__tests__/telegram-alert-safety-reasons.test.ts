import { describe, expect, it } from "vitest";
import type { SafetyChange } from "../../../../telegram/common/alerts-formatting";
import {
  addSafetyReasonLines,
  buildV9SafetyReason,
} from "../telegram-alert-safety-reasons";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

const pillars = {
  backing: {
    score: 82,
    evidenceLevel: "adequate",
    freshness: "current",
  },
  exit: {
    score: 70,
    evidenceLevel: "adequate",
    freshness: "current",
  },
  control: {
    score: 80,
    evidenceLevel: "adequate",
    freshness: "current",
  },
};

function row(
  overrides: Partial<SafetySnapshot[string]> = {},
): SafetySnapshot[string] {
  return {
    grade: "B",
    ratingStatus: "rated",
    partialEvidence: null,
    score: 78,
    methodologyVersion: "9.0",
    v9Explain: {
      bindingCap: null,
      reasons: [],
      weakestPillar: { pillar: "exit", score: 70 },
      pillars,
    },
    ...overrides,
  };
}

describe("canonical V9 Telegram safety reasons", () => {
  it("prefers a newly binding cap", () => {
    expect(buildV9SafetyReason(
      row({
        grade: "C",
        score: 58,
        v9Explain: {
          bindingCap: {
            kind: "exit",
            limit: 60,
            reason: "Issuer discretion limits primary exit",
          },
          reasons: [],
          weakestPillar: { pillar: "exit", score: 58 },
          pillars,
        },
      }) as Required<SafetySnapshot[string]>,
    )).toBe("Reason: Issuer discretion limits primary exit.");
  });

  it("describes the largest pillar movement matching the rating direction", () => {
    const previous = row();
    const current = row({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: null,
        reasons: [{
          code: "exit-capacity-stress",
          message: "Exit capacity deteriorated.",
        }],
        weakestPillar: { pillar: "exit", score: 41 },
        pillars: {
          ...pillars,
          exit: {
            score: 41,
            evidenceLevel: "limited",
            freshness: "current",
          },
        },
      },
    });
    const change: SafetyChange = {
      stablecoinId: "coin",
      symbol: "COIN",
      oldGrade: "B",
      newGrade: "C",
      oldScore: 78,
      newScore: 58,
    };

    expect(addSafetyReasonLines(
      [change],
      { coin: current },
      { coin: previous },
    )[0]?.contextLine).toBe(
      "Reason: Exit score fell from 70 to 41. Exit measures how easily holders can redeem or sell near $1.",
    );
  });

  it("explains an upgrade that lands on a new cap by the pillar that moved", () => {
    const previous = row({ grade: "D", score: 30, v9Explain: { bindingCap: null, reasons: [], weakestPillar: { pillar: "exit", score: 35 }, pillars: { ...pillars, exit: { ...pillars.exit, score: 35 } } } });
    const current = row({
      grade: "C-",
      score: 40,
      v9Explain: {
        bindingCap: { kind: "parent", limit: 40, reason: "A child cannot rate above its required parent." },
        reasons: [],
        weakestPillar: { pillar: "exit", score: 48 },
        pillars: { ...pillars, exit: { ...pillars.exit, score: 48 } },
      },
    });
    expect(buildV9SafetyReason(current as Required<SafetySnapshot[string]>, previous as Required<SafetySnapshot[string]>)).toBe(
      "Reason: Exit score rose from 35 to 48. Exit measures how easily holders can redeem or sell near $1.",
    );
  });

  it("names a newly binding parent cap in plain language on a downgrade", () => {
    const current = row({
      grade: "D",
      score: 30,
      v9Explain: {
        bindingCap: { kind: "parent", limit: 30, reason: "A child cannot rate above its required parent." },
        reasons: [],
        weakestPillar: { pillar: "exit", score: 70 },
        pillars,
      },
    });
    expect(buildV9SafetyReason(current as Required<SafetySnapshot[string]>, row() as Required<SafetySnapshot[string]>))
      .toBe("Reason: Capped at the Safety Score of the coin it is built on.");
  });
});
