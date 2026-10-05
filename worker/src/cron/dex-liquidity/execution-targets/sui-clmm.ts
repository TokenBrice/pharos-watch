import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import { suiClmmFamily, suiClmmPoolId, suiCoinType } from "../sui/identity";

/** Native object/Move-type identities never enter the EVM-only V1 target schema.
 * The native shadow collector proves package, pool and currency identities on chain. */
export function buildSuiClmmRegisteredExecutionTarget(
  { identity }: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  if (identity.chainNorm !== "sui" || !suiClmmFamily(identity.protocol)) return null;
  const poolId = suiClmmPoolId(identity.pool.pool);
  const coins = identity.pool.underlyingTokens?.map(suiCoinType);
  const resolved = poolId != null && coins?.length === 2 && coins.every((coin) => coin != null) && coins[0] !== coins[1];
  return { executionCapabilityGate: { family: "measured-execution", reason: resolved ? "activation-pending" : "target-unresolved" } };
}
