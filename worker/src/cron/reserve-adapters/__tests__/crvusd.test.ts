import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchJsonWithRetry: vi.fn(),
  };
});

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchDefiLlamaPrices, fetchJsonWithRetry } from "../helpers";
import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import { adaptCrvUsd, fetchCrvUsdReserves } from "../crvusd";

const YIELD_BASIS_FACTORY = "0x370a449febb9411c95bf897021377fe0b7d100c0";
const BTC_ASSET = "0x00000000000000000000000000000000000000b0";
const BTC_LT = "0x00000000000000000000000000000000000000b1";
const ETH_ASSET = "0x00000000000000000000000000000000000000e0";
const ETH_LT = "0x00000000000000000000000000000000000000e1";
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
      { name: "WBTC / cbBTC / LBTC", pct: 66.7, risk: "medium" },
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
});

describe("fetchCrvUsdReserves", () => {
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
      { name: "WBTC / cbBTC / LBTC", pct: 66.7, risk: "medium" },
      { name: "ETH", pct: 33.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      yieldBasisMarketCount: 2,
      yieldBasisActiveMarketCount: 2,
      yieldBasisCollateralUsd: 300,
    });
    expect(fetchEvmCallHexAtBlock).toHaveBeenCalled();
  });
});
