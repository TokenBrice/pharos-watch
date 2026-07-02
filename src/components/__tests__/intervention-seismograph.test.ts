import { describe, expect, it } from "vitest";
import type { BlacklistSummaryResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types/market";
import { buildQuarterPoints } from "@/components/freezewatch/intervention-seismograph";

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
