import { describe, expect, it, vi } from "vitest";

import { buildRegisteredDexExecutionTarget, hasRegisteredDexExecutionTargetOutput } from "../../dex-liquidity/execution-target-registry";
import type { DexExecutionTargetFactoryInput } from "../../dex-liquidity/execution-target-registry";
import { makeDexExecutionTargetFactoryInput } from "../../../test-helpers/__shared/dex-execution-target";
import { buildPoolExecutionCapability } from "../../dex-liquidity/process-pool-execution-capability";
import { buildQuoterV2RegisteredExecutionTarget } from "../../dex-liquidity/execution-targets/quoter-v2";
import { buildUniswapV4RegisteredExecutionTarget } from "../../dex-liquidity/execution-targets/uniswap-v4";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../inventory";
import type { UniswapV4ExecutionCandidate } from "../inventory";
import {
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
} from "../uniswap-v4";

vi.mock("../../dex-liquidity/execution-targets/quoter-v2", { spy: true });
vi.mock("../../dex-liquidity/execution-targets/uniswap-v4", { spy: true });

const TOKEN0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const V3_POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";
const V4_POOL = computeUniswapV4PoolId({
  currency0: TOKEN0,
  currency1: TOKEN1,
  feePips: 100,
  tickSpacing: 1,
  hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
});

function factoryInput(
  protocol: "uniswap-v3" | "uniswap-v4",
  pool: string,
): DexExecutionTargetFactoryInput {
  const input = makeDexExecutionTargetFactoryInput("ethereum", protocol);
  return {
    ...input,
    context: {
      ...input.context,
      uniV3ExecutionCandidates: new Map(),
      uniswapV4ExecutionCandidates: new Map(),
      chainAddressToId: new Map([
        [`ethereum:${TOKEN0}`, "usdc-circle"],
        [`ethereum:${TOKEN1}`, "usdt-tether"],
      ]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([
        ["usdc-circle", 1],
        ["usdt-tether", 1],
      ]),
      measuredTargetCapturedAt: 1_785_000_000,
    },
    identity: {
      ...input.identity,
      protocol,
      chainNorm: "ethereum",
      pool: {
        pool,
        chain: "Ethereum",
        project: protocol,
        symbol: "USDC-USDT",
        poolMeta: "0.01%",
        tvlUsd: 1_000_000,
        volumeUsd1d: 1,
        volumeUsd7d: 1,
        stablecoin: true,
        underlyingTokens: [TOKEN0, TOKEN1],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "single",
        count: 2,
      },
    },
    enrichment: {
      ...input.enrichment,
      rawContribTvl: 1_000_000,
    },
  };
}

describe("registered concentrated execution-target factories", () => {
  it.each([
    ["uniswap-v3", false], ["uniswap-v3", true],
    ["uniswap-v4", false], ["uniswap-v4", true],
  ] as const)("resolves primary %s once with resolved=%s", (protocol, resolved) => {
    const input = factoryInput(protocol, protocol === "uniswap-v3" ? V3_POOL : V4_POOL);
    if (resolved) {
      const tokens = [{ address: TOKEN0, symbol: "USDC", decimals: 6 }, { address: TOKEN1, symbol: "USDT", decimals: 6 }] as const;
      if (protocol === "uniswap-v3") {
        input.context.uniV3ExecutionCandidates.set(buildUniV3ExecutionCandidateKey("ethereum", [TOKEN0, TOKEN1], 100)!, [
          { chain: "ethereum", poolAddress: V3_POOL, feePips: 100, tvlUsd: 1_000_000, token0Price: 1, token1Price: 1, tokens },
        ]);
      } else {
        const candidates = new Map<string, readonly UniswapV4ExecutionCandidate[]>();
        candidates.set(buildUniswapV4ExecutionCandidateKey("ethereum", [TOKEN0, TOKEN1], 100)!, [
          { chain: "ethereum", poolId: V4_POOL, feePips: 100, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
            activeLiquidity: "1000000", tvlUsd: 1_000_000, token0Price: 1, token1Price: 1, tokens },
        ]);
        input.context.uniswapV4ExecutionCandidates = candidates;
      }
    }
    const leaf = protocol === "uniswap-v3" ? buildQuoterV2RegisteredExecutionTarget : buildUniswapV4RegisteredExecutionTarget;
    const expected = leaf(input);
    vi.mocked(buildQuoterV2RegisteredExecutionTarget).mockClear();
    vi.mocked(buildUniswapV4RegisteredExecutionTarget).mockClear();
    const result = buildPoolExecutionCapability(input.context, input.identity, input.enrichment, input.stablecoinId);
    expect(result).toEqual(expected);
    expect(result.measuredExecutionTarget != null).toBe(resolved);
    expect(result.executionCapabilityGate?.reason).toBe(resolved ? undefined : "target-unresolved");
    expect(buildQuoterV2RegisteredExecutionTarget).toHaveBeenCalledTimes(1);
    expect(buildUniswapV4RegisteredExecutionTarget).toHaveBeenCalledTimes(1);
  });

  it("retains explicit undefined overwrites in closed dispatch", () => {
    vi.mocked(buildQuoterV2RegisteredExecutionTarget).mockReturnValueOnce({
      executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
    });
    vi.mocked(buildUniswapV4RegisteredExecutionTarget).mockReturnValueOnce({ executionCapabilityGate: undefined });
    const output = buildRegisteredDexExecutionTarget(factoryInput("uniswap-v4", V4_POOL));
    expect(output).toStrictEqual({ executionCapabilityGate: undefined });
    expect(hasRegisteredDexExecutionTargetOutput(output)).toBe(false);
  });

  it.each([-222031.942086, 0, 2514.771234, 50_000_000])(
    "admits the real thUSD exact PoolId independently of indexed TVL %s",
    (tvlUsd) => {
      // Ethereum Initialize block 24974199; Graph block 26088668, 2026-09-30.
      // https://etherscan.io/tx/0xdbfd03418344a5db0e0910874e6b15da64bd8edff032253e20de67e709918d7c
      const thusd = "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3";
      const poolId = "0xb30bf32e26a35328286df33c17dd01e1051b5e3a0ec55a4a211e6957594b5a0d";
      const input = factoryInput("uniswap-v4", poolId);
      input.stablecoinId = "thusd-theo";
      input.identity.pool.underlyingTokens = [TOKEN0, thusd];
      input.enrichment.rawContribTvl = 5_561_855;
      input.context.chainAddressToId.set(`ethereum:${thusd}`, "thusd-theo");
      input.context.stablecoinPriceById!.set("thusd-theo", 1);
      const key = buildUniswapV4ExecutionCandidateKey("ethereum", [TOKEN0, thusd], 100)!;
      input.context.uniswapV4ExecutionCandidates = new Map([[key, [{
        chain: "ethereum", poolId, feePips: 100, tickSpacing: 1,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS, activeLiquidity: "1215742317323",
        tvlUsd, token0Price: 0.9988856322499521, token1Price: 1.0011156109509132,
        tokens: [{ address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: thusd, symbol: "thUSD", decimals: 6 }],
      }]]]);
      expect(buildUniswapV4RegisteredExecutionTarget(input)?.measuredExecutionTarget)
        .toMatchObject({ poolId: `ethereum:${poolId}`, tokenIn: { trackedAssetId: "thusd-theo" } });
      input.identity.pool.underlyingTokens = [TOKEN0, TOKEN1];
      expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason)
        .toBe("target-unresolved");
      input.identity.pool.underlyingTokens = [TOKEN0, thusd];
      input.identity.pool.pool = V4_POOL;
      expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason)
        .toBe("target-unresolved");
      input.identity.pool.pool = "unresolved-uuid";
      expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason)
        .toBe("target-unresolved");
    },
  );

  it("keeps the two-percent affinity boundary and collision guard on token-fee fallback", () => {
    const input = factoryInput("uniswap-v4", "unresolved-uuid");
    const key = buildUniswapV4ExecutionCandidateKey("ethereum", [TOKEN0, TOKEN1], 100)!;
    const candidate = {
      chain: "ethereum", poolId: V4_POOL, feePips: 100, tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS, activeLiquidity: "1000000",
      tvlUsd: 1_019_999, token0Price: 1, token1Price: 1,
      tokens: [{ address: TOKEN0, symbol: "USDC", decimals: 6 },
        { address: TOKEN1, symbol: "USDT", decimals: 6 }],
    } as const;
    input.context.uniswapV4ExecutionCandidates = new Map([
      [key, [{ ...candidate, tokens: [...candidate.tokens] }]],
    ]);
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.measuredExecutionTarget?.poolId)
      .toBe(`ethereum:${V4_POOL}`);
    input.context.uniswapV4ExecutionCandidates = new Map([
      [key, [{ ...candidate, tvlUsd: 1_020_001, tokens: [...candidate.tokens] }]],
    ]);
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason)
      .toBe("target-unresolved");
    input.context.uniswapV4ExecutionCandidates = new Map([
      [key, [
        { ...candidate, tokens: [...candidate.tokens] },
        { ...candidate, tokens: [...candidate.tokens],
          hookAddress: "0x0000000000000000000000000000000000000001", activeLiquidity: "0" },
      ]],
    ]);
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.executionCapabilityGate?.reason)
      .toBe("target-unresolved");
  });
  it("joins an exact retained V3 pool when the token/fee key has siblings", () => {
    const input = factoryInput("uniswap-v3", `ethereum:${V3_POOL}`);
    const key = buildUniV3ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniV3ExecutionCandidates.set(key, [
      {
        chain: "ethereum",
        poolAddress: "0x1111111111111111111111111111111111111111",
        feePips: 100,
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
      {
        chain: "ethereum",
        poolAddress: V3_POOL,
        feePips: 100,
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
    ]);

    expect(buildQuoterV2RegisteredExecutionTarget(input)).toMatchObject({
      executionCapabilityGate: undefined,
      measuredExecutionTarget: {
        adapterProfileId: "uniswap-v3-quoter-v2",
        poolId: `ethereum:${V3_POOL}`,
        tokenIn: { trackedAssetId: "usdc-circle" },
      },
    });
  });

  it("fails closed when the retained V3 pool address does not match", () => {
    const input = factoryInput(
      "uniswap-v3",
      "ethereum:0x2222222222222222222222222222222222222222",
    );
    const key = buildUniV3ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniV3ExecutionCandidates.set(key, [{
      chain: "ethereum",
      poolAddress: V3_POOL,
      feePips: 100,
      tvlUsd: 1_000_000,
      token0Price: 1,
      token1Price: 1,
      tokens: [
        { address: TOKEN0, symbol: "USDC", decimals: 6 },
        { address: TOKEN1, symbol: "USDT", decimals: 6 },
      ],
    }]);

    expect(buildQuoterV2RegisteredExecutionTarget(input)).toEqual({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });
  });

  it("joins an exact 5-pip V4 pool despite DL rounding its fee to 0.00%", () => {
    const input = factoryInput("uniswap-v4", V4_POOL);
    input.identity.pool.poolMeta = "0.00%";
    const poolId = computeUniswapV4PoolId({
      currency0: TOKEN0, currency1: TOKEN1, feePips: 5, tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    input.identity.pool.pool = poolId;
    input.context.uniswapV4ExecutionCandidates = new Map([[
      buildUniswapV4ExecutionCandidateKey("ethereum", [TOKEN0, TOKEN1], 5)!,
      [{ chain: "ethereum", poolId, feePips: 5, tickSpacing: 1,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS, activeLiquidity: "1000000",
        tvlUsd: 1_000_000, token0Price: 1, token1Price: 1,
        tokens: [{ address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 }],
      }],
    ]]);
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.measuredExecutionTarget)
      .toMatchObject({ feePips: 5, poolId: `ethereum:${poolId}` });
    input.identity.pool.pool = "unresolved-uuid";
    expect(buildUniswapV4RegisteredExecutionTarget(input)?.measuredExecutionTarget).toBeUndefined();
  });

  it("selects the exact hook-free V4 PoolKey and rejects a hooked identity", () => {
    const input = factoryInput("uniswap-v4", V4_POOL);
    const hookedPool = computeUniswapV4PoolId({
      currency0: TOKEN0,
      currency1: TOKEN1,
      feePips: 100,
      tickSpacing: 1,
      hookAddress: "0x0000000000000000000000000000000000000001",
    });
    const key = buildUniswapV4ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniswapV4ExecutionCandidates = new Map([[key, [
      {
        chain: "ethereum",
        poolId: hookedPool,
        feePips: 100,
        tickSpacing: 1,
        hookAddress: "0x0000000000000000000000000000000000000001",
        activeLiquidity: "1000000",
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
      {
        chain: "ethereum",
        poolId: V4_POOL,
        feePips: 100,
        tickSpacing: 1,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
        activeLiquidity: "1000000",
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
    ]] as const]);

    expect(buildUniswapV4RegisteredExecutionTarget(input)).toMatchObject({
      executionCapabilityGate: undefined,
      measuredExecutionTarget: {
        adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
        poolId: `ethereum:${V4_POOL}`,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
      },
    });

    input.identity.pool.pool = hookedPool;
    expect(buildUniswapV4RegisteredExecutionTarget(input)).toEqual({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });
  });
});
