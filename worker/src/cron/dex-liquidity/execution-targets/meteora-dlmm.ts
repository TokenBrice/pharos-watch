import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";

/** Only the DLMM direct-source shape is recognized before native owner proof. */
export function buildMeteoraDlmmRegisteredExecutionTarget(
  { identity }: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  if (identity.chainNorm !== "solana" || identity.protocol !== "meteora" || identity.poolType !== "meteora-dlmm") return null;
  // cg-amm / dynamic AMM discovery must prove its actual program first. Never
  // transplant DLMM bins into a constant-product or stable invariant.
  return { executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } };
}
