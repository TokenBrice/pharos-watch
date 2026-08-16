import { describe, expect, it } from "vitest";
import { buildBandStripCells } from "@/components/regime-bar";

describe("buildBandStripCells", () => {
  it("keeps completed UTC days oldest-first and excludes the current day", () => {
    const computedAt = 1_772_401_200;
    const todayMidnight = 1_772_323_200;
    const yesterday = todayMidnight - 86_400;
    const twoDaysAgo = yesterday - 86_400;

    const cells = buildBandStripCells([
      { date: todayMidnight, band: "STEADY" },
      { date: yesterday, band: "TREMOR" },
      { date: twoDaysAgo, band: "CALM" },
    ], computedAt);

    expect(cells.slice(0, 3)).toEqual([
      { date: twoDaysAgo, band: "CALM" },
      { date: yesterday, band: "TREMOR" },
      null,
    ]);
  });
});
