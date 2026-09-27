// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { EVENT_CHART_COLORS, EVENT_LABELS } from "@shared/lib/classification";
import { describe, expect, it } from "vitest";
import type { BlacklistSummaryResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types/market";
import { buildQuarterPoints, InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";

type QuarterlyEventPoint =
  BlacklistSummaryResponse["stats"]["perCoinQuarterlyEventTypes"][BlacklistStablecoin][number];

function makeStats(
  overrides: Partial<Record<BlacklistStablecoin, QuarterlyEventPoint[]>>,
): BlacklistSummaryResponse["stats"] {
  return {
    perCoinQuarterlyEventTypes: Object.fromEntries(
      BLACKLIST_STABLECOINS.map((symbol) => [symbol, overrides[symbol] ?? []]),
    ),
  } as BlacklistSummaryResponse["stats"];
}

describe("buildQuarterPoints", () => {
  it("sorts quarter labels chronologically and merges matching quarters", () => {
    const points = buildQuarterPoints(
      makeStats({
        USDC: [
          { quarter: "Q1 '23", blacklist: 3, unblacklist: 0, destroy: 0 },
          { quarter: "Q4 '22", blacklist: 1, unblacklist: 0, destroy: 0 },
        ],
        USDT: [
          { quarter: "Q2 '17", blacklist: 2, unblacklist: 0, destroy: 0 },
          { quarter: "Q4 '22", blacklist: 0, unblacklist: 1, destroy: 4 },
          { quarter: "Q1 '26", blacklist: 5, unblacklist: 0, destroy: 0 },
        ],
      }),
    );

    expect(points.map((point) => point.quarter)).toEqual([
      "Q2 '17",
      "Q4 '22",
      "Q1 '23",
      "Q1 '26",
    ]);
    expect(points.find((point) => point.quarter === "Q4 '22")).toMatchObject({
      blacklist: 1,
      unblacklist: 1,
      destroy: 4,
      total: 6,
    });
  });
});

describe("InterventionSeismograph", () => {
  it("pairs each stacked count with its semantic label and color without changing layer order", () => {
    render(createElement(InterventionSeismograph, {
      stats: makeStats({ USDC: [{ quarter: "Q1 '26", blacklist: 3, unblacklist: 1, destroy: 2 }] }),
      chart: [],
      isLoading: false,
    }));

    const chart = screen.getByRole("img", { name: "Quarterly intervention seismograph" });
    const titles = [...chart.querySelectorAll("rect title")];
    const counts = { blacklist: 3, unblacklist: 1, destroy: 2 };
    for (const [index, key] of (["destroy", "blacklist", "unblacklist"] as const).entries()) {
      expect(titles[index].textContent).toBe(`Q1 '26 · ${EVENT_LABELS[key]}: ${counts[key]}`);
      expect(titles[index].parentElement?.getAttribute("fill")).toBe(EVENT_CHART_COLORS[key]);
      const legendSwatch = screen.getByText(EVENT_LABELS[key]).querySelector("span") as HTMLElement;
      const expectedSwatch = document.createElement("span");
      expectedSwatch.style.backgroundColor = EVENT_CHART_COLORS[key];
      expect(legendSwatch.style.backgroundColor).toBe(expectedSwatch.style.backgroundColor);
    }
  });
});
