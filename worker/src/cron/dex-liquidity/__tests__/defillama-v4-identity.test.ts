import { describe, expect, it } from "vitest";
import { attachDefiLlamaV4PoolIdentities } from "../defillama-v4-identity";
import type { LlamaPool } from "../types";
import type { DexExecutionTargetFactoryInput } from "../execution-target-registry";
import { buildUniswapV4RegisteredExecutionTarget } from "../execution-targets/uniswap-v4";
import { buildUniswapV4ExecutionCandidateKey, type UniswapV4ExecutionCandidate } from "../../measured-execution/inventory";
import { computeUniswapV4PoolId, UNISWAP_V4_HOOK_FREE_ADDRESS } from "../../measured-execution/uniswap-v4";
import { isDexMeasuredExecutionTargetScoreEligible } from "../../measured-execution/admission";

const UUID = "0899ff3d-adc8-4dae-a516-a94998db3332";
const POOL = "0xe63e32b2ae40601662f760d6bf5d771057324fbd97784fe1d3717069f7b75d45";
const TOKENS = ["0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0xdc035d45d973e3ec169d2276ddab16f1e407384f"];
const row = { pool: UUID, project: "uniswap-v4", chain: "Ethereum", underlyingTokens: TOKENS, pool_old: `${POOL}-ethereum-uniswap-v4` };
function pool(): LlamaPool {
  return { ...row, poolMeta: "0.00%", tvlUsd: 100125999 } as unknown as LlamaPool;
}

describe("DefiLlama V4 exact UUID identity", () => {
  it("recovers the real 5-pip PYUSD/USDS identity without interpreting rounded fee metadata", () => {
    const pools = [pool()];
    expect(attachDefiLlamaV4PoolIdentities(pools, { data: [{ ...row, tvlUsd: 1 }] })).toBe(1);
    expect(pools[0]).toMatchObject({ pool: POOL, poolMeta: "0.00%", tvlUsd: 100125999 });
  });

  it.each([
    { ...row, pool: "another-uuid" },
    { ...row, chain: "Base" },
    { ...row, project: "uniswap-v3" },
    { ...row, pool_old: `${POOL}-base-uniswap-v4` },
    { ...row, underlyingTokens: [TOKENS[0], TOKENS[0]] },
    { ...row, underlyingTokens: [TOKENS[0], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"] },
  ])("rejects mismatched source identity %#", (invalid) => {
    const pools = [pool()];
    expect(attachDefiLlamaV4PoolIdentities(pools, { data: [invalid] })).toBe(0);
    expect(pools[0]!.pool).toBe(UUID);
  });

  it("fails closed on duplicate UUIDs and malformed or over-budget payloads", () => {
    for (const payload of [{ data: [row, row] }, { data: Array(2001).fill(row) }, { data: null }, null]) {
      const pools = [pool()];
      expect(attachDefiLlamaV4PoolIdentities(pools, payload)).toBe(0);
      expect(pools[0]!.pool).toBe(UUID);
    }
  });
});

const CURRENCIES = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
] as const;

function exactInput(chain = "ethereum", hookAddress: `0x${string}` = UNISWAP_V4_HOOK_FREE_ADDRESS): DexExecutionTargetFactoryInput {
  const candidate: UniswapV4ExecutionCandidate = {
    chain,
    poolId: computeUniswapV4PoolId({
      currency0: CURRENCIES[0], currency1: CURRENCIES[1],
      feePips: 750, tickSpacing: 15, hookAddress,
    }),
    feePips: 750,
    tickSpacing: 15,
    hookAddress,
    activeLiquidity: "1000000",
    tvlUsd: 1_000_000,
    token0Price: 1,
    token1Price: 1,
    tokens: [
      { address: CURRENCIES[0], symbol: "USDC", decimals: 6 },
      { address: CURRENCIES[1], symbol: "USDT", decimals: 6 },
    ],
  };
  return {
    stablecoinId: "usdc-circle",
    context: {
      uniswapV4ExecutionCandidates: new Map([[
        buildUniswapV4ExecutionCandidateKey(chain, CURRENCIES, 750)!, [candidate],
      ]]),
      chainAddressToId: new Map([
        [`${chain}:${CURRENCIES[0]}`, "usdc-circle"],
        [`${chain}:${CURRENCIES[1]}`, "usdt-tether"],
      ]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
      measuredTargetCapturedAt: 1_791_146_773,
    } as unknown as DexExecutionTargetFactoryInput["context"],
    identity: {
      protocol: "uniswap-v4", chainNorm: chain,
      pool: { ...pool(), pool: `${chain}:${candidate.poolId}`, underlyingTokens: [...CURRENCIES], poolMeta: null },
    } as DexExecutionTargetFactoryInput["identity"],
    enrichment: { rawContribTvl: 1_000_000 } as DexExecutionTargetFactoryInput["enrichment"],
  };
}

describe("V4 recovered exact PoolKey admission", () => {
  it.each([null, "0.08%"])("uses source fee/tick facts rather than missing/rounded display metadata %s", (poolMeta) => {
    const input = exactInput();
    input.identity.pool.poolMeta = poolMeta;
    const target = buildUniswapV4RegisteredExecutionTarget(input)?.measuredExecutionTarget;
    expect(target).toMatchObject({ chain: "ethereum", feePips: 750, tickSpacing: 15, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS });
    expect(isDexMeasuredExecutionTargetScoreEligible(target!)).toBe(true);
  });

  it.each(["base", "bsc", "arbitrum", "polygon"])("keeps recovered %s PoolKeys shadow-only", (chain) => {
    const target = buildUniswapV4RegisteredExecutionTarget(exactInput(chain))?.measuredExecutionTarget;
    expect(target).toBeDefined();
    expect(isDexMeasuredExecutionTargetScoreEligible(target!)).toBe(false);
  });

  it("rejects hooked keys, missing currency/fee facts, and duplicate source packets", () => {
    const hooked = exactInput("ethereum", "0x0000000000000000000000000000000000000080");
    expect(buildUniswapV4RegisteredExecutionTarget(hooked)?.executionCapabilityGate?.reason).toBe("target-unresolved");
    for (const mutation of ["currencies", "fee", "duplicate"] as const) {
      const input = exactInput();
      const candidates = [...input.context.uniswapV4ExecutionCandidates.values()][0]!;
      if (mutation === "currencies") input.identity.pool.underlyingTokens = null;
      if (mutation === "fee") candidates[0]!.feePips = Number.NaN;
      if (mutation === "duplicate") {
        const key = buildUniswapV4ExecutionCandidateKey("ethereum", CURRENCIES, 750)!;
        input.context.uniswapV4ExecutionCandidates = new Map([[key, [...candidates, { ...candidates[0]! }]]]);
      }
      expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason).toBe("target-unresolved");
    }
  });

  it.each(["fp:ethereum:", "base:", "not-a-pool-"])("does not promote an exact-looking suffix with prefix %s", (prefix) => {
    const input = exactInput();
    input.identity.pool.pool = `${prefix}${input.identity.pool.pool.split(":")[1]}`;
    input.identity.pool.poolMeta = "0.075%";
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });
});
