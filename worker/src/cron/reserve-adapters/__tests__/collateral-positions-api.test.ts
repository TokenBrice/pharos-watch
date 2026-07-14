import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { adaptCollateralPositions } from "../collateral-positions-api";

describe("adaptCollateralPositions", () => {
  it("declares latest-state collateral APIs as not-applicable freshness", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["collateral-positions-api"].validation.allowedFreshnessModes).toEqual([
      "not-applicable",
    ]);
  });

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
      freshnessMode: "not-applicable",
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
        "0xchfau": { price: { usd: 1.25 } },
      },
      0,
    );
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toContainEqual({
      name: "ysyBOLD (Staked yBOLD)",
      pct: 0.1,
      risk: "medium",
      coinId: "ybold-yearn",
      depType: "collateral",
    });
  });

  it("maps tracked gold collateral to active dependency targets", () => {
    const result = adaptCollateralPositions(
      {
        "0xpaxg": {
          address: "0xPAXG",
          name: "Paxos Gold",
          symbol: "PAXG",
          decimals: 18,
          positions: [{ collateralBalance: "60000000000000000000" }],
        },
        "0xxaut": {
          address: "0xXAUT",
          name: "Tether Gold",
          symbol: "XAUt",
          decimals: 18,
          positions: [{ collateralBalance: "40000000000000000000" }],
        },
      },
      {
        "0xpaxg": { price: { usd: 1 } },
        "0xxaut": { price: { usd: 1 } },
      },
      0,
    );

    expect(result.slices).toEqual([
      { name: "PAXG (Paxos Gold)", pct: 60, risk: "medium", coinId: "paxg-paxos" },
      { name: "XAUt (Tether Gold)", pct: 40, risk: "medium", coinId: "xaut-tether" },
    ]);
  });

  it("recognizes CHFAU as a low-risk protocol stablecoin when it appears in collateral positions", () => {
    const result = adaptCollateralPositions(
      {
        "0xchfau": {
          address: "0xCHFAU",
          name: "AllUnity CHF",
          symbol: "CHFAU",
          decimals: 6,
          positions: [{ collateralBalance: "250000000000" }],
        },
      },
      {
        "0xchfau": { price: { usd: 1.25 } },
      },
      0,
    );

    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      { name: "CHFAU (AllUnity CHF)", pct: 100, risk: "low", coinId: "chfau-allunity" },
    ]);
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
      { sourceUrls: ["https://example.com/positions", "https://example.com/prices"] },
    );

    expect(result.metadata).toMatchObject({
      immediateRedeemableUsd: 395_346.145491,
      redemption: {
        capacityUsd: 395_346.145491,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://example.com/positions", "https://example.com/prices"],
      },
    });
  });

  it("marks bridge-backed redemption paused when same-run capacity is zero", () => {
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
      0,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
      routeStatusSource: "onchain",
    });
  });

  it("parses large raw collateral balances through bigint decimal conversion", () => {
    const result = adaptCollateralPositions(
      {
        "0xusdc": {
          address: "0xUSDC",
          name: "USD Coin",
          symbol: "USDC",
          decimals: 18,
          positions: [
            { collateralBalance: "100000000000000000000000123456" },
          ],
        },
        "0xdai": {
          address: "0xDAI",
          name: "Dai Stablecoin",
          symbol: "DAI",
          decimals: 18,
          positions: [
            { collateralBalance: "100000000000000000000000123456" },
          ],
        },
      },
      {
        "0xusdc": { price: { usd: 1 } },
        "0xdai": { price: { usd: 1 } },
      },
      0,
    );

    expect(result.metadata).toMatchObject({
      assetCount: 2,
      activePositionCount: 2,
    });
    expect(result.slices).toEqual([
      { name: "USDC (USD Coin)", pct: 50, risk: "low", coinId: "usdc-circle" },
      { name: "DAI (Dai Stablecoin)", pct: 50, risk: "low", coinId: "dai-makerdao" },
    ]);
  });

  it("ignores provider positions with unsafe decimal scales", () => {
    const result = adaptCollateralPositions(
      {
        "0xusdc": {
          address: "0xUSDC",
          name: "USD Coin",
          symbol: "USDC",
          decimals: 6,
          positions: [{ collateralBalance: "1000000" }],
        },
        "0xunsafe": {
          address: "0xUNSAFE",
          name: "Unsafe Scale",
          symbol: "DAI",
          decimals: 1_000_000_000,
          positions: [{ collateralBalance: "1" }],
        },
      },
      {
        "0xusdc": { price: { usd: 1 } },
        "0xunsafe": { price: { usd: 1 } },
      },
      0,
    );

    expect(result.metadata).toMatchObject({
      assetCount: 1,
      activePositionCount: 1,
    });
    expect(result.slices).toEqual([
      { name: "USDC (USD Coin)", pct: 100, risk: "low", coinId: "usdc-circle" },
    ]);
  });
});
