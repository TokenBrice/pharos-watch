import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchJsonWithRetry: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
  };
});

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchDefiLlamaPrices, fetchJsonWithRetry, fetchOnchainMulticall3 } from "../helpers";
import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import { adaptCrvUsd, adaptCrvUsdOnchain, fetchCrvUsdReserves } from "../crvusd";

const YIELD_BASIS_FACTORY = "0x370a449febb9411c95bf897021377fe0b7d100c0";
const CURVE_CONTROLLER_FACTORY = "0xC9332fdCB1C491Dcc683bAe86Fe3cb70360738BC";
const BTC_ASSET = "0x00000000000000000000000000000000000000b0";
const BTC_LT = "0x00000000000000000000000000000000000000b1";
const ETH_ASSET = "0x00000000000000000000000000000000000000e0";
const ETH_LT = "0x00000000000000000000000000000000000000e1";
const LLAMMA_AMM = "0x00000000000000000000000000000000000000a1";
const LLAMMA_CONTROLLER = "0x00000000000000000000000000000000000000a2";
const CURVE_FACTORY_ABI = parseAbi([
  "function n_collaterals() view returns (uint256)",
  "function collaterals(uint256) view returns (address)",
  "function controllers(uint256) view returns (address)",
  "function amms(uint256) view returns (address)",
]);
const CURVE_AMM_ABI = parseAbi([
  "function min_band() view returns (int256)",
  "function max_band() view returns (int256)",
  "function bands_x(int256) view returns (uint256)",
  "function bands_y(int256) view returns (uint256)",
]);
const FACTORY_ABI = parseAbi([
  "function market_count() view returns (uint256)",
  "function markets(uint256) view returns (address asset_token, address cryptopool, address amm, address lt, address price_oracle, address virtual_pool, address staker)",
]);
const LT_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function preview_emergency_withdraw(uint256 shares) view returns (uint256,int256)",
]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const signal = AbortSignal.timeout(5_000);

beforeEach(() => {
  vi.clearAllMocks();
});

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function expectResolvesWithin(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

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
      { name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 70, risk: "medium" },
      { name: "wstETH / sfrxETH / weETH", pct: 12, risk: "low" },
      { name: "tBTC", pct: 10, risk: "medium" },
      { name: "ETH", pct: 8, risk: "very-low" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({
      marketCount: 4,
      activeMarketCount: 4,
      bucketCount: 4,
      freshnessMode: "unverified",
      details: {
        freshnessSource: "curve-market-api + yield-basis-onchain",
      },
    });
  });

  it("folds Yield Basis collateral into the same reserve buckets", () => {
    const result = adaptCrvUsd(
      {
        chains: {
          ethereum: {
            data: [
              { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
              { collateral_amount_usd: 50, collateral_token: { symbol: "WETH" } },
            ],
          },
        },
      },
      [
        { marketId: 3, symbol: "WBTC", usd: 200 },
        { marketId: 6, symbol: "WETH", usd: 100 },
      ],
    );

    expect(result.slices).toEqual([
      { name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      marketCount: 4,
      directMarketCount: 2,
      yieldBasisMarketCount: 2,
      directCollateralUsd: 150,
      yieldBasisCollateralUsd: 300,
      yieldBasisCollateralPct: 66.66666666666666,
    });
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

  it("uses not-applicable freshness for direct LLAMMA onchain exposures", () => {
    const result = adaptCrvUsdOnchain(
      [
        {
          marketId: 0,
          symbol: "WBTC",
          collateralAddress: BTC_ASSET,
          ammAddress: LLAMMA_AMM,
          collateralUsd: 100,
          softLiquidatedCrvUsdUsd: 2,
          minBand: 0,
          maxBand: 1,
          bandCount: 2,
        },
      ],
      [{ marketId: 1, symbol: "WETH", usd: 50 }],
    );

    expect(result.slices).toEqual([
      { name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      directCollateralUsd: 100,
      yieldBasisCollateralUsd: 50,
      softLiquidatedCrvUsdUsd: 2,
      bandReadCount: 2,
      details: {
        proofKind: "curve-llamma-direct-onchain",
      },
    });
  });

  it("does not infer redemption telemetry from LLAMMA inventory alone", () => {
    const result = adaptCrvUsdOnchain(
      [
        {
          marketId: 0,
          symbol: "WBTC",
          collateralAddress: BTC_ASSET,
          ammAddress: LLAMMA_AMM,
          collateralUsd: 100,
          softLiquidatedCrvUsdUsd: 25,
          minBand: 0,
          maxBand: 1,
          bandCount: 2,
        },
      ],
      [],
    );

    expect(result.metadata).toMatchObject({
      softLiquidatedCrvUsdUsd: 25,
      bandReadCount: 2,
    });
    expect(result.metadata?.redemption).toBeUndefined();
  });
});

describe("fetchCrvUsdReserves", () => {
  it("schedules Yield Basis market reads across markets before awaiting the first market", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ chains: { ethereum: { data: [] } } });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        [BTC_ASSET, 100],
        [ETH_ASSET, 10],
      ]),
    );

    const firstMarket = createDeferred<`0x${string}`>();
    let resolveSecondMarketStarted!: () => void;
    const secondMarketStarted = new Promise<void>((resolve) => {
      resolveSecondMarketStarted = resolve;
    });

    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "market_count", result: 2n });
        }
        if (decoded.functionName === "markets") {
          const marketId = Number(decoded.args[0] ?? 0n);
          const result =
            marketId === 0
              ? ([BTC_ASSET, BTC_ASSET, BTC_ASSET, BTC_LT, BTC_ASSET, BTC_ASSET, BTC_ASSET] as const)
              : ([ETH_ASSET, ETH_ASSET, ETH_ASSET, ETH_LT, ETH_ASSET, ETH_ASSET, ETH_ASSET] as const);
          const encoded = encodeFunctionResult({ abi: FACTORY_ABI, functionName: "markets", result });
          if (marketId === 0) {
            return firstMarket.promise;
          }
          resolveSecondMarketStarted();
          return encoded;
        }
      }

      if (normalizedAddress === BTC_ASSET || normalizedAddress === ETH_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: normalizedAddress === BTC_ASSET ? "WBTC" : "WETH",
          });
        }
        if (decoded.functionName === "decimals") {
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "decimals",
            result: normalizedAddress === BTC_ASSET ? 8 : 18,
          });
        }
      }

      if (normalizedAddress === BTC_LT || normalizedAddress === ETH_LT) {
        const decoded = decodeFunctionData({ abi: LT_ABI, data: callData });
        if (decoded.functionName === "totalSupply") {
          return encodeFunctionResult({ abi: LT_ABI, functionName: "totalSupply", result: 1n });
        }
        if (decoded.functionName === "preview_emergency_withdraw") {
          return encodeFunctionResult({
            abi: LT_ABI,
            functionName: "preview_emergency_withdraw",
            result: normalizedAddress === BTC_LT ? [2n * 10n ** 8n, 0n] : [10n * 10n ** 18n, 0n],
          });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 2,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://prices.curve.finance/v1/crvusd/markets",
        },
      },
    };

    const resultPromise = fetchCrvUsdReserves({} as never, config, signal);
    await expectResolvesWithin(
      secondMarketStarted,
      100,
      "Yield Basis market 1 was not requested before market 0 resolved",
    );
    firstMarket.resolve(
      encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "markets",
        result: [BTC_ASSET, BTC_ASSET, BTC_ASSET, BTC_LT, BTC_ASSET, BTC_ASSET, BTC_ASSET] as const,
      }),
    );

    const result = await resultPromise;

    expect(result.metadata).toMatchObject({
      yieldBasisMarketCount: 2,
      yieldBasisActiveMarketCount: 2,
      yieldBasisCollateralUsd: 300,
    });
  });

  it("schedules LLAMMA descriptor reads across markets before awaiting the first market", async () => {
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        [BTC_ASSET, 100],
        [ETH_ASSET, 10],
      ]),
    );
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async (options) =>
      options.calls.map((call) => ({
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({
          abi: CURVE_AMM_ABI,
          functionName: call.label.includes(":y:") ? "bands_y" : "bands_x",
          result: call.label.includes(":y:") ? 1n * 10n ** 18n : 0n,
        }),
      })),
    );

    const firstCollateral = createDeferred<`0x${string}`>();
    let resolveSecondCollateralStarted!: () => void;
    const secondCollateralStarted = new Promise<void>((resolve) => {
      resolveSecondCollateralStarted = resolve;
    });

    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === CURVE_CONTROLLER_FACTORY.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_FACTORY_ABI, data: callData });
        if (decoded.functionName === "n_collaterals") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "n_collaterals", result: 2n });
        }
        if (decoded.functionName === "collaterals") {
          const marketId = Number(decoded.args[0] ?? 0n);
          if (marketId === 0) {
            return firstCollateral.promise;
          }
          resolveSecondCollateralStarted();
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "collaterals", result: ETH_ASSET });
        }
        if (decoded.functionName === "controllers") {
          return encodeFunctionResult({
            abi: CURVE_FACTORY_ABI,
            functionName: "controllers",
            result: LLAMMA_CONTROLLER,
          });
        }
        if (decoded.functionName === "amms") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "amms", result: LLAMMA_AMM });
        }
      }

      if (normalizedAddress === BTC_ASSET || normalizedAddress === ETH_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: normalizedAddress === BTC_ASSET ? "WBTC" : "WETH",
          });
        }
      }

      if (normalizedAddress === LLAMMA_AMM.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_AMM_ABI, data: callData });
        if (decoded.functionName === "min_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "min_band", result: 0n });
        }
        if (decoded.functionName === "max_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "max_band", result: 0n });
        }
      }

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "market_count", result: 0n });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 3,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "onchain-evm",
          chain: "ethereum",
          rpcMode: "public-rpc",
        },
      },
    };

    const resultPromise = fetchCrvUsdReserves({} as never, config, signal);
    await expectResolvesWithin(
      secondCollateralStarted,
      100,
      "LLAMMA market 1 collateral was not requested before market 0 resolved",
    );
    firstCollateral.resolve(
      encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "collaterals", result: BTC_ASSET }),
    );

    const result = await resultPromise;

    expect(result.metadata).toMatchObject({
      directMarketCount: 2,
      directActiveMarketCount: 2,
      directCollateralUsd: 110,
    });
  });

  it("loads Yield Basis markets onchain and merges them with direct Curve collateral", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      chains: {
        ethereum: {
          data: [
            { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
            { collateral_amount_usd: 50, collateral_token: { symbol: "WETH" } },
          ],
        },
      },
    });
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        [BTC_ASSET, 100],
        [ETH_ASSET, 10],
      ]),
    );
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "market_count",
            result: 2n,
          });
        }
        if (decoded.functionName === "markets") {
          const marketId = Number(decoded.args[0] ?? 0n);
          const result =
            marketId === 0
              ? ([BTC_ASSET, BTC_ASSET, BTC_ASSET, BTC_LT, BTC_ASSET, BTC_ASSET, BTC_ASSET] as const)
              : ([ETH_ASSET, ETH_ASSET, ETH_ASSET, ETH_LT, ETH_ASSET, ETH_ASSET, ETH_ASSET] as const);
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "markets",
            result,
          });
        }
      }

      if (normalizedAddress === BTC_ASSET || normalizedAddress === ETH_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: normalizedAddress === BTC_ASSET ? "WBTC" : "WETH",
          });
        }
        if (decoded.functionName === "decimals") {
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "decimals",
            result: normalizedAddress === BTC_ASSET ? 8 : 18,
          });
        }
      }

      if (normalizedAddress === BTC_LT || normalizedAddress === ETH_LT) {
        const decoded = decodeFunctionData({ abi: LT_ABI, data: callData });
        if (decoded.functionName === "totalSupply") {
          return encodeFunctionResult({
            abi: LT_ABI,
            functionName: "totalSupply",
            result: 1n,
          });
        }
        if (decoded.functionName === "preview_emergency_withdraw") {
          return encodeFunctionResult({
            abi: LT_ABI,
            functionName: "preview_emergency_withdraw",
            result: normalizedAddress === BTC_LT ? [2n * 10n ** 8n, 0n] : [10n * 10n ** 18n, 0n],
          });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 2,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://prices.curve.finance/v1/crvusd/markets",
        },
      },
    };

    const result = await fetchCrvUsdReserves({} as never, config, signal);

    expect(result.slices).toEqual([
      { name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 66.7, risk: "medium" },
      { name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      yieldBasisMarketCount: 2,
      yieldBasisActiveMarketCount: 2,
      yieldBasisCollateralUsd: 300,
    });
    expect(fetchEvmCallHexAtBlock).toHaveBeenCalled();
  });

  it("continues with direct Curve market data when the optional Yield Basis leg fails", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      chains: {
        ethereum: {
          data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }],
        },
      },
    });
    vi.mocked(fetchEvmCallHexAtBlock).mockRejectedValue(new Error("rpc unavailable"));

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 2,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://prices.curve.finance/v1/crvusd/markets",
        },
      },
    };

    const result = await fetchCrvUsdReserves({} as never, config, signal);

    expect(result.slices).toEqual([{ name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "yield-basis-read-failed", effect: "degraded" })]),
    );
    expect(result.metadata).toMatchObject({
      directActiveMarketCount: 1,
      yieldBasisActiveMarketCount: 0,
      yieldBasisCollateralUsd: 0,
    });
  });

  it("drops the optional Yield Basis leg when token decimals are out of bounds", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      chains: {
        ethereum: {
          data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }],
        },
      },
    });
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "market_count",
            result: 1n,
          });
        }
        if (decoded.functionName === "markets") {
          return encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "markets",
            result: [BTC_ASSET, BTC_ASSET, BTC_ASSET, BTC_LT, BTC_ASSET, BTC_ASSET, BTC_ASSET] as const,
          });
        }
      }

      if (normalizedAddress === BTC_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "WBTC" });
        }
        if (decoded.functionName === "decimals") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: 37 });
        }
      }

      if (normalizedAddress === BTC_LT) {
        const decoded = decodeFunctionData({ abi: LT_ABI, data: callData });
        if (decoded.functionName === "totalSupply") {
          return encodeFunctionResult({ abi: LT_ABI, functionName: "totalSupply", result: 1n });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 2,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://prices.curve.finance/v1/crvusd/markets",
        },
      },
    };

    const result = await fetchCrvUsdReserves({} as never, config, signal);

    expect(result.slices).toEqual([{ name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "yield-basis-read-failed",
          effect: "degraded",
          message: expect.stringContaining("expected safe integer 0-36"),
        }),
      ]),
    );
    expect(fetchDefiLlamaPrices).not.toHaveBeenCalled();
  });

  it("rejects unexpectedly wide LLAMMA band ranges before building multicall payloads", async () => {
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([[BTC_ASSET, 10]]));
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === CURVE_CONTROLLER_FACTORY.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_FACTORY_ABI, data: callData });
        if (decoded.functionName === "n_collaterals") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "n_collaterals", result: 1n });
        }
        if (decoded.functionName === "collaterals") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "collaterals", result: BTC_ASSET });
        }
        if (decoded.functionName === "controllers") {
          return encodeFunctionResult({
            abi: CURVE_FACTORY_ABI,
            functionName: "controllers",
            result: LLAMMA_CONTROLLER,
          });
        }
        if (decoded.functionName === "amms") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "amms", result: LLAMMA_AMM });
        }
      }

      if (normalizedAddress === BTC_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "WBTC" });
        }
      }

      if (normalizedAddress === LLAMMA_AMM.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_AMM_ABI, data: callData });
        if (decoded.functionName === "min_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "min_band", result: 0n });
        }
        if (decoded.functionName === "max_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "max_band", result: 2_048n });
        }
      }

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "market_count", result: 0n });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 3,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "onchain-evm",
          chain: "ethereum",
          rpcMode: "public-rpc",
        },
      },
    };

    await expect(fetchCrvUsdReserves({} as never, config, signal)).rejects.toThrow(
      "band range too wide: 2049 bands exceeds 2048",
    );
    expect(fetchOnchainMulticall3).not.toHaveBeenCalled();
  });

  it("loads direct LLAMMA bands onchain when configured for onchain input", async () => {
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([[BTC_ASSET, 10]]));
    vi.mocked(fetchOnchainMulticall3).mockResolvedValue([
      {
        label: "0:y:0",
        success: true,
        returnData: encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "bands_y", result: 5n * 10n ** 18n }),
      },
      {
        label: "0:x:0",
        success: true,
        returnData: encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "bands_x", result: 1n * 10n ** 18n }),
      },
      {
        label: "0:y:1",
        success: true,
        returnData: encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "bands_y", result: 5n * 10n ** 18n }),
      },
      {
        label: "0:x:1",
        success: true,
        returnData: encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "bands_x", result: 1n * 10n ** 18n }),
      },
    ]);
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
      const normalizedAddress = address.toLowerCase();
      const callData = data as `0x${string}`;

      if (normalizedAddress === CURVE_CONTROLLER_FACTORY.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_FACTORY_ABI, data: callData });
        if (decoded.functionName === "n_collaterals") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "n_collaterals", result: 1n });
        }
        if (decoded.functionName === "collaterals") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "collaterals", result: BTC_ASSET });
        }
        if (decoded.functionName === "controllers") {
          return encodeFunctionResult({
            abi: CURVE_FACTORY_ABI,
            functionName: "controllers",
            result: LLAMMA_CONTROLLER,
          });
        }
        if (decoded.functionName === "amms") {
          return encodeFunctionResult({ abi: CURVE_FACTORY_ABI, functionName: "amms", result: LLAMMA_AMM });
        }
      }

      if (normalizedAddress === BTC_ASSET) {
        const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
        if (decoded.functionName === "symbol") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "WBTC" });
        }
      }

      if (normalizedAddress === LLAMMA_AMM.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: CURVE_AMM_ABI, data: callData });
        if (decoded.functionName === "min_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "min_band", result: 0n });
        }
        if (decoded.functionName === "max_band") {
          return encodeFunctionResult({ abi: CURVE_AMM_ABI, functionName: "max_band", result: 1n });
        }
      }

      if (normalizedAddress === YIELD_BASIS_FACTORY) {
        const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData });
        if (decoded.functionName === "market_count") {
          return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "market_count", result: 0n });
        }
      }

      return null;
    });

    const config: LiveReservesConfig = {
      adapter: "crvusd",
      version: 3,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "onchain-evm",
          chain: "ethereum",
          rpcMode: "public-rpc",
        },
      },
    };

    const result = await fetchCrvUsdReserves({} as never, config, signal);

    expect(result.slices).toEqual([{ name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 100, risk: "medium" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      directMarketCount: 1,
      directActiveMarketCount: 1,
      directCollateralUsd: 100,
      softLiquidatedCrvUsdUsd: 2,
      bandReadCount: 2,
    });
    expect(fetchOnchainMulticall3).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: expect.arrayContaining([
          expect.objectContaining({ label: "0:y:0" }),
          expect.objectContaining({ label: "0:x:1" }),
        ]),
        multicallBatchSize: 500,
      }),
    );
  });
});
