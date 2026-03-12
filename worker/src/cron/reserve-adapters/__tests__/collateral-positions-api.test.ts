import { describe, expect, it } from "vitest";
import { adaptCollateralPositions } from "../collateral-positions-api";

describe("adaptCollateralPositions", () => {
  it("aggregates open collateral positions into reserve slices and folds small tails into Other", () => {
    const slices = adaptCollateralPositions(
      {
        "0xbtc": {
          address: "0xBTC",
          name: "Wrapped BTC",
          symbol: "WBTC",
          decimals: 8,
          positions: [
            { collateralBalance: "500000000", closed: false, denied: false },
          ],
        },
        "0xeth": {
          address: "0xETH",
          name: "Wrapped Ether",
          symbol: "WETH",
          decimals: 18,
          positions: [
            { collateralBalance: "200000000000000000000", closed: false, denied: false },
          ],
        },
        "0xgno": {
          address: "0xGNO",
          name: "Gnosis",
          symbol: "GNO",
          decimals: 18,
          positions: [
            { collateralBalance: "1000000000000000000", closed: false, denied: false },
          ],
        },
      },
      {
        "0xbtc": { price: { usd: 100000 } },
        "0xeth": { price: { usd: 2000 } },
        "0xgno": { price: { usd: 200 } },
      },
      5,
    );

    expect(slices).toEqual([
      { name: "WBTC (Wrapped BTC)", pct: 56, risk: "medium" },
      { name: "WETH (Wrapped Ether)", pct: 44, risk: "medium" },
    ]);
  });
});
