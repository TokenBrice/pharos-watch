import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { decodeFunctionData, parseAbi } from "viem/utils";

const fetchEvmCallHexAtBlockMock = vi.fn();
const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
}));

import { fetchMentoPhpmPrice, mentoPhpmProvider } from "../authoritative-price-sources/mento-phpm";
import { CIRCUIT_SOURCE } from "../constants";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
const uintResult = (value: bigint) => `0x${word(value)}` as `0x${string}`;
const addressResult = (address: string) => `0x${addressWord(address)}` as `0x${string}`;
const quoterResult = (amountOut: bigint) =>
  `0x${[word(amountOut), word(1n), word(1n), word(100_000n)].join("")}` as `0x${string}`;
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

function poolResult(
  input: {
    asset0?: string;
    asset1?: string;
    bucket0?: bigint;
    bucket1?: bigint;
  } = {},
): `0x${string}` {
  return `0x${[
    addressWord(input.asset0 ?? "0x765de816845861e75a25fca122bb6898b8b1282a"),
    addressWord(input.asset1 ?? "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b"),
    addressWord("0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb"),
    word(input.bucket0 ?? 10_000_000n * 10n ** 18n),
    word(input.bucket1 ?? 600_000_000n * 10n ** 18n),
    word(1_700_000_000n),
    word(3n * 10n ** 21n),
  ].join("")}` as `0x${string}`;
}

function trustedAsset(id: string, symbol: string, price = 1): PeggedAsset {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    symbol,
    price,
    priceSource: "coingecko+defillama-list",
    priceConfidence: "high",
    priceObservedAt: now,
    priceObservedAtMode: "local_fetch",
    priceSyncedAt: now,
  } as PeggedAsset;
}

function trustedUsdM(): PeggedAsset {
  return trustedAsset("cusd-celo", "USDm");
}

function phpmPriceContext(): { assetsById: Map<string, PeggedAsset> } {
  return {
    assetsById: new Map([
      ["cusd-celo", trustedUsdM()],
      ["usdt-tether", trustedAsset("usdt-tether", "USDT")],
      ["usdc-circle", trustedAsset("usdc-circle", "USDC")],
    ]),
  };
}

describe("Mento PHPm protocol price", () => {
  it("uses a dedicated recovery circuit without poisoning it during optional refreshes", () => {
    expect(mentoPhpmProvider.liveCircuitSource).toBe(CIRCUIT_SOURCE.PHPM_PRICE_ROUTE);
    expect(mentoPhpmProvider.recordNullLiveResultAsCircuitFailure).toBe(true);
    expect(mentoPhpmProvider.recordLiveCircuitFailuresOnlyWhenMissing).toBe(true);
  });
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(33_333_333);
    fetchEvmBlockTimestampMock.mockReset().mockImplementation(async () => Math.floor(Date.now() / 1_000) - 30);
  });

  it("prices PHPm from the exact funded Broker exchange", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    const result = await fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", trustedUsdM()]]),
    });

    expect(result).toMatchObject({
      price: 0.01617468992,
      source: "protocol-redeem",
      confidence: "high",
      observedAtMode: "upstream",
    });
    expect(fetchEvmCallHexAtBlockMock.mock.calls.every((call) => call[3] === 33_333_333)).toBe(true);
  });

  it("falls back to two exact, factory-bound Uniswap routes when the Broker has no executable median", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(addressResult("0x87dec9a2589d9e6511df84c193561b3a16cf6238"))
      .mockResolvedValueOnce(addressResult("0xb466d5429d6ad9999bf112c225d9d7b15e96c658"))
      .mockResolvedValueOnce(quoterResult(16_261_724n))
      .mockResolvedValueOnce(quoterResult(162_579_057n))
      .mockResolvedValueOnce(quoterResult(16_251_313n))
      .mockResolvedValueOnce(quoterResult(162_381_368n));

    const result = await fetchMentoPhpmPrice(phpmPriceContext());

    expect(result).toMatchObject({
      price: (0.016261724 + 0.016251313) / 2,
      source: "uniswap-v3-exact",
      confidence: "fallback",
      observedAtMode: "upstream",
    });
    expect(
      fetchEvmCallHexAtBlockMock.mock.calls.filter((call) => call[1] === "0xafe208a311b21f13ef87e33a90049fc17a7acdec"),
    ).toHaveLength(2);
    expect(
      fetchEvmCallHexAtBlockMock.mock.calls.filter((call) => call[1] === "0x82825d0554fa07f7fc52ab63c961f330fdefa8e8"),
    ).toHaveLength(4);
    expect(fetchEvmCallHexAtBlockMock.mock.calls.every((call) => call[3] === 33_333_333)).toBe(true);

    const factoryArgs = fetchEvmCallHexAtBlockMock.mock.calls.slice(2, 4).map((call) => {
      const decoded = decodeFunctionData({
        abi: FACTORY_ABI,
        data: call[2] as `0x${string}`,
      });
      return {
        ...decoded,
        args: [decoded.args[0].toLowerCase(), decoded.args[1].toLowerCase(), decoded.args[2]],
      };
    });
    expect(factoryArgs).toEqual([
      {
        functionName: "getPool",
        args: ["0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b", "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", 100],
      },
      {
        functionName: "getPool",
        args: ["0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b", "0xceba9300f2b948710d2653dd7b07f33a8b32118c", 100],
      },
    ]);

    const quoteParams = fetchEvmCallHexAtBlockMock.mock.calls.slice(4).map((call) => {
      const decoded = decodeFunctionData({
        abi: QUOTER_ABI,
        data: call[2] as `0x${string}`,
      });
      expect(decoded.functionName).toBe("quoteExactInputSingle");
      return {
        ...decoded.args[0],
        tokenIn: decoded.args[0].tokenIn.toLowerCase(),
        tokenOut: decoded.args[0].tokenOut.toLowerCase(),
      };
    });
    expect(quoteParams).toEqual([
      {
        tokenIn: "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b",
        tokenOut: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
        amountIn: 1_000n * 10n ** 18n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
      {
        tokenIn: "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b",
        tokenOut: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
        amountIn: 10_000n * 10n ** 18n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
      {
        tokenIn: "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b",
        tokenOut: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
        amountIn: 1_000n * 10n ** 18n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
      {
        tokenIn: "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b",
        tokenOut: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
        amountIn: 10_000n * 10n ** 18n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ]);
  });

  it("fails the Uniswap fallback closed when the exact factory binding changes", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(addressResult("0x0000000000000000000000000000000000000001"))
      .mockResolvedValueOnce(addressResult("0xb466d5429d6ad9999bf112c225d9d7b15e96c658"));

    await expect(fetchMentoPhpmPrice(phpmPriceContext())).resolves.toBeNull();
    expect(
      fetchEvmCallHexAtBlockMock.mock.calls.filter((call) => call[1] === "0x82825d0554fa07f7fc52ab63c961f330fdefa8e8"),
    ).toHaveLength(0);
  });

  it("fails the Uniswap fallback closed when either route has excessive quote impact", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(addressResult("0x87dec9a2589d9e6511df84c193561b3a16cf6238"))
      .mockResolvedValueOnce(addressResult("0xb466d5429d6ad9999bf112c225d9d7b15e96c658"))
      .mockResolvedValueOnce(quoterResult(16_261_724n))
      .mockResolvedValueOnce(quoterResult(100_000_000n))
      .mockResolvedValueOnce(quoterResult(16_251_313n))
      .mockResolvedValueOnce(quoterResult(162_381_368n));

    await expect(fetchMentoPhpmPrice(phpmPriceContext())).resolves.toBeNull();
  });

  it("fails the Uniswap fallback closed when the two bounded routes diverge", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(addressResult("0x87dec9a2589d9e6511df84c193561b3a16cf6238"))
      .mockResolvedValueOnce(addressResult("0xb466d5429d6ad9999bf112c225d9d7b15e96c658"))
      .mockResolvedValueOnce(quoterResult(16_200_000n))
      .mockResolvedValueOnce(quoterResult(162_000_000n))
      .mockResolvedValueOnce(quoterResult(15_000_000n))
      .mockResolvedValueOnce(quoterResult(150_000_000n));

    await expect(fetchMentoPhpmPrice(phpmPriceContext())).resolves.toBeNull();
  });

  it("does not let the DEX fallback replace an already usable input price", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(poolResult()).mockResolvedValueOnce(null);
    const asset = trustedAsset("phpm-mento", "PHPm", 0.0162);

    await expect(mentoPhpmProvider.fetchLivePrice!(asset, phpmPriceContext())).resolves.toBeNull();

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the exact exchange token identity changes", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult({ asset1: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    await expect(
      fetchMentoPhpmPrice({
        assetsById: new Map([["cusd-celo", trustedUsdM()]]),
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the USDm counter bucket falls below the reviewed floor", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult({ bucket0: 100_000n * 10n ** 18n }))
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    await expect(
      fetchMentoPhpmPrice({
        assetsById: new Map([["cusd-celo", trustedUsdM()]]),
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the USDm dependency is stale", async () => {
    const usdM = trustedUsdM();
    usdM.priceObservedAt = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    usdM.priceSyncedAt = usdM.priceObservedAt;

    await expect(
      fetchMentoPhpmPrice({
        assetsById: new Map([["cusd-celo", usdM]]),
      }),
    ).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("fails closed on a stale Celo block before reading exchange state", async () => {
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1_000) - 301);

    await expect(
      fetchMentoPhpmPrice({
        assetsById: new Map([["cusd-celo", trustedUsdM()]]),
      }),
    ).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });
});
