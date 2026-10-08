import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters } from "viem/utils";
import { quoteSolidlyV2Raw, type SolidlyV2MathVariant } from "@shared/lib/solidly-v2-math";
import { SOLIDLY_V2_DEPLOYMENTS } from "@shared/lib/solidly-v2-deployments";
import { DexAmmExecutionModelSchema, DexLiquidityMapSchema, DexStoredAmmExecutionModelSchema, type DexAmmExecutionModel } from "@shared/types/market";
import { ExitRouteObservationSchema } from "@shared/types/exit-route";
import { buildAmmCapacityCurve, buildSolidlyV2CapacityChecks, validateAmmExecutionModel } from "@shared/lib/p4-exit-route-amm-simulation";
import { capabilityForPool } from "@shared/lib/p4-exit-route-capability-policy";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-observation-assembly";
import { attachEvmV2CandidateToRetainedPool, buildEvmV2ExecutionCandidate, enrichEvmV2ExecutionModels } from "../constant-product-v2";
import { SOLIDLY_V2_ABI } from "../solidly-v2";
import { initMetrics, normalizeProtocol } from "../pool-helpers";
import type { PoolEntry } from "../types";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../../lib/evm-rpc";
import { normalizeTopPools } from "../../../lib/dex-liquidity-response";
import archive from "./fixtures/solidly-v2-2026-10-05-archive.json";

const NOW = 1791184659;
const GENERATION = `dex-liquidity-scoring-stage:${NOW}`;
const snapshots = archive.filter((row) => row.state.stable && row.state.variant !== "shadow");
const addressResult = (value: string) => encodeAbiParameters([{ type: "address" }], [value as `0x${string}`]);
const uintResult = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);

interface CaptureOverrides {
  factoryMismatch?: boolean; quoteMismatch?: boolean; endpointMismatch?: boolean;
  codeMismatch?: boolean; decimalsMismatch?: boolean; reorg?: boolean; paused?: boolean;
  missingFactory?: boolean; missingImplementation?: boolean; volatile?: boolean;
  headerTimestamp?: number; priceTimestamp?: number; missingPriceClock?: boolean;
  productive?: boolean; mixedDecimals?: boolean;
}

function captureHarness(deploymentIndex = 0, tokenInIndex: 0 | 1 = 0, overrides: CaptureOverrides = {}) {
  const fixture = snapshots[deploymentIndex]!;
  const deployment = SOLIDLY_V2_DEPLOYMENTS[deploymentIndex]!;
  const state = { ...fixture.state, stable: true as const, variant: fixture.state.variant as SolidlyV2MathVariant,
    reserve0: BigInt(fixture.state.reserve0), reserve1: BigInt(fixture.state.reserve1), fee: BigInt(fixture.state.fee) };
  if (overrides.mixedDecimals) state.decimals0 = 18;
  if (overrides.productive) {
    state.reserve0 = 1_000_000n * 10n ** BigInt(state.decimals0);
    state.reserve1 = 1_000_000n * 10n ** BigInt(state.decimals1);
  }
  const candidate = buildEvmV2ExecutionCandidate({ chain: deployment.chain, protocol: deployment.protocol, poolType: "cg-amm",
    poolAddress: fixture.poolId.split(":")[1]!, tokenAddresses: [fixture.token1, fixture.token0], tokenSymbols: ["OUTPUT", "INPUT"] })!;
  const pool: PoolEntry = { poolId: fixture.poolId, project: deployment.protocol, chain: deployment.chain, poolType: "cg-amm", symbol: "INPUT / OUTPUT", source: "cg_onchain",
    tvlUsd: Number(state.reserve0) / 10 ** state.decimals0 + Number(state.reserve1) / 10 ** state.decimals1,
    volumeUsd1d: 10_000, extra: { evmV2ExecutionCandidate: candidate } };
  const stablecoinId = tokenInIndex === 0 ? "input-id" : "output-id";
  const metrics = new Map([[stablecoinId, { ...initMetrics(stablecoinId, "INPUT"), topPools: [pool] }]]);
  const chainAddressToId = new Map([[`${deployment.chain}:${fixture.token0.toLowerCase()}`, "input-id"], [`${deployment.chain}:${fixture.token1.toLowerCase()}`, "output-id"]]);
  let headerReads = 0;
  const dependencies = {
    fetchBlockNumber: vi.fn(async () => fixture.blockNumber),
    fetchBlockHeader: vi.fn(async () => ({ number: fixture.blockNumber, timestamp: overrides.headerTimestamp ?? NOW,
      hash: (++headerReads > 1 && overrides.reorg ? `0x${"e".repeat(64)}` : fixture.blockHash) as `0x${string}` })),
    fetchCodeAtBlock: vi.fn(async (_chain: string | undefined, address: string) => (address === deployment.factoryAddress ? "0x01" : address === deployment.implementationAddress ? "0x02" : "0x03") as `0x${string}`),
    hashCode: (code: `0x${string}`) => code === "0x01" ? (overrides.codeMismatch ? `0x${"0".repeat(64)}` : deployment.factoryCodeHash) as `0x${string}` : code === "0x02" ? deployment.implementationCodeHash : deployment.poolCodeHash,
    fetchMulticall: vi.fn(async (_chain: string | undefined, calls: readonly EvmMulticall3Call[]): Promise<EvmMulticall3Result[]> => calls.map((call) => {
      let returnData: `0x${string}` = "0x";
      if (call.label === "implementation") returnData = addressResult(deployment.implementationAddress);
      else if (call.label === "paused") returnData = encodeAbiParameters([{ type: "bool" }], [overrides.paused ?? false]);
      else if (call.label.endsWith("-factory")) returnData = addressResult(overrides.factoryMismatch ? fixture.token0 : deployment.factoryAddress);
      else if (call.label.endsWith("-stable")) returnData = encodeAbiParameters([{ type: "bool" }], [!overrides.volatile]);
      else if (call.label.endsWith("-pair-true")) returnData = addressResult(candidate.poolAddress);
      else if (call.label.endsWith("-token0")) returnData = addressResult(fixture.token0);
      else if (call.label.endsWith("-token1")) returnData = addressResult(fixture.token1);
      else if (call.label.endsWith("-decimals0")) returnData = uintResult(BigInt(state.decimals1));
      else if (call.label.endsWith("-decimals1")) returnData = uintResult(BigInt(state.decimals0 + (overrides.decimalsMismatch ? 1 : 0)));
      else if (call.label.endsWith("-fee-true")) returnData = uintResult(state.fee);
      else if (call.label.endsWith("-reserves")) returnData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [state.reserve0, state.reserve1, BigInt(NOW)]);
      else if (call.label.endsWith("-metadata")) returnData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "address" }, { type: "address" }], [10n ** BigInt(state.decimals0), 10n ** BigInt(state.decimals1), state.reserve0, state.reserve1, !overrides.volatile, fixture.token0 as `0x${string}`, fixture.token1 as `0x${string}`]);
      else if (call.label.startsWith("quote-") || call.label.startsWith("endpoint-")) {
        const decoded = decodeFunctionData({ abi: SOLIDLY_V2_ABI, data: call.callData as `0x${string}` });
        const amountIn = decoded.args![0] as bigint;
        const direction = (decoded.args![1] as string).toLowerCase() === fixture.token0.toLowerCase() ? 0 : 1;
        const independentGrid = !overrides.productive && !overrides.mixedDecimals ? fixture.points.find((point) => point.tokenInIndex === direction && point.amountIn === amountIn.toString()) : undefined;
        // RPC mocks exercise endpoint transport/failure isolation, not independent chain equivalence.
        const amountOut = independentGrid ? BigInt(independentGrid.amountOut!) : quoteSolidlyV2Raw(state, amountIn, direction)!;
        returnData = uintResult(amountOut + (overrides.quoteMismatch || call.label.startsWith("endpoint-") && overrides.endpointMismatch ? 1n : 0n));
      }
      const success = !(overrides.missingFactory && call.label.endsWith("-factory") || overrides.missingImplementation && call.label === "implementation");
      return { label: call.label, success, returnData };
    })),
  };
  const run = () => enrichEvmV2ExecutionModels({ metrics, chainAddressToId, contractMetaByChainAddress: new Map(),
    stablecoinPriceById: new Map([["input-id", 1], ["output-id", 1]]),
    stablecoinPriceProvenanceById: new Map(["input-id", "output-id"].map((id) => [id, {
      referencePriceSourceId: "coingecko", referencePriceObservedAt: overrides.missingPriceClock ? NaN : overrides.priceTimestamp ?? NOW - 60,
    }])), nowSec: NOW, sourceGenerationId: GENERATION, chainRpcs: new Map(), dependencies });
  return { fixture, state, pool, metrics, dependencies, stablecoinId, deployment, run };
}

function observations(harness: { stablecoinId: string; pool: PoolEntry }, now = NOW) {
  return buildP4DexExitRouteObservations({ stablecoinId: harness.stablecoinId, observedAt: now, retainedPools: [harness.pool] });
}

describe("Solidly V2 surviving stable diagnostics", () => {
  it.each(snapshots)("reproduces the archived independent stable grid for $poolId", (fixture) => {
    const state = { ...fixture.state, stable: true as const, variant: fixture.state.variant as SolidlyV2MathVariant,
      reserve0: BigInt(fixture.state.reserve0), reserve1: BigInt(fixture.state.reserve1), fee: BigInt(fixture.state.fee) };
    for (const point of fixture.points) expect(quoteSolidlyV2Raw(state, BigInt(point.amountIn), point.tokenInIndex as 0 | 1)?.toString()).toBe(point.amountOut);
  });

  it("fails closed on stable uint256 overflow, zero reserves and unsupported raw invariants", () => {
    const state = { reserve0: 10n ** 24n, reserve1: 10n ** 24n, decimals0: 18, decimals1: 18, stable: true as const, fee: 5n, variant: "velodrome" as const };
    expect(quoteSolidlyV2Raw(state, 1n << 256n, 0)).toBeNull();
    expect(quoteSolidlyV2Raw({ ...state, reserve0: 0n }, 1n, 0)).toBeNull();
  });

  it.each([[0, 0], [0, 1], [1, 0], [1, 1]] as const)("captures deployment %i direction %i without scoring or refreshing clocks", async (index, direction) => {
    const harness = captureHarness(index, direction);
    await harness.run();
    const model = DexAmmExecutionModelSchema.parse(harness.pool.extra?.ammExecutionModel);
    expect(validateAmmExecutionModel(model, { chain: harness.deployment.chain, stablecoinId: harness.stablecoinId, retainedTvlUsd: harness.pool.tvlUsd, nowSec: NOW })).toEqual([]);
    expect(model.solidlyState).toMatchObject({ blockTimestamp: NOW, sourceGenerationId: GENERATION });
    const result = observations(harness, NOW + 120);
    expect(result.observations).toHaveLength(1);
    const observation = ExitRouteObservationSchema.parse(result.observations[0]);
    expect(observation).toMatchObject({ scoreEligible: false, observedAt: NOW, freshnessSeconds: 180,
      outputUnitValueSourceId: "coingecko", outputUnitValueObservedAt: NOW - 60,
      ammExecutionEvidence: { sourceGenerationId: GENERATION, blockHash: harness.fixture.blockHash, blockTimestamp: NOW,
        inputReference: { observedAt: NOW - 60 }, outputReference: { observedAt: NOW - 60 } } });
    expect(result.coverage.scoreEligiblePoolCount).toBe(0);
    expect(capabilityForPool(harness.pool).id).toBe(harness.deployment.capabilityId);
  });

  it.each([[0, 0], [0, 1], [1, 0], [1, 1]] as const)("verifies mixed-decimal refined endpoints for deployment %i direction %i", async (index, direction) => {
    const harness = captureHarness(index, direction, { productive: true, mixedDecimals: true });
    await harness.run();
    const model = DexAmmExecutionModelSchema.parse(harness.pool.extra?.ammExecutionModel);
    const checks = buildSolidlyV2CapacityChecks(model)!;
    const curve = buildAmmCapacityCurve(model, 1 - direction);
    expect(curve.every((point) => point.executableUsd > 0 && point.executableUsd <= point.requestedNotionalUsd && point.executionCostBps! <= 200)).toBe(true);
    expect(checks.some((point) => point.executableUsd < point.requestedNotionalUsd)).toBe(true);
    for (const check of checks) {
      for (const [amountIn, amountOut] of [[check.selectedAmountIn, check.selectedAmountOut], [check.rejectedAmountIn, check.rejectedAmountOut]]) {
        if (amountIn && amountIn !== "0") expect(model.solidlyState!.quoteChecks).toContainEqual({ tokenInIndex: direction, amountIn, amountOut });
      }
    }
    const endpointCalls = harness.dependencies.fetchMulticall.mock.calls.flatMap(([, calls]) => calls.filter((call) => call.label.startsWith("endpoint-")));
    expect(endpointCalls.length).toBeLessThanOrEqual(8);
    expect(new Set(endpointCalls.map((call) => call.callData)).size).toBe(endpointCalls.length);
    const parsed = JSON.parse(JSON.stringify(model)) as DexAmmExecutionModel;
    expect(DexAmmExecutionModelSchema.parse(parsed).solidlyState?.capacityChecks).toEqual(checks);
    parsed.solidlyState!.capacityChecks![1]!.selectedAmountOut = "0";
    harness.pool.extra!.ammExecutionModel = parsed;
    expect(observations(harness).observations).toEqual([]);
  });

  it.each([
    [{ factoryMismatch: true }, "exact-pool-join-unresolved"],
    [{ missingFactory: true }, "incomplete-exact-capture"],
    [{ missingImplementation: true }, "incomplete-exact-capture"],
    [{ codeMismatch: true }, "deployment-code-mismatch"],
    [{ quoteMismatch: true }, "quote-failed"],
    [{ endpointMismatch: true, productive: true }, "quote-failed"],
    [{ decimalsMismatch: true }, "incomplete-exact-capture"],
    [{ reorg: true }, "transport-unavailable"],
    [{ paused: true }, "paused-or-swap-disabled"],
    [{ headerTimestamp: NOW - 10801 }, "transport-unavailable"],
    [{ headerTimestamp: NOW + 61 }, "transport-unavailable"],
    [{ priceTimestamp: NOW - 1801 }, "incomplete-exact-capture"],
    [{ priceTimestamp: NOW + 1 }, "incomplete-exact-capture"],
    [{ missingPriceClock: true }, "incomplete-exact-capture"],
  ] as const)("rejects unavailable or mismatched evidence %j", async (overrides, reason) => {
    const harness = captureHarness(0, 0, overrides);
    await harness.run();
    expect(harness.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(harness.pool.extra?.executionCapabilityGate).toEqual({ family: "solidly-v2", reason });
    expect(harness.pool.tvlUsd).toBeGreaterThan(0);
  });

  it.each([0, 1])("retires volatile diagnostics on deployment %i without dropping ordinary sources", async (index) => {
    const harness = captureHarness(index, 0, { volatile: true });
    const original = { poolId: harness.pool.poolId, tvlUsd: harness.pool.tvlUsd, volumeUsd1d: harness.pool.volumeUsd1d };
    await harness.run();
    expect(harness.pool).toMatchObject(original);
    expect(harness.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(harness.pool.extra?.evmV2ExecutionCandidate).toBeUndefined();
    expect(harness.pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(harness.dependencies.fetchCodeAtBlock).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.fetchMulticall.mock.calls.flatMap(([, calls]) => calls).some((call) => /^(quote|endpoint)-/.test(call.label))).toBe(false);
  });

  it.each(["shadow-exchange", "shadow-exchange-legacy"])("does not enroll Sonic brand %s into exact legacy capture", (protocol) => {
    const fixture = archive.find((row) => row.chain === "sonic")!;
    expect(buildEvmV2ExecutionCandidate({ chain: "sonic", protocol, poolType: "cg-amm", poolAddress: fixture.poolId.split(":")[1]!, tokenAddresses: [fixture.token0, fixture.token1] })).toBeNull();
    expect(normalizeProtocol(protocol)).toBe(protocol);
  });

  it("rejects wrong factory, invariant, chain, pool and Slipstream capability inheritance", async () => {
    const harness = captureHarness();
    await harness.run();
    const model = harness.pool.extra!.ammExecutionModel!;
    for (const pool of [
      { ...harness.pool, chain: "optimism" }, { ...harness.pool, project: "velodrome" },
      { ...harness.pool, poolId: `base:${harness.fixture.token0.toLowerCase()}` },
      { ...harness.pool, poolType: "aerodrome-slipstream-5bp" },
    ]) expect(buildP4DexExitRouteObservations({ stablecoinId: "input-id", observedAt: NOW, retainedPools: [pool] }).observations).toEqual([]);
    const retired = JSON.parse(JSON.stringify(model));
    retired.solidlyState.stable = false;
    retired.invariant = "constant-product";
    expect(DexAmmExecutionModelSchema.safeParse(retired).success).toBe(false);
    expect(observations(harness, NOW + 1801).observations).toEqual([]);
  });

  it("isolates malformed proof rows and retains supported ordinary CP candidates", async () => {
    const harness = captureHarness();
    await harness.run();
    const corrupt = structuredClone(harness.pool);
    corrupt.extra!.ammExecutionModel!.solidlyState!.reserve0 = "invalid";
    const result = buildP4DexExitRouteObservations({ stablecoinId: "input-id", observedAt: NOW, retainedPools: [corrupt, harness.pool] });
    expect(result.observations).toHaveLength(1);
    for (const protocol of ["pancakeswap-v2-bsc", "uniswap-v2-bsc"]) expect(buildEvmV2ExecutionCandidate({ chain: "bsc", protocol, poolType: "cg-amm", poolAddress: harness.fixture.token0, tokenAddresses: [harness.fixture.token0, harness.fixture.token1] })).not.toBeNull();
  });

  it.each(archive.filter((row) => row.state.variant === "shadow" || !row.state.stable))(
    "reads stored retired $poolId as unavailable without rejecting the API row or refreshing history",
    (fixture) => {
      const raw = {
        source: "solidly-v2", invariant: fixture.state.stable ? "solidly-stable" : "constant-product",
        trackedTokenIndex: 0, feeRate: Number(fixture.state.fee) / (fixture.state.variant === "shadow" ? 1_000_000 : 10_000),
        tokens: [fixture.token0, fixture.token1].map((address, i) => ({
          address, symbol: i === 0 ? "INPUT" : "OUTPUT", decimals: i === 0 ? fixture.state.decimals0 : fixture.state.decimals1,
          balance: Number(i === 0 ? fixture.state.reserve0 : fixture.state.reserve1) / 10 ** (i === 0 ? fixture.state.decimals0 : fixture.state.decimals1),
          referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: i === 0 ? "input-id" : "output-id",
        })),
        solidlyState: { ...fixture.state, fee: Number(fixture.state.fee), blockNumber: fixture.blockNumber,
          blockHash: fixture.blockHash, factoryAddress: fixture.factory, poolAddress: fixture.poolId.split(":")[1]!,
          blockTimestamp: NOW - 3600, sourceGenerationId: "historical-source-generation", verifiedQuoteCount: 4,
          quoteChecks: fixture.points.filter((point) => point.tokenInIndex === 0).map((point) => ({ tokenInIndex: 0, amountIn: point.amountIn, amountOut: point.amountOut! })) },
      };
      const pool = { ...captureHarness().pool, poolId: fixture.poolId, chain: fixture.chain, extra: { ammExecutionModel: raw } };
      const record = {
        totalTvlUsd: pool.tvlUsd, totalVolume24hUsd: null, totalVolume7dUsd: null, poolCount: 1, pairCount: 1, chainCount: 1,
        protocolTvl: {}, chainTvl: {}, topPools: [pool], liquidityScore: null, concentrationHhi: null, depthStability: null,
        tvlChange24h: null, tvlChange7d: null, updatedAt: NOW - 3600, dexPriceUsd: null, dexDeviationBps: null,
        priceSourceCount: null, priceSourceTvl: null, priceSources: null, effectiveTvlUsd: pool.tvlUsd, avgPoolStress: null,
        weightedBalanceRatio: null, organicFraction: null, durabilityScore: null, coverageClass: "legacy",
        coverageConfidence: 0, liquidityEvidenceClass: "unobserved", hasMeasuredLiquidityEvidence: false,
        trendworthy: false, sourceMix: {}, balanceMeasuredTvlUsd: 0, organicMeasuredTvlUsd: 0, scoreComponents: null,
        lockedLiquidityPct: null, methodologyVersion: "historical",
      };
      const served = normalizeTopPools(JSON.stringify([pool]));
      expect(served[0]).toMatchObject({ extra: { ammExecutionModel: { source: "retired-solidly-v2", unavailableReason: "retired-solidly-variant" } } });
      expect(DexAmmExecutionModelSchema.safeParse(raw).success).toBe(false);
      const parsed = DexLiquidityMapSchema.parse({ "input-id": record })["input-id"]!;
      const retired = parsed.topPools[0]!.extra!.ammExecutionModel!;
      expect(retired.source).toBe("retired-solidly-v2");
      if (retired.source !== "retired-solidly-v2") throw new Error("Retired model must be explicitly unavailable");
      expect(retired.unavailableReason).toBe("retired-solidly-variant");
      expect(retired.retiredSolidlyState).toMatchObject({ blockTimestamp: NOW - 3600, blockHash: fixture.blockHash, sourceGenerationId: "historical-source-generation" });
      expect(parsed.updatedAt).toBe(NOW - 3600);
      expect(parsed.topPools[0]!.tvlUsd).toBe(pool.tvlUsd);
      expect(DexStoredAmmExecutionModelSchema.parse(JSON.parse(JSON.stringify(retired)))).toEqual(retired);
      const result = buildP4DexExitRouteObservations({ stablecoinId: "input-id", observedAt: NOW,
        retainedPools: [{ ...pool, extra: { ammExecutionModel: retired } }] });
      expect(result.observations).toEqual([]);
      expect(result.coverage.unsupportedReasons.retiredSolidlyVariant).toBe(1);
    },
  );

  it("does not resolve conflicting physical Solidly pools by fingerprint arrival order", () => {
    const harness = captureHarness();
    harness.pool.poolId = `fp:base:aerodrome:${[harness.fixture.token0.toLowerCase(), harness.fixture.token1.toLowerCase()].sort().join(":")}`;
    const candidate = harness.pool.extra!.evmV2ExecutionCandidate!;
    expect(attachEvmV2CandidateToRetainedPool({ metrics: harness.metrics, stablecoinId: "input-id", chain: "base", candidate })).toBe(true);
    expect(attachEvmV2CandidateToRetainedPool({ metrics: harness.metrics, stablecoinId: "input-id", chain: "base", candidate: { ...candidate, poolAddress: harness.fixture.token0.toLowerCase() as `0x${string}` } })).toBe(false);
    expect(harness.pool.extra?.executionCapabilityGate?.reason).toBe("exact-pool-join-unresolved");
  });
});
