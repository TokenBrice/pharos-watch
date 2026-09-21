import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";

/** Native evidence stays isolated from V1 quote generations and scoring. */
export function buildRaydiumClmmRegisteredExecutionTarget(
  { identity }: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  if (identity.chainNorm !== "solana" || identity.protocol !== "raydium" || identity.poolType !== "raydium-clmm") return null;
  return { executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } };
}
