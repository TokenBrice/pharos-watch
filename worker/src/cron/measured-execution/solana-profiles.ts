import {
  SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION,
  SolanaMeasuredExecutionProfileSchema,
  type SolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionQuotePointProof,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import { DEX_MEASURED_MAX_COST_BPS, buildDexMeasuredCapacityCurve } from "@shared/types/measured-execution";

export function buildSolanaMeasuredExecutionProfile(input: {
  target: SolanaMeasuredExecutionTarget;
  targetGenerationId: string;
  quoteGenerationId: string;
  quotedAt: number;
  slotBefore: number;
  slotAfter: number;
  points: readonly SolanaMeasuredExecutionQuotePointProof[];
}): SolanaMeasuredExecutionProfile {
  const quoteProof = [...input.points].sort((left, right) => left.inputUsd - right.inputUsd);
  const marginal = quoteProof[0];
  if (!marginal || Math.abs(marginal.inputUsd - 1_000) > 0.02) {
    throw new Error(`Solana measured target ${input.target.targetId} has no marginal quote`);
  }
  return SolanaMeasuredExecutionProfileSchema.parse({
    schemaVersion: SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: input.target.targetId,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    adapterProfileId: input.target.adapterProfileId,
    protocol: input.target.protocol,
    chain: "solana",
    poolId: input.target.poolId,
    poolType: input.target.poolType,
    tokenIn: input.target.tokenIn,
    tokenOut: input.target.tokenOut,
    retainedTvlUsdAtQuote: input.target.retainedTvlUsd,
    retainedPoolPriceUsdAtQuote: input.target.retainedPoolPriceUsd,
    quotedAt: input.quotedAt,
    slotWindow: { before: input.slotBefore, after: input.slotAfter },
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: marginal.outputUsd / marginal.inputUsd,
    capacityCurve: buildDexMeasuredCapacityCurve(quoteProof, input.target.retainedTvlUsd),
    quoteProof,
  });
}
