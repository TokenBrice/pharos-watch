import {
  TRON_MEASURED_EXECUTION_SCHEMA_VERSION,
  TronMeasuredExecutionProfileSchema,
  type TronMeasuredExecutionProfile,
  type TronMeasuredExecutionQuotePointProof,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { DEX_MEASURED_MAX_COST_BPS, buildDexMeasuredCapacityCurve } from "@shared/types/measured-execution";

export function buildTronMeasuredExecutionProfile(input: {
  target: TronMeasuredExecutionTarget;
  targetGenerationId: string;
  quoteGenerationId: string;
  quotedAt: number;
  points: readonly TronMeasuredExecutionQuotePointProof[];
}): TronMeasuredExecutionProfile {
  const quoteProof = [...input.points].sort((left, right) => left.inputUsd - right.inputUsd);
  const marginal = quoteProof[0];
  if (!marginal || Math.abs(marginal.inputUsd - 1_000) > 0.02) {
    throw new Error(`Tron measured target ${input.target.targetId} has no marginal quote`);
  }
  return TronMeasuredExecutionProfileSchema.parse({
    schemaVersion: TRON_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: input.target.targetId,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    adapterProfileId: input.target.adapterProfileId,
    protocol: input.target.protocol,
    chain: "tron",
    poolId: input.target.poolId,
    poolType: input.target.poolType,
    tokenIn: input.target.tokenIn,
    tokenOut: input.target.tokenOut,
    retainedTvlUsdAtQuote: input.target.retainedTvlUsd,
    retainedPoolPriceUsdAtQuote: input.target.retainedPoolPriceUsd,
    quotedAt: input.quotedAt,
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: marginal.outputUsd / marginal.inputUsd,
    capacityCurve: buildDexMeasuredCapacityCurve(quoteProof, input.target.retainedTvlUsd),
    quoteProof,
  });
}
