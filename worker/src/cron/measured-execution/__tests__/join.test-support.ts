import type { DexMeasuredExecutionProfile, DexMeasuredExecutionPublicProfile, DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PoolEntry } from "../../dex-liquidity/types";
import type { LoadedDexMeasuredQuoteEvidence } from "../evidence-reader";
import { buildDexMeasuredExecutionProfile, type DexMeasuredRawQuotePoint } from "../profiles";
import { getDexMeasuredExecutionDeployment } from "../registry";
import { makeV3Target } from "./measured-execution.test-support";

type EvidenceEntry = LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never;
type ObservationHistory = NonNullable<EvidenceEntry["observationHistory"]>;

/** A complete, failure-free observation window over `profile`'s capacity curve. */
export function makeObservationHistory(
  profile: DexMeasuredExecutionProfile,
  overrides: Partial<ObservationHistory> = {},
): ObservationHistory {
  return {
    completeProducerCycleCount: 2,
    successfulObservationCount: 2,
    consecutiveSuccessCount: 2,
    observationWindowStartedAt: 1_000,
    observationWindowEndedAt: 1_060,
    latestOperationalFailureAt: null,
    conservativeStatistic: "pointwise-minimum",
    conservativeCapacityCurve: profile.capacityCurve,
    ...overrides,
  };
}

export function makeJoinPool(target: DexMeasuredExecutionTarget, overrides: Partial<PoolEntry> = {}): PoolEntry {
  return { poolId: target.poolId, project: target.protocol, chain: target.chain,
    tvlUsd: target.retainedTvlUsd, symbol: "USDC-USDT", volumeUsd1d: 0,
    poolType: "uniswap-v3-1bp", source: "dl", extra: { measuredExecutionTarget: target }, ...overrides };
}

export function makeJoinQuote(target: DexMeasuredExecutionTarget, profile: DexMeasuredExecutionProfile,
  overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return { quotedTarget: target, profile, status: "measured", failureReason: null,
    quoteGenerationId: profile.quoteGenerationId, targetGenerationId: profile.targetGenerationId,
    resolution: "latest", latestFailureReason: null, ...overrides };
}

export function makeJoinPoints(amounts: readonly (readonly [number, number])[]): DexMeasuredRawQuotePoint[] {
  return amounts.map(([inputUsd, outputUsd], index) => ({
    amountInRaw: String(Math.round(inputUsd * 1_000_000)), amountOutRaw: String(Math.round(outputUsd * 1_000_000)),
    callData: `0x${String(index + 1).padStart(2, "0")}`, returnData: `0x${String(index + 1).padStart(2, "0")}`,
    inputUsd, outputUsd, costBps: Math.round((1 - outputUsd / inputUsd) * 10_000),
    passesCostBound: outputUsd / inputUsd >= 0.98,
  }));
}

/** The reviewed Ethereum QuoterV2 route every last-known-good scenario quotes against. */
export function makeV3LkgRoute(points: readonly (readonly [number, number])[]) {
  const measuredTarget = makeV3Target();
  const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
  if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
  const profile = buildDexMeasuredExecutionProfile({
    blockHash: `0x${"ab".repeat(32)}`,
    target: measuredTarget,
    targetGenerationId: "target-generation-lkg",
    quoteGenerationId: "quote-generation-lkg",
    quotedAt: 1_060,
    blockNumber: 25_536_894,
    endpointAddress: deployment.endpointAddress,
    endpointCodeHash: deployment.expectedCodeHash,
    points: makeJoinPoints(points),
  });
  return { measuredTarget, profile };
}

/** Independent public allowlists paired with proof-heavy inputs, shared by projection and join tests. */
export function makeFlatProvenanceCases(profile: DexMeasuredExecutionProfile): Array<{
  name: string;
  proofs: Partial<DexMeasuredExecutionProfile>;
  provenance: Partial<Pick<DexMeasuredExecutionPublicProfile,
    "poolProvenance" | "registryProvenance" | "stableSwapNgFactoryProvenance" | "uniswapV4PoolProvenance">>;
}> {
  const address = "0x5555555555555555555555555555555555555555";
  const hash = `0x${"cd".repeat(32)}`;
  const poolTokenAddresses = [profile.tokenIn.address, profile.tokenOut.address];
  const privateFields = { callData: "0x12", returnData: "0x34", futurePrivateField: "private-future-proof" };
  const poolCoinsProof = poolTokenAddresses.map((_, index) => ({ index, ...privateFields }));
  const tokenDecimalsProof = [profile.tokenIn, profile.tokenOut]
    .map((token) => ({ tokenAddress: token.address, decimals: token.decimals, ...privateFields }));
  const poolProvenance = { factoryAddress: address, factoryCodeHash: hash, resolvedPoolAddress: address };
  const registryProvenance = { registryAddress: address, registryCodeHash: hash,
    registeredPoolAddress: address, lpTokenAddress: address, poolTokenAddresses };
  const stableSwapNgFactoryProvenance = { blockNumber: profile.blockNumber, blockHash: profile.blockHash,
    blockCommitment: "finalized" as const, factoryAddress: address, factoryCodeHash: hash,
    poolIndex: 7, registeredPoolAddress: address, poolTokenAddresses };
  const uniswapV4PoolProvenance = { blockNumber: profile.blockNumber, blockHash: profile.blockHash,
    poolId: hash, poolManagerAddress: address, poolManagerCodeHash: hash,
    stateViewAddress: address, stateViewCodeHash: hash, sqrtPriceX96: "1",
    tick: 0, protocolFee: 0, lpFee: 100, liquidity: "1" };
  return [
    { name: "pool", proofs: { poolBindingProof: { ...poolProvenance, ...privateFields } },
      provenance: { poolProvenance } },
    { name: "registry", proofs: { registryBindingProof: { ...registryProvenance, ...privateFields,
      lpTokenCallData: "0x12", lpTokenReturnData: "0x34",
      registryCoinsCallData: "0x12", registryCoinsReturnData: "0x34", poolCoinsProof, tokenDecimalsProof } },
      provenance: { registryProvenance } },
    { name: "finalized NG factory", proofs: { stableSwapNgFactoryBindingProof: {
      ...stableSwapNgFactoryProvenance, ...privateFields, poolListCallData: "0x12", poolListReturnData: "0x34",
      factoryCoinsCallData: "0x12", factoryCoinsReturnData: "0x34", poolCoinsProof, tokenDecimalsProof } },
      provenance: { stableSwapNgFactoryProvenance } },
    { name: "V4 pool", proofs: { uniswapV4PoolProof: { ...uniswapV4PoolProvenance, ...privateFields,
      quoterPoolManagerCallData: "0x12", quoterPoolManagerReturnData: "0x34",
      stateViewPoolManagerCallData: "0x12", stateViewPoolManagerReturnData: "0x34",
      slot0CallData: "0x12", slot0ReturnData: "0x34", liquidityCallData: "0x12", liquidityReturnData: "0x34" } },
      provenance: { uniswapV4PoolProvenance } },
  ];
}
