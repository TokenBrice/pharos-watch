import { describe, expect, it } from "vitest";
import { adaptCrvUsd } from "../crvusd";

describe("adaptCrvUsd", () => {
  it("groups official Curve market data into Pharos reserve buckets", () => {
    const result = adaptCrvUsd({
      chains: {
        ethereum: {
          data: [
            { collateral_amount_usd: 700, collateral_token: { symbol: "WBTC" } },
            { collateral_amount_usd: 100, collateral_token: { symbol: "tBTC" } },
            { collateral_amount_usd: 120, collateral_token: { symbol: "weETH" } },
            { collateral_amount_usd: 80, collateral_token: { symbol: "WETH" } },
          ],
        },
      },
    });

    expect(result.slices).toEqual([
      { name: "WBTC / cbBTC / LBTC", pct: 70, risk: "medium" },
      { name: "wstETH / sfrxETH / weETH", pct: 12, risk: "low" },
      { name: "tBTC", pct: 10, risk: "medium" },
      { name: "ETH", pct: 8, risk: "very-low" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("uses worst risk when multiple symbols share a bucket", () => {
    const payload = {
      chains: {
        ethereum: {
          data: [
            { collateral_amount_usd: 100_000_000, collateral_token: { symbol: "wstETH" } },
            { collateral_amount_usd: 50_000_000, collateral_token: { symbol: "weETH" } },
          ],
        },
      },
    };
    const { slices } = adaptCrvUsd(payload);
    const lstBucket = slices.find((s) => s.name.includes("wstETH"));
    expect(lstBucket).toBeDefined();
    expect(lstBucket!.risk).toBeDefined();
  });
});
