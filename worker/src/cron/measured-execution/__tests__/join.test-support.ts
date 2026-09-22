import type { DexMeasuredExecutionProfile, DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
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
