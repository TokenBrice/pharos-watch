import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";

/** Native quotes have their own diagnostic store, never a V1 scoring target. */
export function buildOrcaWhirlpoolRegisteredExecutionTarget(
  { identity }: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  if (identity.chainNorm !== "solana" || identity.protocol !== "orca") return null;
  return { executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } };
}
