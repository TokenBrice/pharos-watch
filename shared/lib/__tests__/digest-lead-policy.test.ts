import { describe, it, expect } from "vitest";
import {
  computeLeadStreak,
  decideCriticalLeadSeverity,
  MAX_CONSECUTIVE_HARD_LEADS,
} from "../digest-lead-policy";

const USX = "depeg:usx-dforce:active";
const OTHER = "depeg:other:active";

describe("computeLeadStreak", () => {
  it("counts consecutive leads from the newest edition backwards", () => {
    expect(computeLeadStreak([USX, USX, OTHER, USX], USX)).toEqual({ consecutive: 2, inWindow: 3 });
  });

  it("breaks the consecutive count on any other lead", () => {
    expect(computeLeadStreak([OTHER, USX, USX], USX)).toEqual({ consecutive: 0, inWindow: 2 });
  });

  it("only counts window occurrences within the quota window", () => {
    const history = [OTHER, OTHER, OTHER, OTHER, OTHER, OTHER, OTHER, USX, USX, USX];
    expect(computeLeadStreak(history, USX)).toEqual({ consecutive: 0, inWindow: 0 });
  });

  it("treats null and missing meta as non-matching", () => {
    expect(computeLeadStreak([null, undefined, USX], USX)).toEqual({ consecutive: 0, inWindow: 1 });
  });
});

describe("decideCriticalLeadSeverity", () => {
  const base = { symbol: "USX", severityBps: -5783, previousSeverityBps: -5783 };

  it("hard-leads a newly critical event", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 6,
      streak: { consecutive: 0, inWindow: 0 },
    });
    expect(decision.severity).toBe("hard");
  });

  it("demotes an unchanged ongoing critical after the consecutive quota", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 26 * 24,
      streak: { consecutive: MAX_CONSECUTIVE_HARD_LEADS, inWindow: MAX_CONSECUTIVE_HARD_LEADS },
    });
    expect(decision.severity).toBe("soft");
  });

  it("demotes an old unchanged critical even without a streak (chronic, not news)", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 26 * 24,
      streak: { consecutive: 0, inWindow: 0 },
    });
    expect(decision.severity).toBe("soft");
  });

  it("a material worsening re-qualifies regardless of quota", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 26 * 24,
      severityBps: -6300,
      previousSeverityBps: -5700,
      streak: { consecutive: 5, inWindow: 5 },
    });
    expect(decision.severity).toBe("hard");
  });

  it("a sub-threshold drift does not re-qualify", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 26 * 24,
      severityBps: -5900,
      previousSeverityBps: -5700,
      streak: { consecutive: 2, inWindow: 3 },
    });
    expect(decision.severity).toBe("soft");
  });

  it("a new event that exhausted its quota is demoted until it moves", () => {
    const decision = decideCriticalLeadSeverity({
      ...base,
      ageHours: 40,
      streak: { consecutive: 2, inWindow: 2 },
    });
    expect(decision.severity).toBe("soft");
  });
});
