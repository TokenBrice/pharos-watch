import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi, parseAbiParameters } from "viem/utils";
import { initMetrics } from "../pool-helpers";
import { enrichUniswapV4ExecutionTargets, readUniswapV4ExecutionCandidate, resolveUniswapV4InitializePoolKey } from "../uniswap-v4-identity";
import { computeUniswapV4PoolId, getUniswapV4Deployment, UNISWAP_V4_HOOK_FREE_ADDRESS } from "../../measured-execution/uniswap-v4";
import { isDexMeasuredExecutionTargetScoreEligible } from "../../measured-execution/admission";
import type { PoolEntry } from "../types";

const TOKEN0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const BLOCK = 26_088_668;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const KEY = { currency0: TOKEN0, currency1: TOKEN1, feePips: 5, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS } as const;
const POOL_ID = computeUniswapV4PoolId(KEY);
const EVENT_ABI = parseAbi(["event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)"]);
const STATE_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const TOKEN_ABI = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
type InitializePoolKey = Parameters<typeof computeUniswapV4PoolId>[0];

function initializeLog(chain = "ethereum", key: InitializePoolKey = KEY) {
  return {
    address: getUniswapV4Deployment(chain)!.poolManagerAddress,
    blockNumber: "0x17d1327", blockHash: BLOCK_HASH, removed: false,
    topics: encodeEventTopics({ abi: EVENT_ABI, eventName: "Initialize", args: { id: computeUniswapV4PoolId(key), currency0: key.currency0, currency1: key.currency1 } }),
    data: encodeAbiParameters(parseAbiParameters("uint24,int24,address,uint160,int24"), [key.feePips, key.tickSpacing, key.hookAddress, 2n ** 96n, 0]),
  };
}

function fixture(chain = "ethereum") {
  const timestamp = Math.floor(Date.now() / 1_000) - 60;
  const deployment = getUniswapV4Deployment(chain)!;
  const dependencies = {
    blockNumber: vi.fn().mockResolvedValue(BLOCK),
    header: vi.fn().mockResolvedValue({ number: BLOCK, timestamp, hash: BLOCK_HASH }),
    verify: vi.fn().mockResolvedValue({ ok: true }),
    rpcBatch: vi.fn().mockResolvedValue([[initializeLog(chain)]]),
    storage: vi.fn().mockResolvedValue(null),
    multicall: vi.fn().mockResolvedValue([
      { label: "slot0", success: true, returnData: encodeFunctionResult({ abi: STATE_ABI, functionName: "getSlot0", result: [2n ** 96n, 0, 0, KEY.feePips] }) },
      { label: "liquidity", success: true, returnData: encodeFunctionResult({ abi: STATE_ABI, functionName: "getLiquidity", result: 10_000_000_000n }) },
      { label: "decimals0", success: true, returnData: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", result: 6 }) },
      { label: "symbol0", success: true, returnData: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "symbol", result: "USDC" }) },
      { label: "decimals1", success: true, returnData: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", result: 6 }) },
      { label: "symbol1", success: true, returnData: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "symbol", result: "USDT" }) },
    ]),
  };
  const pool: PoolEntry = {
    poolId: `${chain}:${POOL_ID}`, chain, project: "uniswap-v4", source: "cg_onchain",
    poolType: "cg-concentrated", symbol: "USDC / USDT 0.00%", tvlUsd: 2_000_000,
    volumeUsd1d: null, extra: { measurement: { tvlMeasured: true, volumeMeasured: false, balanceMeasured: false, maturityMeasured: false, priceMeasured: true, synthetic: false } },
  };
  const metric = initMetrics("usdc-circle", "USDC");
  metric.topPools.push(pool);
  const input = {
    metrics: new Map([["usdc-circle", metric]]),
    chainAddressToId: new Map([[`${chain}:${TOKEN0}`, "usdc-circle"], [`${chain}:${TOKEN1}`, "usdt-tether"]]),
    stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
    chainRpcs: new Map(), dependencies,
  };
  return { input, dependencies, deployment, pool, timestamp };
}

describe("on-chain V4 PoolKey resolution", () => {
  it("recovers a 5-pip key without interpreting the rounded discovery fee", () => {
    expect(resolveUniswapV4InitializePoolKey({ logs: [initializeLog()], poolId: POOL_ID, poolManagerAddress: getUniswapV4Deployment("ethereum")!.poolManagerAddress, blockNumber: BLOCK })).toEqual(KEY);
  });

  it("rejects hooked, ambiguous, removed, foreign-manager and hash-inconsistent events", () => {
    const log = initializeLog();
    const hooked: InitializePoolKey = { ...KEY, hookAddress: "0x0000000000000000000000000000000000000080" };
    for (const logs of [[], [log, log], [{ ...log, removed: true }], [{ ...log, address: TOKEN0 }], [initializeLog("ethereum", hooked)], [{ ...log, data: initializeLog("ethereum", { ...KEY, feePips: 100 }).data }]]) {
      expect(resolveUniswapV4InitializePoolKey({ logs, poolId: POOL_ID, poolManagerAddress: getUniswapV4Deployment("ethereum")!.poolManagerAddress, blockNumber: BLOCK })).toBeNull();
    }
  });

  it("finds the exact Initialize block from authoritative state when an RPC refuses an all-history log range", async () => {
    const f = fixture("tempo");
    const birthBlock = 25_000_001;
    const log = { ...initializeLog("tempo"), blockNumber: `0x${birthBlock.toString(16)}` };
    f.dependencies.rpcBatch.mockResolvedValueOnce(null).mockResolvedValueOnce([[log]]);
    f.dependencies.storage.mockImplementation(async (_chain, _manager, _slot, block) =>
      `0x${(block < birthBlock ? 0n : 2n ** 96n).toString(16).padStart(64, "0")}`);
    const candidate = await readUniswapV4ExecutionCandidate({
      deployment: f.deployment, poolId: POOL_ID, retainedTvlUsd: 2_000_000,
      blockNumber: BLOCK, rpcOptions: { stateBlockHash: BLOCK_HASH }, dependencies: f.dependencies,
    });
    expect(candidate).toMatchObject({ poolId: POOL_ID, feePips: 5, tickSpacing: 1 });
    const range = f.dependencies.rpcBatch.mock.calls[1]![1][0].params[0];
    expect(range.fromBlock).toBe(`0x${birthBlock.toString(16)}`);
    expect(range.toBlock).toBe(range.fromBlock);
    expect(f.dependencies.storage.mock.calls.length).toBeLessThanOrEqual(34);
    expect(f.dependencies.storage.mock.calls.find((call) => call[3] !== BLOCK)?.[4].stateBlockHash).toBeUndefined();
  });

  it("does not interpret an unavailable archive read as pre-initialization zero", async () => {
    const f = fixture("tempo");
    f.dependencies.rpcBatch.mockResolvedValueOnce(null);
    expect(await readUniswapV4ExecutionCandidate({
      deployment: f.deployment, poolId: POOL_ID, retainedTvlUsd: 2_000_000,
      blockNumber: BLOCK, rpcOptions: {}, dependencies: f.dependencies,
    })).toBeNull();
    expect(f.dependencies.multicall).not.toHaveBeenCalled();
  });

  it("requires the current StateView fee and positive in-range liquidity", async () => {
    for (const badState of ["fee", "liquidity", "undecodable"] as const) {
      const f = fixture();
      const rows = await f.dependencies.multicall();
      if (badState === "fee") rows[0].returnData = encodeFunctionResult({ abi: STATE_ABI, functionName: "getSlot0", result: [2n ** 96n, 0, 0, 100] });
      if (badState === "liquidity") rows[1].returnData = encodeFunctionResult({ abi: STATE_ABI, functionName: "getLiquidity", result: 0n });
      if (badState === "undecodable") rows[2].returnData = "0x";
      expect(await readUniswapV4ExecutionCandidate({ deployment: f.deployment, poolId: POOL_ID, retainedTvlUsd: 2_000_000, blockNumber: BLOCK, rpcOptions: {}, dependencies: f.dependencies })).toBeNull();
    }
  });
});

describe("retained V4 target recovery", () => {
  it.each(["cg_onchain", "dl"] as const)("turns a %s retained physical pool into the exact target without changing provider measurements", async (source) => {
    const f = fixture();
    f.pool.source = source;
    if (source === "dl") f.pool.poolType = "generic";
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toMatchObject({ poolId: `ethereum:${POOL_ID}`, poolTokenAddresses: [TOKEN0, TOKEN1], feePips: 5, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS, capturedAt: f.timestamp });
    expect(f.pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(f.pool).toMatchObject({ source, tvlUsd: 2_000_000, volumeUsd1d: null });
    expect(f.pool.extra?.measurement?.balanceMeasured).toBe(false);
    expect(f.dependencies.rpcBatch.mock.calls[0]![1][0].params[0].topics[1]).toBe(POOL_ID);
  });

  it.each(["base", "bsc", "polygon", "arbitrum", "unichain", "tempo"])("does not grant %s score eligibility merely because identity/deployment recovery succeeded", async (chain) => {
    const f = fixture(chain);
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toBeDefined();
    expect(isDexMeasuredExecutionTargetScoreEligible(f.pool.extra!.measuredExecutionTarget!)).toBe(false);
  });

  it("accepts an exact bare PoolId without a chain prefix", async () => {
    const f = fixture();
    f.pool.poolId = POOL_ID;
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toBeDefined();
  });

  it("fails closed before PoolKey reads when the new chain's deployment verification fails", async () => {
    const f = fixture("base");
    f.dependencies.verify.mockResolvedValue({ ok: false, reason: "pool-manager-code-hash-mismatch" });
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toBeUndefined();
    expect(f.pool.extra?.executionCapabilityGate?.reason).toBe("target-unresolved");
    expect(f.pool.extra?.measuredExecutionDiagnostic?.detail).toBe("pool-manager-code-hash-mismatch");
    expect(f.dependencies.rpcBatch).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Initialize result target-unresolved", async () => {
    const f = fixture();
    f.dependencies.rpcBatch.mockResolvedValue([[initializeLog(), initializeLog()]]);
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toBeUndefined();
    expect(f.pool.extra?.executionCapabilityGate?.reason).toBe("target-unresolved");
    expect(f.dependencies.multicall).not.toHaveBeenCalled();
  });

  it("does not publish pending targets after a pinned-block reorg", async () => {
    const f = fixture();
    f.dependencies.header.mockResolvedValueOnce({ number: BLOCK, timestamp: f.timestamp, hash: BLOCK_HASH });
    f.dependencies.header.mockResolvedValueOnce({ number: BLOCK, timestamp: f.timestamp, hash: `0x${"cd".repeat(32)}` });
    await enrichUniswapV4ExecutionTargets(f.input);
    expect(f.pool.extra?.measuredExecutionTarget).toBeUndefined();
    expect(f.pool.extra?.measuredExecutionDiagnostic?.detail).toBe("identity-block-reorg-or-unavailable");
  });

  it("refuses fingerprints, foreign chain prefixes, untracked inputs, and decayed rows", async () => {
    for (const mode of ["fingerprint", "foreign-chain", "long-prefix", "extra-colon", "wrong-asset", "decayed"] as const) {
      const f = fixture();
      if (mode === "fingerprint") f.pool.poolId = `fp:ethereum:${POOL_ID}`;
      if (mode === "foreign-chain") f.pool.poolId = `base:${POOL_ID}`;
      if (mode === "long-prefix") f.pool.poolId = `ethereum${"a".repeat(10_000)}:${POOL_ID}`;
      if (mode === "extra-colon") f.pool.poolId = `ethereum::${POOL_ID}`;
      if (mode === "wrong-asset") f.input.chainAddressToId.delete(`ethereum:${TOKEN0}`);
      if (mode === "decayed") f.pool.extra!.measurement!.decayed = true;
      await enrichUniswapV4ExecutionTargets(f.input);
      expect(f.pool.extra?.measuredExecutionTarget).toBeUndefined();
    }
  });
});
