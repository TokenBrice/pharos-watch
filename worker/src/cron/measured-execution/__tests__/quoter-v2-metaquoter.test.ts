import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } from "viem/utils";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmCodeAtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCodeAtBlock: rpcMocks.fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock: rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
}));

import {
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { getDexExecutionCapabilityRegistration } from "@shared/lib/p4-exit-route-capability-policy";
import {
  encodeQuoterV2ExactInputSingle,
  encodeV3FactoryGetPool,
  quoteQuoterV2Requests,
  resolveQuoterV2PoolBindings,
  validateQuoterV2ProfileProof,
} from "../quoter-v2";
import {
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
  isMetaquoterProfile,
  isTickSpacingQuoterV2Profile,
} from "../registry";
import { buildDexMeasuredExecutionProfile } from "../profiles";

const PROFILE_ID = "aero-slipstream-metaquoter";
const AERO_CHAINS = ["base", "ethereum", "optimism", "arbitrum", "robinhood", "arc"] as const;
const METAQUOTER = "0x1ddfec5058180c207f55bb77d95acdd0d8227868";
// Live Base vector, block 52,996,329 (2026-10-23): 1,000 USDC -> USDT through
// the tick-spacing-1 Aero pool, read via Multicall3 with this encoder.
const POOL = "0xd448990883e3bf9cdd8ebca368a3ecf9d629aaf7";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
const BLOCK = 52_996_329;
const QUOTE_RETURN = encodeAbiParameters(
  parseAbiParameters("uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed"),
  [1_001_631_879n, 79_293_075_119_371_399_442_079_918_019n, 1],
);
const FACTORY_RETURN = `0x000000000000000000000000${POOL.slice(2)}` as const;
const METAQUOTER_ABI = parseAbi([
  "function quoteExactInputSingleV3(address pool,address tokenIn,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed)",
]);

function makeTarget(): DexMeasuredExecutionTarget {
  const poolId = `base:${POOL}`;
  const identity = {
    adapterProfileId: PROFILE_ID,
    stablecoinId: "usdc-circle",
    chain: "base",
    protocol: "aero-slipstream",
    poolId,
    tokenInAddress: USDC,
    tokenOutAddress: USDT,
    poolTokenAddresses: [USDC, USDT],
    tickSpacing: 1,
  } as const;
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: buildDexMeasuredExecutionTargetId(identity),
    stablecoinId: identity.stablecoinId,
    adapterProfileId: PROFILE_ID,
    protocol: identity.protocol,
    chain: identity.chain,
    poolId,
    poolTokenAddresses: [USDC, USDT],
    tokenIn: { address: USDC, symbol: "USDC", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdc-circle" },
    tokenOut: { address: USDT, symbol: "USDT", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdt-tether" },
    tickSpacing: 1,
    retainedTvlUsd: 5_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_792_800_000,
  };
}

describe("Aero Slipstream Metaquoter shadow profile", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmCodeAtBlock.mockReset();
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });

  it("pins one reviewed deployment per Aero chain without granting score eligibility", () => {
    for (const chain of AERO_CHAINS) {
      const deployment = getDexMeasuredExecutionDeployment(PROFILE_ID, chain);
      expect(deployment).toMatchObject({ protocol: "aero-slipstream", chain, endpointAddress: METAQUOTER });
      expect(deployment!.expectedCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(deployment!.expectedFactoryCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(isDexMeasuredExecutionDeploymentScoreEligible(PROFILE_ID, chain)).toBe(false);
    }
    expect(getDexMeasuredExecutionDeployment(PROFILE_ID, "ink")).toBeNull();
    expect(getDexExecutionCapabilityRegistration(PROFILE_ID)).toMatchObject({
      lifecycle: "shadow",
      eligibleChains: [...AERO_CHAINS],
    });
    expect(getDexExecutionCapabilityRegistration(PROFILE_ID)?.eligibleDeploymentKeys).toBeUndefined();
    expect(isMetaquoterProfile(PROFILE_ID)).toBe(true);
    expect(isTickSpacingQuoterV2Profile(PROFILE_ID)).toBe(true);
    expect(isMetaquoterProfile("aerodrome-slipstream-quoter-v2")).toBe(false);
  });

  it("encodes a pool-addressed quote and a tick-spacing factory membership call", () => {
    const target = makeTarget();
    const call = decodeFunctionData({ abi: METAQUOTER_ABI, data: encodeQuoterV2ExactInputSingle(target, 1_000_000_000n) });
    expect(call.functionName).toBe("quoteExactInputSingleV3");
    expect(call.args.map((arg) => (typeof arg === "string" ? arg.toLowerCase() : arg)))
      .toEqual([POOL, USDC, 1_000_000_000n, 0n]);
    const getPool = decodeFunctionData({
      abi: parseAbi(["function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns (address pool)"]),
      data: encodeV3FactoryGetPool(target),
    });
    expect(getPool.args).toEqual([expect.stringMatching(/^0x/i), expect.stringMatching(/^0x/i), 1]);
  });

  it("decodes the three-word live vector, binds the pool and validates the proof", async () => {
    const target = makeTarget();
    const deployment = getDexMeasuredExecutionDeployment(PROFILE_ID, "base")!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string; target: string }>) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: call.target.toLowerCase() === deployment.factoryAddress ? FACTORY_RETURN : QUOTE_RETURN,
        })),
    );
    const [quote] = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 1_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: BLOCK, blockHash: `0x${"ab".repeat(32)}`, chainRpcs: new Map(),
    });
    expect(quote!.point).toMatchObject({
      amountInRaw: "1000000000",
      amountOutRaw: "1001631879",
      adapterMetadata: { sqrtPriceX96After: "79293075119371399442079918019", initializedTicksCrossed: 1 },
    });
    expect(quote!.point!.adapterMetadata).not.toHaveProperty("gasEstimate");

    const [binding] = await resolveQuoterV2PoolBindings({
      requests: [{ target, factoryAddress: deployment.factoryAddress, factoryCodeHash: deployment.expectedFactoryCodeHash }],
      blockNumber: BLOCK, blockHash: `0x${"ab".repeat(32)}`, chainRpcs: new Map(),
    });
    expect(binding!.proof?.resolvedPoolAddress).toBe(POOL);

    const profile = buildDexMeasuredExecutionProfile({
      blockHash: `0x${"ab".repeat(32)}`,
      target,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: target.capturedAt + 60,
      blockNumber: BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      poolBindingProof: binding!.proof!,
      points: [quote!.point!],
    });
    expect(validateQuoterV2ProfileProof(profile)).toEqual([]);

    const tampered = structuredClone(profile);
    tampered.quoteProof[0]!.callData = encodeQuoterV2ExactInputSingle(
      { ...target, poolId: "base:0x0000000000000000000000000000000000000001" },
      1_000_000_000n,
    ).toLowerCase();
    expect(validateQuoterV2ProfileProof(tampered)).toContain("call-data-mismatch");
  });
});
