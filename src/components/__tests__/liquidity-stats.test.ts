import { describe, expect, it } from "vitest";
import { buildProtocolBreakdown } from "@/components/liquidity-stats";

describe("buildProtocolBreakdown", () => {
  it("caps the protocol legend at 10 entries by grouping everything after the top 9", () => {
    const { displayEntries, total } = buildProtocolBreakdown({
      curve: 1_500,
      raydium: 990,
      "uniswap-v3": 850,
      uniswap: 670,
      pancakeswap: 560,
      quickswap: 440,
      fluid: 250,
      orca: 195,
      "sunswap-v3": 176,
      aerodrome: 154,
      balancer: 120,
    });

    expect(total).toBe(5_905);
    expect(displayEntries).toEqual([
      ["curve", 1_500],
      ["raydium", 990],
      ["uniswap-v3", 850],
      ["uniswap", 670],
      ["pancakeswap", 560],
      ["quickswap", 440],
      ["fluid", 250],
      ["orca", 195],
      ["sunswap-v3", 176],
      ["_other", 274],
    ]);
  });

  it("does not add Other when there are 9 or fewer protocols", () => {
    const { displayEntries } = buildProtocolBreakdown({
      curve: 1_500,
      raydium: 990,
      "uniswap-v3": 850,
      uniswap: 670,
      pancakeswap: 560,
      quickswap: 440,
      fluid: 250,
      orca: 195,
      "sunswap-v3": 176,
    });

    expect(displayEntries).toHaveLength(9);
    expect(displayEntries.some(([protocol]) => protocol === "_other")).toBe(false);
  });
});
