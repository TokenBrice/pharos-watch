import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmBlockNumber: vi.fn(),
  fetchEvmBlockHeader: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

import {
  fetchEvmCallHexAtBlock,
  fetchEvmBlockNumber,
  fetchEvmBlockHeader,
  fetchEvmMulticall3Aggregate3AtBlock,
} from "../../../lib/evm-rpc";
import {
  fetchSlipstreamPools,
  getSlipstreamPoolFeeBps,
  getSugarClStartOffset,
  projectSugarPoolPage,
  projectSugarTokens,
} from "../fetch-slipstream";
import { convertToGtNewPools, extractPriceObservations } from "../../../lib/dex-api-common";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { makeChainRpcs } from "../../../test-helpers/chain-rpc-fixtures.test-support";

const ABI = parseAbi([
  "function allPoolsLength() view returns (uint256)",
  "function all(uint256 _limit, uint256 _offset, uint256 _filter) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 emissions_cap,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,uint256 locked,uint256 emerging,uint32 created_at,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed,bool emerging)[])",
]);
const RECOVERY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns (address pool)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);


describe("getSlipstreamPoolFeeBps", () => {
  it("returns the numeric bps for valid values", () => {
    expect(getSlipstreamPoolFeeBps(1n)).toBe(1);
    expect(getSlipstreamPoolFeeBps(5n)).toBe(5);
    expect(getSlipstreamPoolFeeBps(30n)).toBe(30);
    expect(getSlipstreamPoolFeeBps(100n)).toBe(100);
    expect(getSlipstreamPoolFeeBps(10_000n)).toBe(10_000);
  });

  it("returns null for out-of-range values", () => {
    expect(getSlipstreamPoolFeeBps(0n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(-1n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(10_001n)).toBe(null);
    expect(getSlipstreamPoolFeeBps(20_000n)).toBe(null);
  });
});

describe("getSugarClStartOffset", () => {
  it("accounts for Velodrome Sugar omitting the first V2 convertor pool", () => {
    expect(getSugarClStartOffset("aerodrome-slipstream", 10)).toBe(10);
    expect(getSugarClStartOffset("velodrome-slipstream", 10)).toBe(9);
  });
});

describe("Sugar ABI projection", () => {
  it("drops non-CL rows and retains exactly the consumed pool fields in source order", () => {
    const makeDecodedPool = (lp: string, type: number, reserve0: bigint) => ({
      lp,
      symbol: `pool-${lp.slice(-2)}`,
      decimals: 18,
      liquidity: 123n,
      type,
      tick: 7,
      sqrt_ratio: 1n << 96n,
      token0: "0x00000000000000000000000000000000000000bb",
      reserve0,
      staked0: 11n,
      token1: "0x00000000000000000000000000000000000000cc",
      reserve1: 50_000_000n,
      staked1: 12n,
      gauge: "0x0000000000000000000000000000000000000001",
      factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
      pool_fee: 5n,
      emissions: 13n,
    });
    const decoded = [
      makeDecodedPool("0x0000000000000000000000000000000000000011", 0, 10n),
      makeDecodedPool("0x0000000000000000000000000000000000000022", 1, 20n),
      makeDecodedPool("0x0000000000000000000000000000000000000033", 2, 30n),
    ];

    const projected = projectSugarPoolPage(decoded);

    expect(projected.map((pool) => pool.lp)).toEqual([
      "0x0000000000000000000000000000000000000022",
      "0x0000000000000000000000000000000000000033",
    ]);
    expect(projected).toEqual(decoded.slice(1).map((pool) => ({
      lp: pool.lp,
      type: pool.type,
      token0: pool.token0,
      reserve0: pool.reserve0,
      token1: pool.token1,
      reserve1: pool.reserve1,
      sqrt_ratio: pool.sqrt_ratio,
      pool_fee: pool.pool_fee,
      factory: pool.factory,
    })));
    expect(projected.map((pool) => pool.reserve0)).toEqual([20n, 30n]);
  });

  it("retains exactly the consumed token fields", () => {
    const decoded = [
      {
        token_address: "0x00000000000000000000000000000000000000BB",
        symbol: "USDC",
        decimals: 6,
        account_balance: 123n,
        listed: true,
      },
    ];

    const tokens = projectSugarTokens(decoded);

    expect(tokens.get("0x00000000000000000000000000000000000000bb")).toEqual({
      token_address: "0x00000000000000000000000000000000000000BB",
      symbol: "USDC",
      decimals: 6,
    });
  });
});

describe("fetchSlipstreamPools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchEvmBlockNumber).mockResolvedValue(25_000_000);
    vi.mocked(fetchEvmBlockHeader).mockResolvedValue({ number: 25_000_000, hash: `0x${"11".repeat(32)}`, timestamp: 1_791_184_659 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSugarPage(poolFee: bigint, reserve = 50n) {
    vi.mocked(fetchEvmCallHexAtBlock)
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "allPoolsLength",
        result: 10n,
      }))
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "allPoolsLength",
        result: 1n,
      }))
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "all",
        result: [{
          lp: "0x00000000000000000000000000000000000000aa",
          symbol: "CL1-USDC/DAI",
          decimals: 18,
          liquidity: 1n,
          type: 1,
          tick: 0,
          // A human 1:1 price for token0(18 decimals) / token1(6 decimals)
          // has a tiny raw ratio that used to truncate to zero.
          sqrt_ratio: (1n << 96n) / 1_000_000n,
          token0: "0x00000000000000000000000000000000000000bb",
          reserve0: reserve * 10n ** 18n,
          staked0: 0n,
          token1: "0x00000000000000000000000000000000000000cc",
          reserve1: reserve * 10n ** 6n,
          staked1: 0n,
          gauge: "0x0000000000000000000000000000000000000000",
          gauge_liquidity: 0n,
          gauge_alive: false,
          fee: "0x0000000000000000000000000000000000000000",
          bribe: "0x0000000000000000000000000000000000000000",
          factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
          emissions: 0n,
          emissions_token: "0x0000000000000000000000000000000000000000",
          emissions_cap: 0n,
          pool_fee: poolFee,
          unstaked_fee: 0n,
          token0_fees: 0n,
          token1_fees: 0n,
          locked: 0n,
          emerging: 0n,
          created_at: 0,
          nfpm: "0x0000000000000000000000000000000000000000",
          alm: "0x0000000000000000000000000000000000000000",
          root: "0x0000000000000000000000000000000000000000",
        }],
      }))
      .mockResolvedValueOnce(encodeFunctionResult({
        abi: ABI,
        functionName: "tokens",
        result: [
          {
            token_address: "0x00000000000000000000000000000000000000bb",
            symbol: "CADC",
            decimals: 18,
            account_balance: 0n,
            listed: true,
            emerging: false,
          },
          {
            token_address: "0x00000000000000000000000000000000000000cc",
            symbol: "USDC",
            decimals: 6,
            account_balance: 0n,
            listed: true,
            emerging: false,
          },
        ],
      }));
  }

  async function fetchBaseSlipstreamPools() {
    return fetchSlipstreamPools(
      "aerodrome-slipstream",
      new Map([
        ["base:0x00000000000000000000000000000000000000bb", "cadc-cad-coin"],
        ["base:0x00000000000000000000000000000000000000cc", "usdc-circle"],
      ]),
      new Map(),
      new Map([["usdc-circle", 1]]),
    );
  }

  it("builds CL pools from sugar contract pages", async () => {
    mockSugarPage(1n);

    const result = await fetchBaseSlipstreamPools();

    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "aerodrome-slipstream",
      chain: "base",
      poolAddress: "0x00000000000000000000000000000000000000AA",
      poolType: "aerodrome-slipstream-1bp",
      feeRate: 0.0001,
      tickSpacing: 1,
      tvlUsd: 100,
      price: 1,
      volume24hUsd: null,
      balances: [50, 50],
      tokens: [
        {
          address: "0x00000000000000000000000000000000000000bb",
          symbol: "CADC",
          decimals: 18,
        },
        {
          address: "0x00000000000000000000000000000000000000cc",
          symbol: "USDC",
          decimals: 6,
        },
      ],
    });
    // A tracked side's own primary is a valuation reference, not pool evidence.
    expect(result.pools[0]!.tokens.map((token) => token.priceUsd)).toEqual([undefined, undefined]);
  });

  it("derives Slipstream price evidence from the pool spot, not the tracked primary", async () => {
    mockSugarPage(1n, 600_000n);
    const chainAddressToId = new Map([
      ["base:0x00000000000000000000000000000000000000bb", "cadc-cad-coin"],
      ["base:0x00000000000000000000000000000000000000cc", "usdc-circle"],
    ]);
    // The pool still quotes 1 CADC = 1 USDC while CADC's trusted primary reads
    // 1.02; the pool-implied CADC price is therefore 1.00, not the 1.02
    // primary it used to republish as its own observation.
    const trackedStablecoinPrices = new Map([["cadc-cad-coin", 1.02], ["usdc-circle", 1]]);

    const result = await fetchSlipstreamPools("aerodrome-slipstream", chainAddressToId, new Map(), trackedStablecoinPrices);

    expect(result.pools).toHaveLength(1);
    const shapedPrices = convertToGtNewPools(
      result.pools,
      chainAddressToId,
      new Map(),
      undefined,
      trackedStablecoinPrices,
    ).get("cadc-cad-coin")?.map((entry) => entry.price) ?? [];
    expect(shapedPrices).toHaveLength(1);
    expect(shapedPrices[0]).toBeCloseTo(1, 6);

    const observationPrices = extractPriceObservations(
      result.pools,
      chainAddressToId,
      new Map(),
      undefined,
      trackedStablecoinPrices,
    ).get("cadc-cad-coin")?.map((observation) => observation.price) ?? [];
    expect(observationPrices).toHaveLength(1);
    expect(observationPrices[0]).toBeCloseTo(1, 6);
  });

  it("publishes the neutral bucket and no fee rate when pool_fee is out of range", async () => {
    mockSugarPage(50_000n);

    const result = await fetchBaseSlipstreamPools();

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      poolType: "aerodrome-slipstream-unknown-fee",
      feeRate: null,
    });
  });

  it.each(["registered", "unregistered", "malformed", "unavailable"])("requires official factory membership for staged Slipstream recovery: %s", async (membership) => {
    const btcusd = "0xe4b20925d9e9a62f1e492e15a81dc0de62804dd4";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const pool = "0x516025f6ed7895b33754e131a09da83355a9ba1b";
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValueOnce(null);
    const encoded = (functionName: string, result: unknown) => encodeFunctionResult({
      abi: RECOVERY_ABI,
      functionName: functionName as never,
      result: result as never,
    });
    vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockResolvedValueOnce([
      { label: "cl-0-factory", success: true, returnData: encoded("factory", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A") },
      { label: "cl-0-token0", success: true, returnData: encoded("token0", usdc) },
      { label: "cl-0-token1", success: true, returnData: encoded("token1", btcusd) },
      { label: "cl-0-tickSpacing", success: true, returnData: encoded("tickSpacing", 1) },
      { label: "cl-0-slot0", success: true, returnData: encoded("slot0", [(1n << 96n) * 1_000_000n, 0, 0, 0, 0, true]) },
      { label: "cl-0-token-0-decimals", success: true, returnData: encoded("decimals", 18) },
      { label: "cl-0-token-0-balance", success: true, returnData: encoded("balanceOf", 1_000_000n * 10n ** 18n) },
      { label: "cl-0-token-1-decimals", success: true, returnData: encoded("decimals", 6) },
      { label: "cl-0-token-1-balance", success: true, returnData: encoded("balanceOf", 1_000_000n * 10n ** 6n) },
    ]);
    vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockResolvedValueOnce(membership === "unavailable" ? null : [
      { label: "cl-0-membership", success: true,
        returnData: membership === "malformed" ? "0x" : encoded("getPool", membership === "registered" ? pool : "0x0000000000000000000000000000000000000000") },
    ]);
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{
            pool_id: `base:${pool}`,
            base_token: btcusd,
            quote_token: usdc,
            fee_tier: 1,
          }] }),
        }),
      }),
    });

    const result = await fetchSlipstreamPools(
      "aerodrome-slipstream",
      new Map([
        [`base:${btcusd}`, "btcusd-btcfi"],
        [`base:${usdc}`, "usdc-circle"],
      ]),
      new Map(),
      new Map([
        ["btcusd-btcfi", 1],
        ["usdc-circle", 1],
      ]),
      undefined,
      undefined,
      db,
    );

    const membershipCalls = vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mock.calls[1]?.[1];
    expect(membershipCalls?.[0]?.target.toLowerCase()).toBe("0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a");
    if (membership !== "registered") {
      expect(result.pools).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ ok: true, degraded: true });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "aerodrome-slipstream",
      poolAddress: pool,
      poolType: "aerodrome-slipstream-1bp",
      tickSpacing: 1,
      tvlUsd: 2_000_000,
      price: 1,
    });
  });
  it.each(["coherent", "unavailable-header", "changed-header", "zero-balance", "untracked-token", "velodrome"])(
    "keeps seven staged candidates coherent across the slot0/balance chunk boundary: %s",
    async (scenario) => {
      const actualRpc = await vi.importActual<{ fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock }>("../../../lib/evm-rpc");
      vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(actualRpc.fetchEvmMulticall3Aggregate3AtBlock);
      vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(null);
      const protocol = scenario === "velodrome" ? "velodrome-slipstream" : "aerodrome-slipstream";
      const chain = scenario === "velodrome" ? "optimism" : "base";
      const factory = scenario === "velodrome" ? "0xcc0bddb707055e04e497ab22a59c2af4391cd12f" : "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a";
      const token0 = "0x00000000000000000000000000000000000000bb";
      const token1 = "0x00000000000000000000000000000000000000cc";
      const pools = Array.from({ length: 7 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
      const hash: `0x${string}` = `0x${"11".repeat(32)}`;
      if (scenario === "unavailable-header") vi.mocked(fetchEvmBlockHeader).mockResolvedValueOnce(null);
      if (scenario === "changed-header") vi.mocked(fetchEvmBlockHeader)
        .mockResolvedValueOnce({ number: 25_000_000, hash, timestamp: 1_791_184_659 })
        .mockResolvedValueOnce({ number: 25_000_000, hash: `0x${"22".repeat(32)}`, timestamp: 1_791_184_659 });
      const aggregateAbi = parseAbi([
        "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
      ]);
      const selectors: unknown[] = [];
      const chunkSizes: number[] = [];
      let latestHead = 0;
      let resultsIndex = 0;
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        selectors.push(request.params[1]);
        const calls = decodeFunctionData({ abi: aggregateAbi, data: request.params[0].data }).args![0];
        chunkSizes.push(calls.length);
        // Every aggregate advances latest and simulates a swap. Only the pin
        // keeps slot0 at call58 and token balances at call60/62 in one state.
        const pinned = request.params[1]?.blockHash === hash;
        const snapshot = pinned ? 1 : latestHead + 2;
        latestHead++;
        const results = calls.map((call) => {
          const decoded = decodeFunctionData({ abi: RECOVERY_ABI, data: call.callData });
          const value = decoded.functionName === "factory" ? factory
            : decoded.functionName === "token0" ? token0
            : decoded.functionName === "token1" ? token1
            : decoded.functionName === "tickSpacing" ? 1
            : decoded.functionName === "slot0" ? [(1n << 96n) * BigInt(snapshot), 0, 0, 0, 0, true]
            : decoded.functionName === "decimals" ? 6
            : decoded.functionName === "balanceOf" ? (scenario === "zero-balance" ? 0n : BigInt(snapshot) * 1_000_000n * 10n ** 6n)
            : pools[resultsIndex++];
          return { success: true, returnData: encodeFunctionResult({ abi: RECOVERY_ABI, functionName: decoded.functionName, result: value as never }) };
        });
        return Response.json({ jsonrpc: "2.0", id: request.id, result: encodeFunctionResult({ abi: aggregateAbi, functionName: "aggregate3", result: results }) });
      });
      vi.stubGlobal("fetch", transport);
      const db = makeNoopD1({ prepare: () => ({ bind: () => ({ all: async () => ({ results: pools.map((pool) => ({
        pool_id: `${chain}:${pool}`, base_token: token0, quote_token: token1, fee_tier: 5,
      })) }) }) }) });
      try {
        const tracked = new Map([[`${chain}:${token0}`, "usdc-circle"]]);
        if (scenario !== "untracked-token") tracked.set(`${chain}:${token1}`, "usdt-tether");
        const result = await fetchSlipstreamPools(protocol, tracked,
          new Map(), new Map([["usdc-circle", 1], ["usdt-tether", 1]]), undefined, makeChainRpcs([chain]), db);
        if (["unavailable-header", "changed-header", "zero-balance", "untracked-token"].includes(scenario)) expect(result.pools).toEqual([]);
        else {
          expect(result.pools).toHaveLength(7);
          for (const pool of result.pools) expect(pool).toMatchObject({ source: protocol, price: 1, tvlUsd: 2_000_000, feeRate: 0.0005, balances: [1_000_000, 1_000_000] });
        }
        if (["unavailable-header", "untracked-token"].includes(scenario)) expect(transport).not.toHaveBeenCalled();
        else {
          expect(chunkSizes).toEqual([60, 3, 7]);
          expect(selectors).toEqual(Array(3).fill({ blockHash: hash, requireCanonical: true }));
          expect(vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mock.calls.every((call) => call[2] === 25_000_000 && call[3]?.stateBlockHash === hash)).toBe(true);
        }
      } finally {
        vi.unstubAllGlobals();
        vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockReset();
      }
    },
  );
});
