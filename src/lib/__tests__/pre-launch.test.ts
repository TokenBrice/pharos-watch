import { describe, expect, it } from "vitest";
import {
  DRIFT_STATUS_BADGE,
  DRIFT_STATUS_LABEL,
  dateScore,
  getDriftStatus,
  parseFuzzyDate,
  parseFuzzyDeadline,
  resolveDriftDisplay,
  selectPreLaunchClockView,
} from "../pre-launch";

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
});

describe("pre-launch clock view", () => {
  const pushed = [{ date: "2026-03", setOn: "2026-01-01" }];
  const coins = [
    { id: "expired", expectedLaunchDate: "2026-Q2" },
    { id: "pushed", expectedLaunchDate: "2026-Q4", dateHistory: pushed },
    { id: "delayed", expectedLaunchDate: "2026-08", dateHistory: [...pushed, ...pushed] },
    { id: "untargeted", dateHistory: pushed },
    { id: "fresh", expectedLaunchDate: "2027" },
  ];

  it("counts slipped coins and never picks an overdue target as soonest", () => {
    const view = selectPreLaunchClockView(coins, Date.parse("2026-07-15T00:00:00Z"));
    expect(view.overdue).toBe(1);
    expect(view.pushed).toBe(2);
    expect(view.slipped).toBe(3);
    expect(view.soonest?.id).toBe("delayed");
    expect(view.driftById.get("expired")).toBe("overdue");
    expect(view.driftById.get("fresh")).toBe("on-track");
    expect(view.nextDeadlineMs).toBe(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("has no soonest target once every target has expired", () => {
    const view = selectPreLaunchClockView(coins, Date.parse("2028-01-01T00:00:00Z"));
    expect(view.soonest).toBeNull();
    expect(view.nextDeadlineMs).toBeNull();
    expect(view.overdue).toBe(4);
    expect(view.slipped).toBe(4);
  });
});

describe("drift display", () => {
  it("shows a pushed coin with no current target as a neutral No current target", () => {
    expect(resolveDriftDisplay("pushed-once", undefined)).toBe("no-current-target");
    expect(resolveDriftDisplay("pushed-multiple", undefined)).toBe("no-current-target");
    expect(DRIFT_STATUS_LABEL["no-current-target"]).toBe("No current target");
    expect(DRIFT_STATUS_BADGE["no-current-target"]).not.toMatch(/amber|red|state-warn|state-danger/);
  });

  it("passes every other status through unchanged", () => {
    expect(resolveDriftDisplay("pushed-once", "2026-Q4")).toBe("pushed-once");
    expect(resolveDriftDisplay("pushed-multiple", "2026-Q4")).toBe("pushed-multiple");
    expect(resolveDriftDisplay("overdue", "2026-Q2")).toBe("overdue");
    expect(resolveDriftDisplay("on-track", undefined)).toBe("on-track");
  });

  it("never counts a coin without a current target as slipped", () => {
    const view = selectPreLaunchClockView([{ id: "n", dateHistory: [{ date: "2026-Q1", setOn: "2025-06-01" }] }], 0);
    expect(view.driftById.get("n")).toBe("no-current-target");
    expect(view.slipped).toBe(0);
    expect(view.pushed).toBe(0);
  });
});
