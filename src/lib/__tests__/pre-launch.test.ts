import { describe, expect, it } from "vitest";
import { dateScore, formatFuzzyDate, getDriftStatus, parseFuzzyDate, parseFuzzyDeadline } from "../pre-launch";

describe("pre-launch fuzzy dates", () => {
  it("parses supported fuzzy date formats to deterministic period ends", () => {
    expect(parseFuzzyDate("2026")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseFuzzyDate("2026-05")?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
    expect(parseFuzzyDate("2026-05-27")?.toISOString()).toBe("2026-05-27T00:00:00.000Z");
    expect(parseFuzzyDate("2026-Q2")?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(parseFuzzyDate("2026-H1")?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(parseFuzzyDate("2026-H2")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("rejects unsupported or impossible fuzzy dates", () => {
    for (const value of ["2026-13", "2026-02-30", "2026-Q5", "2026-H3", "H1 2026"]) {
      expect(parseFuzzyDate(value)).toBeNull();
      expect(dateScore(value)).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("formats full, monthly, quarterly, and half-year dates", () => {
    expect(formatFuzzyDate("2026-05-27")).toBe("May 27, 2026");
    expect(formatFuzzyDate("2026-05")).toBe("May 2026");
    expect(formatFuzzyDate("2026-Q2")).toBe("Q2 2026");
    expect(formatFuzzyDate("2026-H1")).toBe("H1 2026");
  });

  it("sorts fuzzy dates chronologically using the representative period end", () => {
    const values = ["2026-H2", "2026-05-27", "2026-Q2", "2026-05", "2026"];
    expect([...values].sort((a, b) => dateScore(a) - dateScore(b))).toEqual([
      "2026-05-27",
      "2026-05",
      "2026-Q2",
      "2026-H2",
      "2026",
    ]);
  });
});

describe("pre-launch drift deadlines", () => {
  it.each(["2026-06-30", "2026-06", "2026-Q2", "2026-H1", "2026"])(
    "keeps %s in-window through its final UTC calendar day",
    (expectedLaunchDate) => {
      const end = parseFuzzyDate(expectedLaunchDate)!;
      const history = [{ date: "2025", setOn: "2025-01-01" }];
      expect(parseFuzzyDeadline(expectedLaunchDate)?.getTime()).toBe(end.getTime() + 86_400_000);
      for (const offset of [0, 12 * 3_600_000, 86_399_999]) {
        const nowMs = end.getTime() + offset;
        expect(getDriftStatus(history, expectedLaunchDate, nowMs)).toBe("pushed-once");
        expect(getDriftStatus([...history, ...history], expectedLaunchDate, nowMs)).toBe("pushed-multiple");
        expect(getDriftStatus(undefined, expectedLaunchDate, nowMs)).toBe("on-track");
        expect(getDriftStatus([], expectedLaunchDate, nowMs)).toBe("on-track");
      }
      const nowMs = end.getTime() + 86_400_000;
      for (const revisions of [undefined, [], history, [...history, ...history]]) {
        expect(getDriftStatus(revisions, expectedLaunchDate, nowMs)).toBe("overdue");
      }
    },
  );

  it("does not assign an overdue deadline to invalid or absent targets", () => {
    expect(parseFuzzyDeadline("2026-02-30")).toBeNull();
    expect(getDriftStatus(undefined, undefined, Date.UTC(2027, 0, 1))).toBe("on-track");
    expect(getDriftStatus([], "2026-02-30", Date.UTC(2027, 0, 1))).toBe("on-track");
  });
});
