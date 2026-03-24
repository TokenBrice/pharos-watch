import { describe, expect, it } from "vitest";
import { getBlacklistTooltipSummary } from "@/components/blacklist-chart";

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
});
