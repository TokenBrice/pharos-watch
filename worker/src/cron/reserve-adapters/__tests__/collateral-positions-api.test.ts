import { describe, expect, it } from "vitest";
import { adaptCollateralPositions } from "../collateral-positions-api";

describe("adaptCollateralPositions", () => {
  it("aggregates open collateral positions into reserve slices and folds small tails into Other", () => {
    const result = adaptCollateralPositions(
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

    expect(result.slices).toEqual([
      { name: "WBTC (Wrapped BTC)", pct: 55.6, risk: "medium" },
      { name: "WETH (Wrapped Ether)", pct: 44.4, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      assetCount: 3,
      collateralAssetCount: 3,
      activePositionCount: 3,
      missingPriceCount: 0,
      freshnessMode: "unverified",
      details: {
        freshnessSource: "position-and-price-apis",
      },
    });
  });

  it("emits a warning for symbols not in canonical or protocol-specific risk maps", () => {
    const result = adaptCollateralPositions(
      {
        "0xabc": {
          address: "0xabc",
          name: "Unknown Token",
          symbol: "XYZZY",
          decimals: 18,
          positions: [{ collateralBalance: "1000000000000000000" }],
        },
      },
      {
        "0xabc": { price: { usd: 100 } },
      },
    );
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(
      (w) => w.code === "unknown-asset" && w.message.includes("XYZZY"),
    )).toBe(true);
  });

  it("surfaces unknown assets as an explicit slice instead of folding them into Other collateral", () => {
    const result = adaptCollateralPositions(
      {
        "0xbtc": {
          address: "0xBTC",
          name: "Wrapped BTC",
          symbol: "WBTC",
          decimals: 8,
          positions: [{ collateralBalance: "90000000" }],
        },
        "0xunk": {
          address: "0xunk",
          name: "Mystery",
          symbol: "MYST",
          decimals: 18,
          positions: [{ collateralBalance: "500000000000000000" }],
        },
        "0xtiny": {
          address: "0xtiny",
          name: "Tiny Known",
          symbol: "WETH",
          decimals: 18,
          positions: [{ collateralBalance: "10000000000000000" }],
        },
      },
      {
        "0xbtc": { price: { usd: 100_000 } },
        "0xunk": { price: { usd: 1_000 } },
        "0xtiny": { price: { usd: 2_000 } },
      },
      1,
    );

    const unknownSlice = result.slices.find((s) => s.name === "Unknown assets");
    const otherSlice = result.slices.find((s) => s.name === "Other collateral");
    expect(unknownSlice).toBeDefined();
    expect(unknownSlice!.risk).toBe("high");
    expect(unknownSlice!.pct).toBeGreaterThan(0);
    expect(otherSlice).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeGreaterThan(0);
  });

  it("does not warn for protocol-specific known assets like FPS or tokenized stocks", () => {
    const result = adaptCollateralPositions(
      {
        "0xfps": {
          address: "0xfps",
          name: "Frankencoin Pool Shares",
          symbol: "FPS",
          decimals: 18,
          positions: [{ collateralBalance: "1000000000000000000" }],
        },
        "0xaapl": {
          address: "0xaapl",
          name: "Apple Tokenized",
          symbol: "AAPLx",
          decimals: 18,
          positions: [{ collateralBalance: "1000000000000000000" }],
        },
        "0xysybold": {
          address: "0xysybold",
          name: "Staked yBOLD",
          symbol: "ysyBOLD",
          decimals: 18,
          positions: [{ collateralBalance: "1000000000000000000" }],
        },
      },
      {
        "0xfps": { price: { usd: 500 } },
        "0xaapl": { price: { usd: 200 } },
        "0xysybold": { price: { usd: 1.05 } },
      },
      0,
    );
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toContainEqual({
      name: "ysyBOLD (Staked yBOLD)",
      pct: 0.1,
      risk: "medium",
      coinId: "bold-liquity",
      depType: "wrapper",
    });
  });

  it("attaches optional bridge-backed redeemable capacity metadata", () => {
    const result = adaptCollateralPositions(
      {
        "0xbtc": {
          address: "0xBTC",
          name: "Wrapped BTC",
          symbol: "WBTC",
          decimals: 8,
          positions: [{ collateralBalance: "100000000" }],
        },
      },
      {
        "0xbtc": { price: { usd: 100000 } },
      },
      2,
      395_346.145491,
    );

    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 395_346.145491,
    });
  });
});
