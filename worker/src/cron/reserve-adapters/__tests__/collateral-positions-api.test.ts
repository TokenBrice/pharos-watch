import { describe, expect, it } from "vitest";

import { adaptCollateralPositions } from "../collateral-positions-api";
import {
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import {
  COLLATERAL_POSITION_MIN_SLICE_PCT,
  COLLATERAL_POSITION_PRICES,
  COLLATERAL_POSITIONS_BY_ASSET,
} from "./reserve-adapter-payloads.test-support";

describe("adaptCollateralPositions", () => {
  it("uses the oldest active per-asset timestamp and refuses partial freshness coverage", () => {
    const prices = Object.fromEntries(Object.entries(COLLATERAL_POSITION_PRICES).map(([address, price], index) => [
      address, { ...price, timestamp: (1_780_000_000 + index) * 1000 },
    ]));
    const result = adaptCollateralPositions(COLLATERAL_POSITIONS_BY_ASSET, prices);
    expect(result.metadata).toMatchObject({ freshnessMode: "verified", sourceTimestamp: 1_780_000_000 });
    const firstAddress = Object.keys(prices)[0];
    const incomplete = { ...prices, [firstAddress]: { ...prices[firstAddress], timestamp: undefined } };
    expect(adaptCollateralPositions(COLLATERAL_POSITIONS_BY_ASSET, incomplete).metadata?.freshnessMode).toBe("unverified");
  });

  it("aggregates open collateral positions into reserve slices and folds small tails into Other", () => {
    const result = adaptCollateralPositions(
      COLLATERAL_POSITIONS_BY_ASSET,
      COLLATERAL_POSITION_PRICES,
      COLLATERAL_POSITION_MIN_SLICE_PCT,
    );

    expect(result.slices).toEqual([
      { sourceKey: "collateral-positions-api:wbtc", name: "WBTC (Wrapped BTC)", pct: 55.6, risk: "medium" },
      { sourceKey: "collateral-positions-api:weth", name: "WETH (Wrapped Ether)", pct: 44.4, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      assetCount: 3,
      collateralAssetCount: 3,
      activePositionCount: 3,
      missingPriceCount: 0,
      freshnessMode: "not-applicable",
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
      sourceKey: "collateral-positions-api:ysybold",
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
      { sourceKey: "collateral-positions-api:paxg", name: "PAXG (Paxos Gold)", pct: 60, risk: "medium", coinId: "paxg-paxos" },
      { sourceKey: "collateral-positions-api:xaut", name: "XAUt (Tether Gold)", pct: 40, risk: "medium", coinId: "xaut-tether" },
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
      { sourceKey: "collateral-positions-api:chfau", name: "CHFAU (AllUnity CHF)", pct: 100, risk: "low", coinId: "chfau-allunity" },
    ]);
  });

  it("emits the assets-to-liability ratio from position minted debt", () => {
    const result = adaptCollateralPositions(
      {
        "0xbtc": {
          address: "0xBTC",
          name: "Wrapped BTC",
          symbol: "WBTC",
          decimals: 8,
          positions: [
            {
              collateralBalance: "100000000",
              minted: "50000000000000000000000",
              zchf: "0xZCHF",
              zchfDecimals: 18,
            },
          ],
        },
      },
      {
        "0xbtc": { price: { usd: 100_000 } },
        "0xzchf": { price: { usd: 1.25 } },
      },
      2,
    );

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100_000,
      totalLiabilitiesUsd: 62_500,
      collateralizationRatio: 1.6,
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
      { sourceUrls: ["https://example.com/positions", "https://example.com/prices"] },
    );

    expect(result.metadata).toMatchObject({
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
      { sourceKey: "collateral-positions-api:usdc", name: "USDC (USD Coin)", pct: 50, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "collateral-positions-api:dai", name: "DAI (Dai Stablecoin)", pct: 50, risk: "low", coinId: "dai-makerdao" },
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
      { sourceKey: "collateral-positions-api:usdc", name: "USDC (USD Coin)", pct: 100, risk: "low", coinId: "usdc-circle" },
    ]);
  });
});


// The catalog config for deuro-deuro owns the basket: runAdapter drives the
// real nine-bridge roster, so a renamed param or dropped bridge fails the run
// with the exact unanswered calldata. This mirror only carries the amounts the
// assertions read back.
const POSITIONS_URL = "https://api.deuro.com/ecosystem/collateral/positions/details";
const PRICES_URL = "https://api.deuro.com/prices/mapping";
const DEURO = "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea";
const WBTC_ADDRESS = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

const BRIDGE_INVENTORY: Array<{
  label: string;
  bridge: string;
  token: string;
  decimals: number;
  inventoryRaw: bigint;
}> = [
  { label: "EURT", bridge: "0x2353d16869f717bfcd22dabc0adbf4dca62c609f", token: "0xc581b735a1688071a1746c968e0798d642ede491", decimals: 6, inventoryRaw: 1_000_000n },
  { label: "EURS", bridge: "0x73f38ca06b27eaefb1612d062d885f58924f5897", token: "0xdb25f211ab05b1c97d595516f45794528a807ad8", decimals: 2, inventoryRaw: 51n },
  { label: "VEUR", bridge: "0x76d8f514554a4a8e5d6103875f2dd7a67543692b", token: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3", decimals: 18, inventoryRaw: 2n * 10n ** 18n },
  { label: "EURC", bridge: "0xb4ff7412f08c22d7381885e8bda9ee9825092fd1", token: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6, inventoryRaw: 100_250_000n },
  { label: "EURR", bridge: "0x20b0a153ff16c7b1e962fd3d3352a00cf019f1a7", token: "0x50753cfaf86c094925bf976f218d043f8791e408", decimals: 6, inventoryRaw: 500_000n },
  { label: "EUROP", bridge: "0x3ef3d03efcc1338d6210946f8cf5fb1a8b630341", token: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51", decimals: 6, inventoryRaw: 10_000_000n },
  { label: "EURI", bridge: "0xb66a40934a996373fa7602de9820c6bf3e8c9afe", token: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7", decimals: 18, inventoryRaw: 3n * 10n ** 18n },
  { label: "EURE", bridge: "0x4dfd460d54854087af195906a2f260aa483a13b1", token: "0x3231cb76718cdef2155fc47b5286d82e6eda273f", decimals: 18, inventoryRaw: 4n * 10n ** 18n },
  { label: "EURA", bridge: "0x05620f4bb92246b4e067ebc0b6f5c7ff6b771702", token: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8", decimals: 18, inventoryRaw: 5n * 10n ** 18n },
];

const POSITIONS_PAYLOAD = {
  wbtc: {
    address: WBTC_ADDRESS,
    name: "Wrapped BTC",
    symbol: "WBTC",
    decimals: 8,
    positions: [{ collateralBalance: "100000000" }],
  },
};

const BASE_PRICES = {
  [WBTC_ADDRESS]: { price: { usd: 100_000 } },
  [DEURO]: { price: { usd: 1.2, eur: 1 } },
};

interface BridgeBasketOptions {
  inventories?: Record<string, bigint>;
  failedInventoryLabel?: string;
  mismatchedUnderlyingLabel?: string;
  prices?: Record<string, { price?: { usd?: number; eur?: number } }>;
}

function bridgeBasketNetwork(options: BridgeBasketOptions = {}): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {};
  for (const bridge of BRIDGE_INVENTORY) {
    rpc[`${bridge.bridge}:0x7439ae59`] = bridge.label === options.mismatchedUnderlyingLabel
      ? "0x0000000000000000000000000000000000000001"
      : bridge.token;
    rpc[`${bridge.bridge}:0xd395d24b`] = DEURO;
    rpc[`${bridge.token}:decimals()`] = BigInt(bridge.decimals);
    rpc[`${bridge.token}:balanceOf(address)`] = bridge.label === options.failedInventoryLabel
      ? null
      : (options.inventories?.[bridge.token] ?? bridge.inventoryRaw);
    rpc[`0xaa271e1a${bridge.bridge.slice(2).padStart(64, "0")}`] = true;
  }
  return {
    json: {
      [POSITIONS_URL]: POSITIONS_PAYLOAD,
      [PRICES_URL]: options.prices ?? BASE_PRICES,
    },
    rpc,
  };
}

const runBridgeBasket = (options: BridgeBasketOptions = {}) =>
  runAdapter("collateral-positions-api", "deuro-deuro", { network: bridgeBasketNetwork(options) });

describe("fetchCollateralPositionsApiReserves bridge basket", () => {
  it("sums every verified bridge inventory and converts the EUR total to USD", async () => {
    const { result, network } = await runBridgeBasket();

    const jsonUrls = network.requests
      .filter((request) => request.method === "GET")
      .map((request) => request.url)
      .sort();
    expect(jsonUrls).toEqual([POSITIONS_URL, PRICES_URL].sort());
    expect(network.rpcCalls).toHaveLength(BRIDGE_INVENTORY.length * 5);

    expect(result.slices).toEqual([
      { sourceKey: "collateral-positions-api:wbtc", name: "WBTC (Wrapped BTC)", pct: 100, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      redemption: {
        capacityEur: expect.closeTo(126.26, 6),
        capacityUsd: expect.closeTo(151.512, 6),
        eurUsdReference: 1.2,
        eurUsdReferenceSource: DEURO,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        sourceUrls: expect.arrayContaining(["https://docs.deuro.com/smart-contracts"]),
        bridgeInventories: expect.arrayContaining([
          expect.objectContaining({ label: "EURS", inventoryRaw: "51", inventoryEur: 0.51 }),
          expect.objectContaining({ label: "EURC", inventoryRaw: "100250000", inventoryEur: 100.25 }),
        ]),
      },
    });
  });

  it("withholds the whole redemption block when one bridge inventory read fails", async () => {
    const { result } = await runBridgeBasket({ failedInventoryLabel: "EURS" });

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("withholds the whole redemption block on an underlying identity mismatch", async () => {
    const { result } = await runBridgeBasket({ mismatchedUnderlyingLabel: "EURS" });

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("publishes zero capacity without asserting the route open", async () => {
    const emptyInventories = Object.fromEntries(BRIDGE_INVENTORY.map((bridge) => [bridge.token, 0n]));
    const { result } = await runBridgeBasket({ inventories: emptyInventories });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityEur: 0,
      routeStatus: "unknown",
      routeStatusSource: "onchain",
    });
  });

  it("fails the attempt when an active collateral price row disappears instead of publishing a partial mix", async () => {
    await expect(runBridgeBasket({ prices: { [DEURO]: { price: { usd: 1.2, eur: 1 } } } }))
      .rejects.toThrow("missing USD price");
  });
});
