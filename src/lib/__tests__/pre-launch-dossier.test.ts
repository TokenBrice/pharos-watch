import { describe, expect, it } from "vitest";
import {
  buildLaunchPathModel,
  buildLaunchVerdict,
  computeLaunchClock,
  describeLaunchWindow,
  describeTargetHistory,
  formatPhaseLabel,
  parseFuzzyRange,
  sortMilestonesNewestFirst,
} from "@/lib/pre-launch-dossier";

const iso = (date: Date | undefined) => date?.toISOString().slice(0, 10);
const at = (day: string) => Date.parse(`${day}T12:00:00Z`);

describe("parseFuzzyRange", () => {
  it.each([
    ["2026-03-22", "2026-03-22", "2026-03-23", "day"],
    ["2026-10", "2026-10-01", "2026-11-01", "month"],
    ["2026-Q4", "2026-10-01", "2027-01-01", "quarter"],
    ["2027-H1", "2027-01-01", "2027-07-01", "half"],
    ["2026", "2026-01-01", "2027-01-01", "year"],
  ])("reads %s as a whole UTC window", (raw, start, end, precision) => {
    const range = parseFuzzyRange(raw);
    expect(iso(range?.start)).toBe(start);
    expect(iso(range?.end)).toBe(end);
    expect(range?.precision).toBe(precision);
  });

  it("rejects malformed dates instead of inventing one", () => {
    expect(parseFuzzyRange("2026-02-30")).toBeNull();
    expect(parseFuzzyRange("soon")).toBeNull();
  });
});

describe("computeLaunchClock", () => {
  const coin = { announcedDate: "2026-09-23", expectedLaunchDate: "2026-Q4" };

  it("counts down to, through and past the target window", () => {
    const before = computeLaunchClock(coin, at("2026-09-25"));
    expect(before).toMatchObject({ windowState: "before", windowDays: 6, drift: "on-track", daysSinceAnnounced: 2 });
    expect(describeLaunchWindow(before, "quarter")).toBe("Window opens in 6 d");

    const open = computeLaunchClock(coin, at("2026-12-30"));
    expect(open.windowState).toBe("open");
    expect(describeLaunchWindow(open, "quarter")).toBe("Window open · closes in 2 d");

    const passed = computeLaunchClock(coin, at("2027-01-11"));
    expect(passed).toMatchObject({ windowState: "passed", windowDays: 10, drift: "overdue" });
  });

  it("never invents a target, drift or age the registry does not carry", () => {
    const clock = computeLaunchClock({}, at("2026-10-19"));
    expect(clock).toEqual({
      windowState: null,
      windowDays: null,
      drift: null,
      daysSinceAnnounced: null,
      announcedIsApproximate: false,
    });
    expect(describeLaunchWindow(clock, null)).toBeNull();
  });

  it("reads a retired-only history through the shared no-current-target vocabulary", () => {
    const history = [{ date: "2026-Q2", setOn: "2026-03-22" }];
    expect(computeLaunchClock({ dateHistory: history }, at("2026-10-19")).drift).toBe("no-current-target");
    expect(computeLaunchClock({ dateHistory: history, expectedLaunchDate: "2027" }, at("2026-10-19")).drift).toBe("pushed-once");
  });

  it("marks an age counted from a month-precision announcement as approximate", () => {
    const clock = computeLaunchClock({ announcedDate: "2026-01" }, at("2026-01-31"));
    expect(clock.daysSinceAnnounced).toBe(30);
    expect(clock.announcedIsApproximate).toBe(true);
  });
});

describe("verdict and history", () => {
  it("builds the verdict from structured fields", () => {
    expect(
      buildLaunchVerdict({
        launchPhase: "testnet",
        expectedLaunchDate: "2027",
        dateHistory: [{ date: "2026-Q4", setOn: "2026-06-01" }, { date: "2026-H2", setOn: "2026-02-01" }],
        milestones: [{ date: "2026-01-05", type: "announcement", title: "A" }],
        announcedDate: "2025-12",
      }),
    ).toBe("Testnet phase, targeting 2027 after 2 target moves; 1 milestone logged since Dec 2025.");
    expect(buildLaunchVerdict({ dateHistory: [{ date: "2026-Q2", setOn: "2026-03-22" }] })).toBe(
      "No published phase, earlier target retired, none set; no activity logged yet.",
    );
    expect(buildLaunchVerdict({})).toBe("No published phase, no target date; no activity logged yet.");
    // A launched row reads its launch, never a stale target.
    expect(buildLaunchVerdict({ launchPhase: "launched", launchDate: "2026-10-15", expectedLaunchDate: "2026-Q3" })).toBe(
      "Launched Oct 15, 2026, awaiting admissible data; no activity logged yet.",
    );
    expect(formatPhaseLabel({})).toBe("Unphased");
  });

  it("counts only milestones logged since the announcement period opened", () => {
    expect(
      buildLaunchVerdict({
        launchPhase: "announced",
        announcedDate: "2026-07-01",
        milestones: [
          { date: "2026-04-03", type: "regulatory", title: "A" },
          { date: "2026-07-15", type: "announcement", title: "B" },
        ],
      }),
    ).toBe("Announced phase, no target date; 1 milestone logged since Jul 1, 2026.");
    // A month- or quarter-precision milestone keeps its whole window, so one
    // that overlaps the announcement month is still in period.
    expect(
      buildLaunchVerdict({
        launchPhase: "announced",
        announcedDate: "2026-06-15",
        milestones: [
          { date: "2026-06", type: "regulatory", title: "A" },
          { date: "2026-Q2", type: "partnership", title: "B" },
          { date: "2026-Q1", type: "partnership", title: "C" },
        ],
      }),
    ).toBe("Announced phase, no target date; 2 milestones logged since Jun 15, 2026.");
    expect(
      buildLaunchVerdict({
        launchPhase: "announced",
        announcedDate: "2026-07-01",
        milestones: [{ date: "2026-Q2", type: "regulatory", title: "A" }],
      }),
    ).toBe("Announced phase, no target date; no milestones logged since Jul 1, 2026.");
  });

  it("lists retired targets oldest first and milestones newest first", () => {
    expect(
      describeTargetHistory([{ date: "2026-Q4", setOn: "2026-06-01" }, { date: "2026-H2", setOn: "2026-02-01" }]).map((row) => row.target),
    ).toEqual(["H2 2026", "Q4 2026"]);
    expect(
      sortMilestonesNewestFirst([
        { date: "2026-01", type: "milestone", title: "old" },
        { date: "2026-03-02", type: "delay", title: "new" },
      ]).map((m) => m.title),
    ).toEqual(["new", "old"]);
  });
});

describe("buildLaunchPathModel", () => {
  const coin = {
    announcedDate: "2025-06-23",
    expectedLaunchDate: "2026",
    dateHistory: [{ date: "2026-07", setOn: "2026-09-06" }],
    milestones: [
      { date: "2025-06-23", type: "announcement" as const, title: "Announced" },
      { date: "2025-06-23", type: "partnership" as const, title: "Partner" },
      { date: "2026-08-06", type: "delay" as const, title: "Window missed" },
    ],
  };

  it("places every element inside the plot and clusters same-day milestones", () => {
    const model = buildLaunchPathModel(coin, at("2026-10-19"));
    const pcts = [
      model.todayPct,
      model.announcedPct!,
      model.current!.startPct,
      model.current!.endPct,
      ...model.retired.flatMap((band) => [band.startPct, band.endPct]),
      ...model.markers.map((marker) => marker.pct),
      ...model.ticks.map((tick) => tick.pct),
    ];
    for (const pct of pcts) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
    expect(model.markers).toHaveLength(2);
    expect(model.markers[0].items).toHaveLength(2);
    expect(model.markers[1].hasDelay).toBe(true);
    expect(model.retired[0]).toMatchObject({ label: "Jul 2026" });
    expect(model.current?.label).toBe("2026");
    expect(model.todayPct).toBeGreaterThan(model.current!.startPct);
    expect(model.ticks.some((tick) => tick.major && tick.label === "2026")).toBe(true);
    expect(model.ticks[0]).toMatchObject({ label: "Q3 2025", withYear: true, major: false });
  });

  it("dates a short axis on its first tick and clusters by the given gap", () => {
    const model = buildLaunchPathModel({ announcedDate: "2026-09-23", expectedLaunchDate: "2026-10" }, at("2026-10-19"));
    expect(model.ticks[0].label).toBe("Oct 2026");
    const near = { ...coin, milestones: [coin.milestones[0], { date: "2025-07-10", type: "milestone" as const, title: "Near" }] };
    expect(buildLaunchPathModel(near, at("2026-10-19"), 1).markers).toHaveLength(2);
    expect(buildLaunchPathModel(near, at("2026-10-19"), 5).markers).toHaveLength(1);
  });

  it("extends a target-less axis to today", () => {
    const model = buildLaunchPathModel({ announcedDate: "2026-01-06" }, at("2026-10-19"));
    expect(model.current).toBeNull();
    expect(model.todayPct).toBeGreaterThan(90);
  });
});
