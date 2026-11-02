import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem/utils";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockHeader: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmBlockNumber: rpcMocks.fetchEvmBlockNumber,
  fetchEvmBlockHeader: rpcMocks.fetchEvmBlockHeader,
  fetchEvmMulticall3Aggregate3AtBlock: rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
}));

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shared/lib/stablecoins/registry")>(),
  TRACKED_META_BY_ID: new Map([
    ["susn-noon", { id: "susn-noon", symbol: "sUSN", flags: { pegCurrency: "USD", navToken: true } }],
    ["usn-noon", { id: "usn-noon", symbol: "USN", flags: { pegCurrency: "USD", navToken: false } }],
  ]),
}));


import { buildUniV3DirectMeasuredExecutionTargets } from "../../measured-execution/inventory";
import { isDexMeasuredExecutionDeploymentScoreEligible } from "../../measured-execution/registry";
import { fetchUniswapV3BscShadowPools } from "../fetch-uniswap-v3-bsc";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import type { DexApiPool } from "../../../lib/dex-api-types";

const POOL = "0xf150d29d92e7460a1531cbc9d1abeab33d6998e4";
const FACTORY = "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USD1 = "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d";
const ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

function encoded(functionName: string, result: unknown): `0x${string}` {
  return encodeFunctionResult({ abi: ABI, functionName: functionName as never, result: result as never });
}

function makeDb(): D1Database {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({
      results: [{
        pool_id: `bsc:${POOL}`,
        base_token: USD1,
        quote_token: USDT,
      }],
    }),
  };
  return makeNoopD1({ prepare: vi.fn(() => statement) });
}

function stateResults() {
  return [
    { label: "cl-0-factory", success: true, returnData: encoded("factory", FACTORY) },
    { label: "cl-0-token0", success: true, returnData: encoded("token0", USDT) },
    { label: "cl-0-token1", success: true, returnData: encoded("token1", USD1) },
    { label: "cl-0-fee", success: true, returnData: encoded("fee", 100) },
    {
      label: "cl-0-slot0",
      success: true,
      returnData: encoded("slot0", [1n << 96n, 0, 0, 0, 0, 0, true]),
    },
    { label: "cl-0-token-0-decimals", success: true, returnData: encoded("decimals", 18) },
    {
      label: "cl-0-token-0-balance",
      success: true,
      returnData: encoded("balanceOf", 1_000_000n * 10n ** 18n),
    },
    { label: "cl-0-token-1-decimals", success: true, returnData: encoded("decimals", 18) },
    {
      label: "cl-0-token-1-balance",
      success: true,
      returnData: encoded("balanceOf", 1_000_000n * 10n ** 18n),
    },
  ];
}

function stateResultsWithBalances(rawBalance: bigint) {
  return stateResults().map((result) =>
    result.label.endsWith("-balance")
      ? { ...result, returnData: encoded("balanceOf", rawBalance) }
      : result,
  );
}

describe("Uniswap V3 BSC shadow staging recovery", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmBlockNumber.mockReset().mockResolvedValue(115_749_297);
    rpcMocks.fetchEvmBlockHeader.mockReset().mockResolvedValue({
      number: 115_749_297, hash: `0x${"11".repeat(32)}`, timestamp: 1_791_184_659,
    });
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });

  it("pins pool identity, token order, fee, state, and factory binding before building shadow targets", async () => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock
      .mockResolvedValueOnce(stateResults())
      .mockResolvedValueOnce([
        ...stateResults(),
        { label: "cl-0-membership", success: true, returnData: encoded("getPool", POOL) },
      ]);
    const chainAddressToId = new Map([
      [`bsc:${USDT}`, "usdt-tether"],
      [`bsc:${USD1}`, "usd1-world-liberty-financial"],
    ]);
    const stablecoinPrices = new Map([
      ["usdt-tether", 1],
      ["usd1-world-liberty-financial", 1],
    ]);

    const result = await fetchUniswapV3BscShadowPools({
      db: makeDb(),
      chainAddressToId,
      trackedStablecoinPrices: stablecoinPrices,
    });

    expect(result).toMatchObject({ ok: true, degraded: false, errors: [] });
    expect(result.pools).toEqual([
      expect.objectContaining({
        source: "uniswap-v3-shadow",
        chain: "bsc",
        poolAddress: POOL,
        feeRate: 0.0001,
        price: 1,
        tvlUsd: 2_000_000,
        tokens: [
          expect.objectContaining({ address: USDT, decimals: 18, priceUsd: 1 }),
          expect.objectContaining({ address: USD1, decimals: 18, priceUsd: 1 }),
        ],
      }),
    ]);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenNthCalledWith(
      1,
      "bsc",
      expect.any(Array),
      115_749_297,
      expect.objectContaining({ multicallBatchSize: 60, maxRetries: 0 }),
    );

    const targets = buildUniV3DirectMeasuredExecutionTargets({
      pools: result.pools,
      chainAddressToId,
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: stablecoinPrices,
      capturedAt: 1_786_646_841,
    });
    expect([...targets.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapterProfileId: "uniswap-v3-quoter-v2",
        protocol: "uniswap-v3",
        chain: "bsc",
        poolId: `bsc:${POOL}`,
        poolTokenAddresses: [USDT, USD1],
        feePips: 100,
      }),
    ]));
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "bsc")).toBe(false);
  });

  it("fails closed when the reviewed factory resolves a different physical pool", async () => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock
      .mockResolvedValueOnce(stateResults())
      .mockResolvedValueOnce([
        ...stateResults(),
        {
          label: "cl-0-membership",
          success: true,
          returnData: encoded("getPool", "0x0000000000000000000000000000000000000001"),
        },
      ]);

    const result = await fetchUniswapV3BscShadowPools({
      db: makeDb(),
      chainAddressToId: new Map([[`bsc:${USDT}`, "usdt-tether"]]),
      trackedStablecoinPrices: new Map([["usdt-tether", 1]]),
    });

    expect(result).toMatchObject({ ok: true, degraded: false });
    expect(result.pools).toEqual([]);
  });

  it.each([
    ["dust", 1n],
    ["implausibly large", 6_000_000_000n * 10n ** 18n],
  ])("rejects %s recovery TVL before target construction", async (_label, rawBalance) => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock
      .mockResolvedValueOnce(stateResultsWithBalances(rawBalance))
      .mockResolvedValueOnce([
        ...stateResultsWithBalances(rawBalance),
        { label: "cl-0-membership", success: true, returnData: encoded("getPool", POOL) },
      ]);

    const result = await fetchUniswapV3BscShadowPools({
      db: makeDb(),
      chainAddressToId: new Map([[`bsc:${USDT}`, "usdt-tether"]]),
      trackedStablecoinPrices: new Map([["usdt-tether", 1]]),
    });

    expect(result).toMatchObject({ ok: true, degraded: false });
    expect(result.pools).toEqual([]);
  });
});

// Uniswap v3 USN/sUSN 0.01% (Ethereum) shape: the tracked sUSN side is a
// navToken whose only market print is an untrusted single-source CoinGecko
// row, so the input leg must price from the guarded ERC-4626 NAV reference
// carried in the trusted map — or fail closed with no NAV (P5).
const SUSN_VAULT = "0xe24a3dc889621612422a64e6388927901608b91d";
const USN_TOKEN = "0x1c4a7a58b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8";
const SUSN_POOL = "0x5cba2738c4df481db7228e1545f29532ed0a2dee";
const NAV_PRICE = 1.2241;

const usnSusnPool: DexApiPool = {
  source: "uniswap-v3-shadow",
  chain: "ethereum",
  poolAddress: SUSN_POOL,
  poolType: "concentrated",
  tokens: [
    { address: SUSN_VAULT, symbol: "sUSN", decimals: 18 },
    { address: USN_TOKEN, symbol: "USN", decimals: 18 },
  ],
  // pool.price feeds token1Price (token0Price = 1/price); 1.2199 keeps the
  // spot-implied output near the USN leg value.
  price: 1.2199,
  tvlUsd: 1_334_144,
  volume24hUsd: 11.74,
  feeRate: 0.0001,
  balances: null,
  tokenVolumes24h: [5, 5],
};

function chainAddressToId(): Map<string, string> {
  return new Map([
    [`ethereum:${SUSN_VAULT}`, "susn-noon"],
    [`ethereum:${USN_TOKEN}`, "usn-noon"],
  ]);
}

describe("navToken measured-execution input legs", () => {
  it("prices the sUSN input leg from the guarded NAV reference", () => {
    const targets = buildUniV3DirectMeasuredExecutionTargets({
      pools: [usnSusnPool],
      chainAddressToId: chainAddressToId(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["susn-noon", NAV_PRICE]]),
      capturedAt: 1_790_140_597,
    });

    const susnTarget = [...targets.values()].find((target) => target.stablecoinId === "susn-noon");
    expect(susnTarget).toBeDefined();
    expect(susnTarget!.tokenIn.referencePriceUsd).toBe(NAV_PRICE);
    expect(susnTarget!.tokenIn.trackedAssetId).toBe("susn-noon");
    // The tracked USN output leg prices from its own peg-reference context
    // (1 for a USD peg); the pool-spot implied lane is only the fallback for
    // legs with no reference price at all.
    expect(susnTarget!.tokenOut.referencePriceUsd).toBe(1);
  });

  it("keeps the sUSN input leg unpriced when the guarded NAV is absent", () => {
    const targets = buildUniV3DirectMeasuredExecutionTargets({
      pools: [usnSusnPool],
      chainAddressToId: chainAddressToId(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map(),
      capturedAt: 1_790_140_597,
    });

    expect([...targets.values()].find((target) => target.stablecoinId === "susn-noon")).toBeUndefined();
  });
});
