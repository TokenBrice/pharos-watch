import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { encodeFunctionResult, parseAbi } from "viem/utils";
import { convertToGtNewPools } from "../../../lib/dex-api-common";
import { captureClSourcePools, loadStagedPoolRecoveryRows, sqrtRatioToSpotPrice } from "../staged-pool-recovery";

const rpc = vi.hoisted(() => ({
  fetchEvmBlockNumber: vi.fn(), fetchEvmBlockHeader: vi.fn(), fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));
vi.mock("../../../lib/evm-rpc", () => rpc);

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("loadStagedPoolRecoveryRows", () => {
  it("breaks equal coin and TVL ties by source in both fee and TVL rankings", async () => {
    vi.useFakeTimers();
    const nowSec = 1_710_000_000;
    vi.setSystemTime(nowSec * 1_000);
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO dex_pool_registry
      (pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
       tvl_usd, fee_tier, base_token, quote_token, discovered_at, refreshed_at)
      VALUES ('ethereum:0xpool', 'usdc-circle', ?, 'ethereum', 'test', 'test',
              'USDC / USDT', 10000, 5, ?, '0xquote', ?, ?)`);
    // Insert in reverse source order so encounter order cannot select the winner.
    for (const source of ["gecko_terminal", "dexscreener", "cg_onchain"]) {
      insert.run(source, `0x${source}`, nowSec, nowSec);
    }

    expect(await loadStagedPoolRecoveryRows(db, { chain: "ethereum", dexId: "test" })).toEqual([
      { pool_id: "ethereum:0xpool", base_token: "0xcg_onchain", quote_token: "0xquote" },
    ]);
    expect(await loadStagedPoolRecoveryRows(db, { chain: "ethereum", dexId: "test", withFeeTier: true })).toEqual([
      { pool_id: "ethereum:0xpool", base_token: "0xcg_onchain", quote_token: "0xquote", fee_tier: 5 },
    ]);
  });
});
describe("sqrtRatioToSpotPrice", () => {
  it("returns 1.0 for a balanced sqrt price (Q96 == 2^96)", () => {
    // sqrt(1) * 2^96 = 2^96 → price = 1.0 (same decimals)
    const price = sqrtRatioToSpotPrice(1n << 96n, 6, 6);
    expect(price).toBeCloseTo(1, 3);
  });

  it("handles decimal adjustment across token decimals", () => {
    // Q96 balanced ratio with token0 6dec, token1 18dec:
    // priceRaw = 1.0, decimals adjust = 10^(6 - 18) = 10^-12
    const price = sqrtRatioToSpotPrice(1n << 96n, 6, 18);
    expect(price).toBeCloseTo(1e-12, 15);
  });

  it("retains precision when a tiny raw ratio becomes a normal human price after decimal adjustment", () => {
    const liveCadcUsdcSqrtRatio = 66_808_070_069_819_834_061_550n;
    const price = sqrtRatioToSpotPrice(liveCadcUsdcSqrtRatio, 18, 6);

    expect(price).toBeCloseTo(0.7110476163373841, 12);
  });

  it("handles large sqrt ratios without overflow", () => {
    // Uniswap V3 sqrtPriceX96 can reach ~2^160. Pick 2^140 as a well-above-safe-int test.
    const price = sqrtRatioToSpotPrice(1n << 140n, 18, 18);
    expect(Number.isFinite(price)).toBe(true);
    expect(price).toBeGreaterThan(0);
  });

  it("returns 0 for zero or negative sqrt ratio", () => {
    expect(sqrtRatioToSpotPrice(0n, 6, 6)).toBe(0);
    expect(sqrtRatioToSpotPrice(-1n, 6, 6)).toBe(0);
  });
});

describe("captureClSourcePools", () => {
  const pool = "0x0000000000000000000000000000000000000001";
  const factory = "0x0000000000000000000000000000000000000002";
  const token0 = "0x0000000000000000000000000000000000000003";
  const token1 = "0x0000000000000000000000000000000000000004";
  const abi = parseAbi([
    "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
    "function fee() view returns (uint24)", "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
    "function getPool(address,address,uint24) view returns (address)",
    "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  ]);
  const receipt = (label: string, functionName: string, result: unknown) => ({
    label: `cl-0-${label}`, success: true,
    returnData: encodeFunctionResult({ abi, functionName: functionName as never, result: result as never }),
  });
  function capture() {
    return captureClSourcePools({
      chain: "ethereum", factoryAddress: factory, candidates: [{ poolAddress: pool, expectedTokens: new Set([token0, token1]) }],
      parameterName: "fee", maxParameter: 1_000_000, valuation: "pool-implied",
      chainAddressToId: new Map([[`ethereum:${token0}`, "usdc-circle"]]),
      trackedStablecoinPrices: new Map([["usdc-circle", 1]]), options: {},
    });
  }
  beforeEach(() => {
    rpc.fetchEvmBlockNumber.mockReset().mockResolvedValue(100);
    rpc.fetchEvmBlockHeader.mockReset().mockResolvedValue({ number: 100, hash: `0x${"11".repeat(32)}`, timestamp: 1_791_184_659 });
    rpc.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });
  it.each(["valid", "factory", "membership", "tokens", "decimals", "balance", "slot0"])("admits only complete bound source state: %s", async (failure) => {
    const state = [
      receipt("factory", "factory", failure === "factory" ? pool : factory),
      receipt("token0", "token0", token0), receipt("token1", "token1", failure === "tokens" ? factory : token1),
      receipt("fee", "fee", 100), receipt("slot0", "slot0", [failure === "slot0" ? 0n : 1n << 96n, 0]),
      receipt("token-0-decimals", "decimals", 6), receipt("token-1-decimals", "decimals", 6),
      receipt("token-0-balance", "balanceOf", 1_000_000n), receipt("token-1-balance", "balanceOf", 2_000_000n),
    ].map((entry) => entry.label === `cl-0-token-0-${failure}` ? { ...entry, success: false } : entry);
    rpc.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValueOnce(state)
      .mockResolvedValueOnce([receipt("membership", "getPool", failure === "membership" ? factory : pool)]);
    const result = await capture();
    if (failure !== "valid") expect(result.pools).toEqual([]);
    else expect(result.pools).toMatchObject([{ price: 1, tvlUsd: 3, balances: [1, 2], tokens: [{ priceUsd: 1 }, { priceUsd: 1 }] }]);
  });

  it("values tracked-positive recovery from its references without republishing them as pool prices", async () => {
    rpc.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValueOnce([
      receipt("factory", "factory", factory),
      receipt("token0", "token0", token0), receipt("token1", "token1", token1),
      receipt("fee", "fee", 100), receipt("slot0", "slot0", [1n << 96n, 0]),
      receipt("token-0-decimals", "decimals", 6), receipt("token-1-decimals", "decimals", 6),
      receipt("token-0-balance", "balanceOf", 1_000_000n * 10n ** 6n),
      receipt("token-1-balance", "balanceOf", 2_000_000n * 10n ** 6n),
    ]).mockResolvedValueOnce([receipt("membership", "getPool", pool)]);
    const chainAddressToId = new Map([
      [`ethereum:${token0}`, "usdc-circle"],
      [`ethereum:${token1}`, "usdt-tether"],
    ]);
    // USDC's trusted primary reads 1.02 while the pool still quotes both legs
    // at 1:1: the references value the pool, but its own primary is not
    // evidence of what the pool says.
    const trackedStablecoinPrices = new Map([["usdc-circle", 1.02], ["usdt-tether", 1]]);
    const result = await captureClSourcePools({
      chain: "ethereum", factoryAddress: factory, candidates: [{ poolAddress: pool, expectedTokens: new Set([token0, token1]) }],
      parameterName: "fee", maxParameter: 1_000_000, valuation: "tracked-positive",
      chainAddressToId, trackedStablecoinPrices, options: {},
    });
    expect(result.pools[0]!.tvlUsd).toBeCloseTo(3_020_000, 6);
    expect(result.pools[0]!.tokens.map((token) => token.priceUsd)).toEqual([undefined, undefined]);

    const captured = result.pools[0]!;
    const shapedPrices = convertToGtNewPools([{
      source: "aerodrome-slipstream", chain: "ethereum", poolAddress: captured.candidate.poolAddress,
      poolType: "aerodrome-slipstream-unknown-fee", tokens: captured.tokens, price: captured.price,
      tvlUsd: captured.tvlUsd, volume24hUsd: null, feeRate: null, tickSpacing: captured.parameter,
      balances: captured.balances,
    }], chainAddressToId, new Map(), undefined, trackedStablecoinPrices).get("usdc-circle")?.map((entry) => entry.price) ?? [];
    expect(shapedPrices).toHaveLength(1);
    expect(shapedPrices[0]).toBeCloseTo(1, 6);
  });
});
