import { afterEach, describe, expect, it, vi } from "vitest";

import type { DexApiPool } from "../../../lib/dex-api-common";
import {
  buildUniV3ExecutionCandidateKey,
  type UniV3ExecutionCandidate,
} from "../../measured-execution/inventory";
import {
  buildPoolExecutionCapability,
  buildRegisteredDirectApiExecutionTarget,
} from "../process-pool-execution-capability";
import { buildUniV3MessariPoolQuery, buildUniV3PoolQuery } from "../constants";
import { fetchUniV3Data } from "../subgraph-source-families";
import { isDexMeasuredExecutionDeploymentScoreEligible } from "../../measured-execution/registry";
import type { PoolProcessingContext, PoolProtocolEnrichment, ResolvedPoolIdentity } from "../process-pool-types";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";

function candidate(overrides: Partial<UniV3ExecutionCandidate> = {}): UniV3ExecutionCandidate {
  return {
    chain: "ethereum",
    poolAddress: POOL,
    feePips: 100,
    tvlUsd: 1_000_000,
    token0Price: 1,
    token1Price: 1,
    tokens: [
      { address: USDC, symbol: "USDC", decimals: 6 },
      { address: USDT, symbol: "USDT", decimals: 6 },
    ],
    ...overrides,
  };
}

function buildTarget(
  feeRate: number | null,
  candidates: UniV3ExecutionCandidate[] = [candidate()],
  underlyingTokens = [USDC, USDT],
  poolAddress = POOL,
) {
  const buckets = new Map<string, UniV3ExecutionCandidate[]>();
  for (const entry of candidates) {
    const key = buildUniV3ExecutionCandidateKey(
      entry.chain, entry.tokens.map((token) => token.address), entry.feePips,
    )!;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  const pool: DexApiPool = {
    source: "uniswap-v3-shadow",
    chain: "ethereum",
    poolAddress,
    poolType: "uniswap-v3-unknown-fee",
    tokens: underlyingTokens.map((address, index) => ({
      address, symbol: index === 0 ? "USDC" : "USDT", decimals: 6,
    })),
    price: 1,
    tvlUsd: 1_000_000,
    volume24hUsd: 50_000,
    feeRate,
    balances: null,
  };
  return buildRegisteredDirectApiExecutionTarget({
    pool,
    stablecoinId: "usdc-circle",
    chainAddressToId: new Map([
      [`ethereum:${USDC}`, "usdc-circle"],
      [`ethereum:${USDT}`, "usdt-tether"],
    ]),
    symbolToChainScopedIds: new Map(),
    stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
    validationReferences: { rates: {}, type: "none", updatedAt: null },
    executionTargetContext: {
      uniV3ExecutionCandidates: buckets,
      uniswapV4ExecutionCandidates: new Map(),
      measuredTargetCapturedAt: 1_790_835_011,
      contractMetaByChainAddress: new Map(),
    },
  });
}

describe("registered QuoterV2 exact identity", () => {
  it.each([null, 0.003])("uses the exact source fee when display fee is %s", (feeRate) => {
    const result = buildTarget(feeRate);
    expect(result?.executionCapabilityGate).toBeUndefined();
    expect(result?.measuredExecutionTarget).toMatchObject({
      poolId: `ethereum:${POOL}`,
      feePips: 100,
      poolTokenAddresses: [USDC, USDT],
      tokenIn: { address: USDC, trackedAssetId: "usdc-circle" },
      tokenOut: { address: USDT, trackedAssetId: "usdt-tether" },
    });
  });

  it("does not substitute a different same-token pool for an exact address", () => {
    const result = buildTarget(null, [candidate({ poolAddress: "0x0000000000000000000000000000000000000001" })]);
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("rejects an exact-address candidate with different currencies", () => {
    const result = buildTarget(null, [candidate()], [USDC, "0x0000000000000000000000000000000000000002"]);
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("does not reuse an equal address on another chain", () => {
    const result = buildTarget(null, [candidate({ chain: "base" })]);
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("does not treat a fingerprint's trailing token address as an exact pool", () => {
    const result = buildTarget(
      0.0001,
      [candidate(), candidate({ poolAddress: "0x0000000000000000000000000000000000000001" })],
      [USDC, USDT],
      `fp:ethereum:uniswap-v3:${USDC}:${POOL}`,
    );
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("fails closed when an exact address has conflicting source fee packets", () => {
    const result = buildTarget(null, [candidate(), candidate({ feePips: 3000 })]);
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("recovers a missing fingerprint fee only from one actual source pool", () => {
    const result = buildTarget(null, [candidate()], [USDT, USDC], `fp:ethereum:uniswap-v3:${USDC}:${USDT}`);
    expect(result?.measuredExecutionTarget).toMatchObject({ poolId: `ethereum:${POOL}`, feePips: 100 });
  });

  it.each([100, 3000])("keeps a missing-fee fingerprint unresolved with parallel fee %s", (feePips) => {
    const result = buildTarget(
      null,
      [candidate(), candidate({ feePips, poolAddress: "0x0000000000000000000000000000000000000001" })],
      [USDC, USDT],
      `fp:ethereum:uniswap-v3:${USDC}:${USDT}`,
    );
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("does not broaden an explicitly known fingerprint fee", () => {
    const result = buildTarget(0.003, [candidate()], [USDC, USDT], `fp:ethereum:uniswap-v3:${USDC}:${USDT}`);
    expect(result?.measuredExecutionTarget).toBeUndefined();
    expect(result?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("does not admit an unsupported QuoterV2 chain", () => {
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "optimism")).toBe(false);
  });

  it("does not use a display-enrichment minimum fee to choose an ambiguous primary pool", () => {
    const first = candidate();
    const second = candidate({ feePips: 3000, poolAddress: "0x0000000000000000000000000000000000000001" });
    const context: PoolProcessingContext = {
      pools: [],
      dexProjects: new Set(),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
      chainAddressToId: new Map([[`ethereum:${USDC}`, "usdc-circle"], [`ethereum:${USDT}`, "usdt-tether"]]),
      stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
      symbolToChainScopedIds: new Map(),
      measuredTargetCapturedAt: 1_790_835_011,
      curvePoolCandidatesByFingerprint: new Map(),
      uniswapV4ExecutionCandidates: new Map(),
      uniV3ExecutionCandidates: new Map([
        [buildUniV3ExecutionCandidateKey("ethereum", [USDC, USDT], 100)!, [first]],
        [buildUniV3ExecutionCandidateKey("ethereum", [USDC, USDT], 3000)!, [second]],
      ]),
    };
    const identity = {
      protocol: "uniswap-v3",
      chainNorm: "ethereum",
      pool: {
        pool: `fp:ethereum:uniswap-v3:${USDC}:${USDT}`,
        project: "uniswap-v3",
        underlyingTokens: [USDC, USDT],
        symbol: "USDC-USDT",
        poolMeta: null,
        tvlUsd: 1_000_000,
      },
    } as ResolvedPoolIdentity;
    const enrichment = {
      rawContribTvl: 1_000_000, resolvedPoolType: "uniswap-v3-1bp", feeTierForExtra: 100,
    } as PoolProtocolEnrichment;
    const result = buildPoolExecutionCapability(context, identity, enrichment, "usdc-circle");
    expect(result.measuredExecutionTarget).toBeUndefined();
    expect(result.executionCapabilityGate?.reason).toBe("target-unresolved");
  });
});

describe("tracked-currency QuoterV2 source pages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scopes both native currency sides without changing page offsets or the TVL floor", () => {
    const query = buildUniV3PoolQuery(1000, [USDC, USDT]);
    expect(query).toContain("skip: 1000");
    expect(query).toContain('totalValueLockedUSD_gt: "10000"');
    expect(query).toContain(`token0_in: ${JSON.stringify([USDC, USDT])}`);
    expect(query).toContain(`token1_in: ${JSON.stringify([USDC, USDT])}`);
  });

  it("scopes Messari input currencies while preserving its liquidity-only filter", () => {
    const query = buildUniV3MessariPoolQuery(2000, [USDC, USDT]);
    expect(query).toContain("skip: 2000");
    expect(query).toContain('totalLiquidity_gt: "0"');
    expect(query).toContain(`inputTokens_contains: ["${USDC}"]`);
    expect(query).toContain(`inputTokens_contains: ["${USDT}"]`);
    expect(query).not.toContain("totalValueLockedUSD_gt");
  });

  it("passes only canonical chain-local tracked currencies into source queries", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(init?.body as string).query as string;
      queries.push(query);
      return new Response(JSON.stringify({ data: query.includes("liquidityPools(") ? { liquidityPools: [] } : { pools: [] } }));
    }));
    await fetchUniV3Data("test-key", new Map(), new Map([
      [`ethereum:${USDC.toUpperCase()}`, "usdc-circle"],
      [`celo:${USDT}`, "usdt-tether"],
      ["ethereum:not-an-address", "invalid"],
    ]));
    expect(queries.some((query) => query.includes(`token0_in: ["${USDC}"]`))).toBe(true);
    expect(queries.some((query) => query.includes(`inputTokens_contains: ["${USDT}"]`))).toBe(true);
    expect(queries.every((query) => !query.includes("not-an-address"))).toBe(true);
    expect(queries.every((query) => !query.includes(`token0_in: ["${USDT}"]`))).toBe(true);
  });
});
