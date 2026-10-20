import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";
import { captureQuoterV2Pools } from "../quoter-v2-pool-capture";
import { enrichQuoterV2ExecutionTargets, selectQuoterV2EnrichmentCandidates } from "../enrich-quoter-v2-targets";
import { getDexMeasuredExecutionDeployment, isDexMeasuredExecutionDeploymentScoreEligible } from "../../measured-execution/registry";
import { encodeQuoterV2ExactInputSingle, encodeV3FactoryGetPool } from "../../measured-execution/quoter-v2";
import type { LiquidityMetrics, PoolEntry } from "../types";
import { createSlotDeadline, type SlotDeadline } from "../../../lib/cron-timeouts";

const rpc = vi.hoisted(() => ({ fetchEvmBlockNumber: vi.fn(), fetchEvmBlockHeader: vi.fn(), fetchEvmMulticall3Aggregate3AtBlock: vi.fn() }));
vi.mock("../../../lib/evm-rpc", () => rpc);
const POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";
const TOKEN0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ABI = parseAbi([
  "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function getPool(address,address,uint24) view returns (address)",
]);
const SLIP_ABI = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
function receipt(label: string, functionName: string, result: unknown) {
  return { label, success: true, returnData: encodeFunctionResult({ abi: ABI, functionName: functionName as never, result: result as never }) };
}
function answers(profile = "uniswap-v3-quoter-v2", chain = "ethereum", parameter = 100, membership = POOL) {
  const slip = profile === "aerodrome-slipstream-quoter-v2";
  const deployment = getDexMeasuredExecutionDeployment(profile, chain)!;
  const state = [receipt("cl-0-factory", "factory", deployment.factoryAddress), receipt("cl-0-token0", "token0", TOKEN0),
    receipt("cl-0-token1", "token1", TOKEN1), receipt(`cl-0-${slip ? "tickSpacing" : "fee"}`, slip ? "tickSpacing" : "fee", parameter),
    receipt("cl-0-slot0", "slot0", [1n << 96n, 0])];
  const binding = [receipt("cl-0-membership", "getPool", membership),
    receipt("cl-0-token-0-decimals", "decimals", 6), receipt("cl-0-token-1-decimals", "decimals", 6),
    receipt("cl-0-token-0-balance", "balanceOf", 1_000_000n * 10n ** 6n), receipt("cl-0-token-1-balance", "balanceOf", 1_000_000n * 10n ** 6n)];
  rpc.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValueOnce(state).mockResolvedValueOnce(binding);
  return { state, binding };
}
function input(profile = "uniswap-v3-quoter-v2", chain = "ethereum"): Parameters<typeof captureQuoterV2Pools>[0] {
  return { adapterProfileId: profile, chain, candidates: [{ poolAddress: POOL }], chainAddressToId: new Map([[`${chain}:${TOKEN0}`, "usdc-circle"], [`${chain}:${TOKEN1}`, "usdt-tether"]]),
    trackedStablecoinPrices: new Map([["usdc-circle", 1], ["usdt-tether", 1]]) };
}
function row(project: string, chain: string, poolType: string, poolId = `${chain}:${POOL}`): PoolEntry {
  return { poolId, project, chain, poolType, symbol: "USDC / USDT", tvlUsd: 500_000, source: "cg_onchain", volumeUsd1d: 500, extra: {} } as PoolEntry;
}
async function enrich(pools: PoolEntry[], deadline?: SlotDeadline) {
  const options = input("uniswap-v3-quoter-v2", pools[0]!.chain);
  return enrichQuoterV2ExecutionTargets({ metrics: new Map([["usdc-circle", { topPools: pools } as LiquidityMetrics]]),
    chainAddressToId: options.chainAddressToId, stablecoinPriceById: options.trackedStablecoinPrices, capturedAt: 1_791_184_659,
    pancakeMeasuredTargets: new Map(), slipstreamMeasuredTargets: new Map(), deadline });
}

beforeEach(() => {
  rpc.fetchEvmBlockNumber.mockReset().mockResolvedValue(25_000_000);
  rpc.fetchEvmBlockHeader.mockReset().mockResolvedValue({ number: 25_000_000, hash: `0x${"11".repeat(32)}`, timestamp: 1_791_184_659 });
  rpc.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
});

describe("address-bound discovered QuoterV2 capture", () => {
  it.each([100, 500, 2500, 3000, 10000])("preserves actual fee %i, ordered currencies and same-block membership", async (fee) => {
    answers("uniswap-v3-quoter-v2", "ethereum", fee);
    const result = await captureQuoterV2Pools(input());
    expect(result.pools[0]).toMatchObject({ poolAddress: POOL, feeRate: fee / 1_000_000, tokens: [{ address: TOKEN0, decimals: 6 }, { address: TOKEN1, decimals: 6 }] });
    expect(result.blockNumber).toBe(25_000_000);
    expect(rpc.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.every((call) =>
      call[2] === result.blockNumber && call[3].stateBlockHash === `0x${"11".repeat(32)}`)).toBe(true);
  });
  it.each(["unavailable", "changed"])("withholds captured targets when the source header is %s", async (failure) => {
    answers();
    if (failure === "unavailable") rpc.fetchEvmBlockHeader.mockResolvedValueOnce(null);
    else rpc.fetchEvmBlockHeader
      .mockResolvedValueOnce({ number: 25_000_000, hash: `0x${"11".repeat(32)}`, timestamp: 1_791_184_659 })
      .mockResolvedValueOnce({ number: 25_000_000, hash: `0x${"22".repeat(32)}`, timestamp: 1_791_184_659 });
    expect(await captureQuoterV2Pools(input())).toMatchObject({
      pools: [], ok: false, degraded: true,
      errors: [failure === "unavailable" ? "cl-capture-header-unavailable" : "cl-capture-header-changed"],
    });
    if (failure === "unavailable") expect(rpc.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });
  it("accepts one-sided CL balances without pretending balance is unavailable", async () => {
    const { state, binding } = answers();
    rpc.fetchEvmMulticall3Aggregate3AtBlock.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce(binding.map((entry) => entry.label.endsWith("0-balance") ? receipt(entry.label, "balanceOf", 0n) : entry));
    expect((await captureQuoterV2Pools(input())).pools[0]?.balances).toEqual([0, 1_000_000]);
  });
  it("uses the signed tickSpacing factory selector, not a fee tier, for Slipstream", async () => {
    answers("aerodrome-slipstream-quoter-v2", "base", 200);
    const result = await captureQuoterV2Pools(input("aerodrome-slipstream-quoter-v2", "base"));
    expect(result.pools[0]).toMatchObject({ tickSpacing: 200, feeRate: null, source: "aerodrome-slipstream" });
    const membership = rpc.fetchEvmMulticall3Aggregate3AtBlock.mock.calls[1]![1][0];
    expect(decodeFunctionData({ abi: SLIP_ABI, data: membership.callData }).args).toEqual([expect.any(String), expect.any(String), 200]);
  });
  it("does not create a target for an unreviewed quoter", async () => {
    const result = await captureQuoterV2Pools(input("unverified-v3-quoter-v2", "hyperevm"));
    expect(result).toMatchObject({ ok: false, errors: ["quoter-v2-deployment-unreviewed"], pools: [] });
    expect(rpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
    expect(isDexMeasuredExecutionDeploymentScoreEligible("unverified-v3-quoter-v2", "hyperevm")).toBe(false);
  });
  it.each([
    ["hybra-v3-quoter-v2", "hyperevm"],
    ["velodrome-slipstream-quoter-v2", "optimism"],
    ["xswap-v3-quoter-v2", "xdc"],
  ])("refuses source-only or retired %s capture before opening transport", async (profile, chain) => {
    expect(await captureQuoterV2Pools(input(profile, chain))).toMatchObject({
      ok: false, errors: ["quoter-v2-deployment-unreviewed"], pools: [],
    });
    expect(rpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
  });
});

describe("retained discovered rows enter actual target production", () => {
  it("does not let a large first deployment starve another chain or fabricate execution on failure", async () => {
    rpc.fetchEvmBlockNumber.mockResolvedValue(null);
    const ethereum = Array.from({ length: 129 }, (_, index) =>
      row("uniswap-v3", "ethereum", "cg-concentrated", `ethereum:0x${(index + 1).toString(16).padStart(40, "0")}`));
    const bsc = row("pancakeswap", "bsc", "cg-concentrated");
    const result = await enrich([...ethereum, bsc]);
    expect(result).toMatchObject({ exactPoolCount: 0, exactCapableAssets: [] });
    expect(result.telemetry.find((entry) => entry.chain === "bsc")).toMatchObject({ attempted: 1, enriched: 0 });
    expect(result.telemetry.find((entry) => entry.chain === "ethereum")).toMatchObject({
      attempted: 127, enriched: 0, dropReasons: { "enrichment-cap": 2, "source-failure": 127 },
    });
    expect([...ethereum, bsc].every((pool) => pool.extra?.measuredExecutionTarget === undefined)).toBe(true);
  });
  it("clips capture to the original event deadline after a readiness wait", async () => {
    const nowMs = Date.now();
    const deadline = createSlotDeadline(nowMs);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline.platformDeadlineMs - 10_000);
    try {
      answers();
      await enrich([row("uniswap-v3", "ethereum", "cg-concentrated")], deadline);
      expect(rpc.fetchEvmMulticall3Aggregate3AtBlock.mock.calls[0]![3].deadlineMs).toBe(deadline.platformDeadlineMs);
    } finally {
      clock.mockRestore();
    }
  });
  it("does not issue capture requests after the executing event expires", async () => {
    const deadline = createSlotDeadline(Date.now() - 3_600_000);
    expect(await enrich([row("uniswap-v3", "ethereum", "cg-concentrated")], deadline))
      .toMatchObject({ exactPoolCount: 0, exactCapableAssets: [], telemetry: [{ candidates: 1, attempted: 0, enriched: 0, dropReasons: { "deadline-exhausted": 1 } }] });
    expect(rpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
  });

  it.each(["cg-concentrated", "cg-cl-1bp", "cg-cl-5bp"])("resolves Pancake %s using factory identity, not display fee", async (poolType) => {
    answers("pancakeswap-v3-quoter-v2", "bsc", 2500);
    const pool = row("pancakeswap", "bsc", poolType);
    expect(await enrich([pool])).toMatchObject({ exactPoolCount: 1, exactCapableAssets: ["usdc-circle"], telemetry: [{ adapterProfileId: "pancakeswap-v3-quoter-v2", chain: "bsc", candidates: 1, attempted: 1, enriched: 1, dropReasons: {} }] });
    expect(pool.extra?.measuredExecutionTarget).toMatchObject({ adapterProfileId: "pancakeswap-v3-quoter-v2", feePips: 2500, retainedTvlUsd: 500_000 });
  });
  it("collects Base Uniswap targets without activating a shadow deployment", async () => {
    answers("uniswap-v3-quoter-v2", "base");
    const pool = row("uniswap-v3", "base", "cg-concentrated");
    expect(await enrich([pool])).toMatchObject({ exactPoolCount: 1, exactCapableAssets: [] });
    expect(pool.extra?.measuredExecutionTarget?.chain).toBe("base");
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "base")).toBe(false);
  });
  it.each([
    ["uniswap-v3-quoter-v2", "uniswap-v3", "xlayer"],
    ["hyperswap-v3-quoter-v2", "hyperswap-v3", "hyperevm"],
    ["kodiak-v3-quoter-v2", "kodiak-v3", "berachain"],
    ["pancakeswap-v3-quoter-v2", "pancakeswap", "monad"],
  ])("collects %s without admitting new forks to scoring", async (profile, project, chain) => {
    answers(profile, chain, 100);
    const pool = row(project, chain, "cg-concentrated");
    expect(await enrich([pool])).toMatchObject({ exactPoolCount: 1, exactCapableAssets: [] });
    const target = pool.extra?.measuredExecutionTarget;
    expect(target).toMatchObject({ adapterProfileId: profile, protocol: project, chain });
    expect(isDexMeasuredExecutionDeploymentScoreEligible(profile, chain)).toBe(false);
    if (profile === "hyperswap-v3-quoter-v2") {
      expect(target?.feePips).toBe(100);
      expect(target?.tickSpacing).toBeUndefined();
      expect(decodeFunctionData({ abi: ABI, data: encodeV3FactoryGetPool(target!) }).args?.[2]).toBe(100);
      const quoteAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)"]);
      expect(decodeFunctionData({ abi: quoteAbi, data: encodeQuoterV2ExactInputSingle(target!, 1_000_000n) }).args?.[0]).toMatchObject({ fee: 100 });
    }
  });
  it("keeps a fingerprint with multiple possible physical pools unresolved", async () => {
    const pool = row("uniswap-v3", "ethereum", "cg-concentrated", `fp:ethereum:uniswap-v3:${TOKEN0}:${TOKEN1}`);
    expect(await enrich([pool])).toEqual({ exactPoolCount: 0, exactCapableAssets: [], telemetry: [] });
    expect(pool.extra?.measuredExecutionTarget).toBeUndefined();
    expect(rpc.fetchEvmBlockNumber).not.toHaveBeenCalled();
  });
});

describe("bounded quote identity rotation", () => {
  const addresses = Array.from({ length: 256 }, (_, index) =>
    `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`);

  it("eventually probes identities beyond the first 128 without widening the run cap", () => {
    const candidates = new Map([["uniswap-v3-quoter-v2:ethereum", addresses]]);
    const first = [...selectQuoterV2EnrichmentCandidates(candidates, 0).values()].flat();
    const second = [...selectQuoterV2EnrichmentCandidates(candidates, 3600).values()].flat();
    expect(first).toHaveLength(128);
    expect(second).toHaveLength(128);
    expect(new Set([...first, ...second]).size).toBe(256);
  });

  it("is stable under source insertion-order drift and rotates the first serialized deployment", () => {
    const candidates = new Map([["uniswap-v3-quoter-v2:ethereum", addresses], ["pancakeswap-v3-quoter-v2:bsc", addresses]]);
    const reversed = new Map([...candidates].reverse().map(([key, values]) => [key, [...values].reverse()]));
    expect(selectQuoterV2EnrichmentCandidates(candidates, 0)).toEqual(selectQuoterV2EnrichmentCandidates(reversed, 0));
    const first = selectQuoterV2EnrichmentCandidates(candidates, 0);
    const second = selectQuoterV2EnrichmentCandidates(candidates, 3600);
    expect([...first.values()].map((values) => values.length)).toEqual([64, 64]);
    expect([...first.keys()][0]).not.toBe([...second.keys()][0]);
  });
});
