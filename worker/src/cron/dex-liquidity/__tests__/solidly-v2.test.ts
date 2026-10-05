import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters } from "viem/utils";
import { quoteSolidlyV2Raw, type SolidlyV2MathVariant } from "@shared/lib/solidly-v2-math";
import { DexAmmExecutionModelSchema, type DexAmmExecutionModel } from "@shared/types/market";
import { buildAmmCapacityCurve, validateAmmExecutionModel } from "@shared/lib/p4-exit-route-amm-simulation";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-observation-assembly";
import { attachEvmV2CandidateToRetainedPool, buildEvmV2ExecutionCandidate, enrichEvmV2ExecutionModels } from "../constant-product-v2";
import { SOLIDLY_V2_ABI, SOLIDLY_V2_DEPLOYMENTS } from "../solidly-v2";
import { initMetrics } from "../pool-helpers";
import type { PoolEntry } from "../types";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../../lib/evm-rpc";
import snapshots from "./fixtures/solidly-v2-live.json";

const addressResult = (value: string) => encodeAbiParameters([{ type: "address" }], [value as `0x${string}`]);
const uintResult = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);

function fixtureModel(index = 0): DexAmmExecutionModel {
  const fixture = snapshots[index]!;
  const state = fixture.state;
  const tokenInIndex = 0;
  return {
    source: "solidly-v2", invariant: state.stable ? "solidly-stable" : "constant-product", trackedTokenIndex: tokenInIndex,
    feeRate: Number(state.fee) / (state.variant === "shadow" ? 1_000_000 : 10_000),
    tokens: [fixture.token0, fixture.token1].map((address, i) => ({ address, symbol: i === 0 ? "INPUT" : "OUTPUT",
      decimals: i === 0 ? state.decimals0 : state.decimals1,
      balance: Number(i === 0 ? state.reserve0 : state.reserve1) / 10 ** (i === 0 ? state.decimals0 : state.decimals1),
      referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: i === 0 ? "input-id" : "output-id",
    })),
    solidlyState: { variant: state.variant as SolidlyV2MathVariant, stable: state.stable, reserve0: state.reserve0, reserve1: state.reserve1, fee: Number(state.fee),
      blockNumber: fixture.blockNumber, blockHash: fixture.blockHash, poolAddress: fixture.poolId.split(":")[1]!, factoryAddress: fixture.factory,
      verifiedQuoteCount: 4, quoteChecks: fixture.points.filter((point) => point.tokenInIndex === tokenInIndex).map((point) => ({ tokenInIndex, amountIn: point.amountIn, amountOut: point.amountOut! })),
    },
  };
}

function captureHarness(overrides: { factoryMismatch?: boolean; quoteMismatch?: boolean; codeMismatch?: boolean; decimalsMismatch?: boolean; reorg?: boolean; paused?: boolean } = {}) {
  const fixture = snapshots[0]!;
  const deployment = SOLIDLY_V2_DEPLOYMENTS[0]!;
  const candidate = buildEvmV2ExecutionCandidate({ chain: "base", protocol: "aerodrome-base", poolType: "cg-amm",
    poolAddress: fixture.poolId.split(":")[1]!, tokenAddresses: [fixture.token1, fixture.token0], tokenSymbols: ["OUTPUT", "INPUT"] })!;
  const model = fixtureModel();
  const pool: PoolEntry = { poolId: fixture.poolId, project: "aerodrome", chain: "base", poolType: "cg-amm", symbol: "INPUT / OUTPUT", source: "cg_onchain",
    tvlUsd: model.tokens.reduce((sum, token) => sum + token.balance, 0), volumeUsd1d: 10_000, extra: { evmV2ExecutionCandidate: candidate } };
  const metrics = new Map([["input-id", { ...initMetrics("input-id", "INPUT"), topPools: [pool] }]]);
  const chainAddressToId = new Map([[`base:${fixture.token0.toLowerCase()}`, "input-id"], [`base:${fixture.token1.toLowerCase()}`, "output-id"]]);
  let headerReads = 0;
  const dependencies = {
    fetchBlockNumber: vi.fn(async () => fixture.blockNumber),
    fetchBlockHeader: vi.fn(async () => ({ number: fixture.blockNumber, timestamp: 1791184659, hash: (++headerReads > 1 && overrides.reorg ? `0x${"e".repeat(64)}` : fixture.blockHash) as `0x${string}` })),
    fetchCodeAtBlock: vi.fn(async (_chain: string | undefined, address: string) => (address === deployment.factoryAddress ? "0x01" : address === deployment.implementationAddress ? "0x02" : "0x03") as `0x${string}`),
    hashCode: (code: `0x${string}`) => code === "0x01" ? (overrides.codeMismatch ? `0x${"0".repeat(64)}` : deployment.factoryCodeHash) as `0x${string}` : code === "0x02" ? deployment.implementationCodeHash! : deployment.poolCodeHash,
    fetchMulticall: vi.fn(async (_chain: string | undefined, calls: readonly EvmMulticall3Call[], _block?: number | "latest"): Promise<EvmMulticall3Result[]> => calls.map((call) => {
      let returnData: `0x${string}` = "0x";
      if (call.label === "implementation") returnData = addressResult(deployment.implementationAddress!);
      else if (call.label === "paused") returnData = encodeAbiParameters([{ type: "bool" }], [overrides.paused ?? false]);
      else if (call.label.endsWith("-factory")) returnData = addressResult(overrides.factoryMismatch ? fixture.token0 : deployment.factoryAddress);
      else if (call.label.endsWith("-stable")) returnData = encodeAbiParameters([{ type: "bool" }], [true]);
      else if (call.label.endsWith("-pair-true")) returnData = addressResult(candidate.poolAddress);
      else if (call.label.endsWith("-pair-false")) returnData = addressResult("0x0000000000000000000000000000000000000000");
      else if (call.label.endsWith("-token0")) returnData = addressResult(fixture.token0);
      else if (call.label.endsWith("-token1")) returnData = addressResult(fixture.token1);
      else if (call.label.endsWith("-decimals0")) returnData = uintResult(BigInt(fixture.state.decimals1));
      else if (call.label.endsWith("-decimals1")) returnData = uintResult(BigInt(fixture.state.decimals0 + (overrides.decimalsMismatch ? 1 : 0)));
      else if (call.label.includes("-fee-")) returnData = uintResult(BigInt(fixture.state.fee));
      else if (call.label.endsWith("-reserves")) returnData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(fixture.state.reserve0), BigInt(fixture.state.reserve1), 1791184659n]);
      else if (call.label.endsWith("-metadata")) returnData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "address" }, { type: "address" }], [10n ** BigInt(fixture.state.decimals0), 10n ** BigInt(fixture.state.decimals1), BigInt(fixture.state.reserve0), BigInt(fixture.state.reserve1), true, fixture.token0 as `0x${string}`, fixture.token1 as `0x${string}`]);
      else if (call.label.startsWith("quote-")) {
        const decoded = decodeFunctionData({ abi: SOLIDLY_V2_ABI, data: call.callData as `0x${string}` });
        const amountIn = decoded.args![0] as bigint;
        const point = fixture.points.find((point) => point.tokenInIndex === 0 && point.amountIn === amountIn.toString())!;
        returnData = uintResult(BigInt(point.amountOut!) + (overrides.quoteMismatch ? 1n : 0n));
      }
      return { label: call.label, success: true, returnData };
    })),
  };
  return { fixture, pool, metrics, dependencies, run: () => enrichEvmV2ExecutionModels({ metrics, chainAddressToId, contractMetaByChainAddress: new Map(), stablecoinPriceById: new Map([["input-id", 1], ["output-id", 1]]), chainRpcs: new Map(), dependencies }) };
}

describe("Solidly V2 contract equivalence", () => {
  it.each(snapshots)("reproduces the independent pinned grid for $poolId", (fixture) => {
    const state = { ...fixture.state, variant: fixture.state.variant as SolidlyV2MathVariant, reserve0: BigInt(fixture.state.reserve0), reserve1: BigInt(fixture.state.reserve1), fee: BigInt(fixture.state.fee) };
    for (const point of fixture.points) expect(quoteSolidlyV2Raw(state, BigInt(point.amountIn), point.tokenInIndex as 0 | 1)?.toString()).toBe(point.amountOut);
  });

  it("uses the volatile pool's floored fee, not a floating fee multiplier", () => {
    const state = { reserve0: 100n, reserve1: 1000n, decimals0: 0, decimals1: 0, stable: false, fee: 99n, variant: "aerodrome" as const };
    expect(quoteSolidlyV2Raw(state, 1n, 0)).toBe(9n);
    expect(quoteSolidlyV2Raw(state, 101n, 0)).toBe(502n);
  });

  it("fails closed on Solidity overflow, zero reserves and Shadow's output underflow", () => {
    const state = { reserve0: 1n, reserve1: 1n, decimals0: 18, decimals1: 18, stable: false, fee: 0n, variant: "shadow" as const };
    expect(quoteSolidlyV2Raw(state, 0n, 0)).toBeNull();
    expect(quoteSolidlyV2Raw({ ...state, reserve0: 0n }, 1n, 0)).toBeNull();
    expect(quoteSolidlyV2Raw({ ...state, variant: "aerodrome" }, 1n << 256n, 0)).toBeNull();
  });

  it("retains complete stable state only after pinned oracle equivalence, and remains diagnostic", async () => {
    const harness = captureHarness();
    await harness.run();
    expect(harness.pool.extra?.executionCapabilityGate).toBeUndefined();
    const model = DexAmmExecutionModelSchema.parse(harness.pool.extra?.ammExecutionModel);
    expect(model.solidlyState?.verifiedQuoteCount).toBe(4);
    expect(validateAmmExecutionModel(model, { chain: "base", stablecoinId: "input-id", retainedTvlUsd: harness.pool.tvlUsd })).toEqual([]);
    const result = buildP4DexExitRouteObservations({ stablecoinId: "input-id", observedAt: 1791184659, retainedPools: [harness.pool] });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.scoreEligible).toBe(false);
    expect(result.coverage.scoreEligiblePoolCount).toBe(0);
    expect(buildAmmCapacityCurve(model, 1).every((point) => point.executableUsd >= 0 && point.executableUsd <= point.requestedNotionalUsd)).toBe(true);
  });

  it.each([
    [{ factoryMismatch: true }, "exact-pool-join-unresolved"],
    [{ codeMismatch: true }, "deployment-code-mismatch"],
    [{ quoteMismatch: true }, "quote-failed"],
    [{ decimalsMismatch: true }, "incomplete-exact-capture"],
    [{ reorg: true }, "transport-unavailable"],
    [{ paused: true }, "paused-or-swap-disabled"],
  ] as const)("rejects mismatched pinned evidence %j", async (overrides, reason) => {
    const harness = captureHarness(overrides);
    await harness.run();
    expect(harness.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(harness.pool.extra?.executionCapabilityGate).toEqual({ family: "solidly-v2", reason });
  });

  it("rejects corrupt raw state, mismatched balances and duplicated quote evidence without throwing", () => {
    for (const mutate of [
      (model: DexAmmExecutionModel) => { model.solidlyState!.reserve0 = "not-an-integer"; },
      (model: DexAmmExecutionModel) => { model.tokens[0]!.balance *= 1.01; },
      (model: DexAmmExecutionModel) => { model.solidlyState!.quoteChecks = Array(4).fill(model.solidlyState!.quoteChecks[0]); },
    ]) {
      const model = fixtureModel();
      mutate(model);
      const retainedTvlUsd = model.tokens.reduce((sum, token) => sum + token.balance, 0);
      expect(validateAmmExecutionModel(model, { chain: "base", stablecoinId: "input-id", retainedTvlUsd })).toContain("invalid-solidly-proof");
    }
  });

  it("does not resolve conflicting physical Solidly pools by fingerprint arrival order", () => {
    const harness = captureHarness();
    harness.pool.poolId = `fp:base:aerodrome:${[harness.fixture.token0.toLowerCase(), harness.fixture.token1.toLowerCase()].sort().join(":")}`;
    const candidate = harness.pool.extra!.evmV2ExecutionCandidate!;
    expect(attachEvmV2CandidateToRetainedPool({ metrics: harness.metrics, stablecoinId: "input-id", chain: "base", candidate })).toBe(true);
    expect(attachEvmV2CandidateToRetainedPool({ metrics: harness.metrics, stablecoinId: "input-id", chain: "base", candidate: { ...candidate, poolAddress: harness.fixture.token0.toLowerCase() as `0x${string}` } })).toBe(false);
    expect(harness.pool.extra?.executionCapabilityGate?.reason).toBe("exact-pool-join-unresolved");
    expect(attachEvmV2CandidateToRetainedPool({ metrics: harness.metrics, stablecoinId: "input-id", chain: "base", candidate })).toBe(false);
  });

  it("recognizes discovery CP candidates only on reviewed factories and rejects concentrated shapes", () => {
    for (const protocol of ["pancakeswap-v2-bsc", "uniswap-v2-bsc"]) expect(buildEvmV2ExecutionCandidate({ chain: "bsc", protocol, poolType: "cg-amm", poolAddress: snapshots[0]!.token0, tokenAddresses: [snapshots[0]!.token0, snapshots[0]!.token1] })).not.toBeNull();
    expect(buildEvmV2ExecutionCandidate({ chain: "base", protocol: "aerodrome", poolType: "aerodrome-slipstream-5bp", poolAddress: snapshots[0]!.token0, tokenAddresses: [snapshots[0]!.token0, snapshots[0]!.token1] })).toBeNull();
  });
});
