import { describe, expect, it } from "vitest";
import type { SafetyChange } from "../../lib/telegram/alerts";
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
      "Reason: Exit pillar fell from 70 to 41.",
    );
  });
});
