import { describe, expect, it } from "vitest";
import { deriveV9WindowedPegScore } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const CLOCK_SEC = 1_800_000_000;
const { pegHistoryWindowSec, pegQuietHistoryFloor } = V9_CANDIDATE_POLICY_V1.policy.semantic.formula;

function derive(overrides: Partial<Parameters<typeof deriveV9WindowedPegScore>[0]> = {}) {
  return deriveV9WindowedPegScore({
    pegScore: 84,
    activeDepeg: false,
    lastEventAt: null,
    clockSec: CLOCK_SEC,
    windowSec: pegHistoryWindowSec,
    quietHistoryFloor: pegQuietHistoryFloor,
    ...overrides,
  });
}

describe("R5 V9-only 36-month peg-window proxy", () => {
  it("pins the matrix-verified policy bound", () => {
    expect(pegHistoryWindowSec).toBe(Math.ceil(3 * 365.25 * 86_400));
    expect(pegQuietHistoryFloor).toBe(97);
  });

  it("floors inactive legacy penalties after a null or older-than-window event", () => {
    expect(derive({ pegScore: 93, lastEventAt: null })).toBe(97);
    expect(derive({ pegScore: 84, lastEventAt: CLOCK_SEC - pegHistoryWindowSec - 1 })).toBe(97);
  });

  it("uses a strict window boundary", () => {
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec })).toBe(84);
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec + 1 })).toBe(84);
  });

  it("does not manufacture evidence or disturb current adverse histories", () => {
    expect(derive({ pegScore: null })).toBeNull();
    expect(derive({ pegScore: 99 })).toBe(99);
    expect(derive({ pegScore: 0, activeDepeg: true, lastEventAt: CLOCK_SEC - 10 })).toBe(0); // MIM/EURS shape
    expect(derive({ pegScore: 37, activeDepeg: null, lastEventAt: null })).toBe(37);
  });
});
