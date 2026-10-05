import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import { buildSolidlyV2ExecutionCandidate } from "../solidly-v2";
import { parsePoolSymbols } from "../pool-helpers";

/** A discovery candidate is not a quote target or evidence: the V2 enrichment proves it at one block. */
export function buildSolidlyV2RegisteredExecutionTarget(input: DexExecutionTargetFactoryInput): DexExecutionTargetFactoryOutput | null {
  const candidate = buildSolidlyV2ExecutionCandidate({
    chain: input.identity.chainNorm,
    protocol: input.identity.pool.project,
    poolType: input.enrichment.resolvedPoolType,
    poolAddress: input.identity.pool.pool,
    tokenAddresses: input.identity.pool.underlyingTokens ?? [],
    tokenSymbols: parsePoolSymbols(input.identity.pool.symbol),
  });
  return candidate ? { evmV2ExecutionCandidate: candidate } : null;
}
