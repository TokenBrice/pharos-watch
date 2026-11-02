import { describe, expect, it } from "vitest";
import { buildUpcomingPegCoinEntries } from "../peg-hub-content";

describe("buildUpcomingPegCoinEntries", () => {
  it("marks launched-awaiting-data coins apart from upcoming entries", () => {
    const entries = buildUpcomingPegCoinEntries([
      {
        id: "alpha-pre",
        name: "Alpha",
        symbol: "ALP",
        launchPhase: "testnet",
        expectedLaunchDate: "2026-12-01",
        launchDate: undefined,
      },
      {
        id: "beta-live",
        name: "Beta",
        symbol: "BET",
        launchPhase: "launched",
        expectedLaunchDate: undefined,
        launchDate: "2026-10-01",
      },
    ]);

    expect(entries.map((entry) => [entry.id, entry.launched])).toEqual([
      ["alpha-pre", false],
      ["beta-live", true],
    ]);
  });
});
