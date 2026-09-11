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
    expect(derive({ lastEventAt: undefined })).toBe(97);
    expect(derive({ pegScore: 84, lastEventAt: CLOCK_SEC - pegHistoryWindowSec - 1 })).toBe(97);
  });

  it("uses a strict window boundary", () => {
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec })).toBe(84);
    expect(derive({ lastEventAt: CLOCK_SEC - pegHistoryWindowSec + 1 })).toBe(84);
  });

  it("does not manufacture evidence or disturb current adverse histories", () => {
    expect(derive({ pegScore: null })).toBeNull();
    expect(derive({ pegScore: 99 })).toBe(99);
    expect(derive({ pegScore: 0, activeDepeg: true, lastEventAt: null })).toBe(0);
    expect(derive({ pegScore: 37, activeDepeg: null, lastEventAt: null })).toBe(37);
  });

  it("rejects fractional and non-finite clocks independently of other valid inputs", () => {
    for (const clockSec of [CLOCK_SEC + 0.5, NaN, Infinity]) {
      expect(() => derive({ clockSec })).toThrow(/clockSec/);
    }
  });

  it("rejects non-positive and fractional windows", () => {
    for (const windowSec of [0, -1, 0.5, Infinity]) {
      expect(() => derive({ windowSec })).toThrow(/windowSec/);
    }
  });

  it("rejects invalid quiet floors while accepting both endpoints", () => {
    for (const quietHistoryFloor of [NaN, Infinity, -1, 101]) {
      expect(() => derive({ quietHistoryFloor })).toThrow(/quietHistoryFloor/);
    }
    expect(derive({ pegScore: 0, quietHistoryFloor: 0 })).toBe(0);
    expect(derive({ pegScore: 0, quietHistoryFloor: 100 })).toBe(100);
  });
});
