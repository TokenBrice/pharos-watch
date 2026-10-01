import { describe, expect, it } from "vitest";

import type { DexApiPool } from "../../../lib/dex-api-common";
import {
  buildUniV3ExecutionCandidateKey,
  type UniV3ExecutionCandidate,
} from "../../measured-execution/inventory";
import { buildRegisteredDirectApiExecutionTarget } from "../process-pool-execution-capability";

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
});
