import { describe, expect, it } from "vitest";
import { getBlacklistChartCoins, getBlacklistTooltipSummary } from "@/components/blacklist-chart";

describe("getBlacklistTooltipSummary", () => {
  it("excludes the total series from issuer rows and uses it for the summary total", () => {
    const summary = getBlacklistTooltipSummary([
      { dataKey: "USDT", value: 638_490_000, color: "#1" },
      { dataKey: "USDC", value: 5_540_000, color: "#2" },
      { dataKey: "total", value: 644_040_000, color: "#3" },
    ]);

    expect(summary.rows).toHaveLength(2);
    expect(summary.rows.map((row) => row.dataKey)).toEqual(["USDT", "USDC"]);
    expect(summary.total).toBe(644_040_000);
  });

  it("falls back to summing issuer rows when no total series is present", () => {
    const summary = getBlacklistTooltipSummary([
      { dataKey: "USDT", value: 10_000, color: "#1" },
      { dataKey: "USDC", value: 5_000, color: "#2" },
    ]);

    expect(summary.rows).toHaveLength(2);
    expect(summary.total).toBe(15_000);
  });

  it("derives rendered chart coins from all supported non-zero series", () => {
    const coins = getBlacklistChartCoins([
      {
        quarter: "Q2 '26",
        USDT: 0,
        USDC: 0,
        PYUSD: 0,
        USD1: 0,
        PAXG: 0,
        XAUT: 0,
        USDG: 0,
        RLUSD: 0,
        U: 0,
        USDTB: 0,
        A7A5: 0,
        FDUSD: 0,
        BRZ: 125,
        AUSD: 0,
        EURI: 0,
        USDQ: 0,
        USDO: 0,
        USDX: 0,
        AID: 0,
        TGBP: 0,
        EURC: 0,
        BUIDL: 250,
        total: 375,
      },
    ]);

    expect(coins).toEqual(["BRZ", "BUIDL"]);
  });
});
