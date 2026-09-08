import type { DexMeasuredExecutionProfile, DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PoolEntry } from "../../dex-liquidity/types";
import type { LoadedDexMeasuredQuoteEvidence } from "../evidence-reader";
import type { DexMeasuredRawQuotePoint } from "../profiles";

type EvidenceEntry = LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never;

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
