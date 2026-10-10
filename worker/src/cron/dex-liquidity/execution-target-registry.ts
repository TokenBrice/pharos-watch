import type {
  PoolExecutionCapability,
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";
import { buildQuoterV2RegisteredExecutionTarget } from "./execution-targets/quoter-v2";
import { buildUniswapV4RegisteredExecutionTarget } from "./execution-targets/uniswap-v4";
import { buildEvmV2RegisteredExecutionTarget } from "./execution-targets/evm-v2";
import { buildSuiClmmRegisteredExecutionTarget } from "./execution-targets/sui-clmm";

export interface DexExecutionTargetFactoryInput {
  context: PoolProcessingContext;
  identity: ResolvedPoolIdentity;
  enrichment: PoolProtocolEnrichment;
  stablecoinId: string;
}
export type DexExecutionTargetFactoryOutput = Partial<PoolExecutionCapability>;

const SOLANA_PENDING_FAMILIES = [
  { protocol: "orca" },
  { protocol: "raydium", poolType: "raydium-clmm" },
  { protocol: "meteora", poolType: "meteora-dlmm" },
] as const;

/** Native diagnostics never activate a V1 scoring target. */
function buildPendingSolanaGate(
  { identity }: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  if (identity.chainNorm !== "solana") return null;
  const matched = SOLANA_PENDING_FAMILIES.some((row) =>
    row.protocol === identity.protocol &&
    (!("poolType" in row) || row.poolType === identity.poolType));
  return matched
    ? { executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } }
    : null;
}

const FACTORIES = [
  buildQuoterV2RegisteredExecutionTarget,
  buildUniswapV4RegisteredExecutionTarget,
  buildPendingSolanaGate,
  buildSuiClmmRegisteredExecutionTarget,
  buildEvmV2RegisteredExecutionTarget,
] as const;

export function buildRegisteredDexExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput {
  const combined: DexExecutionTargetFactoryOutput = {};
  for (const build of FACTORIES) Object.assign(combined, build(input));
  return combined;
}

/** No recognized output is distinct from a fail-closed leaf gate. */
export function hasRegisteredDexExecutionTargetOutput(
  output: DexExecutionTargetFactoryOutput,
): boolean {
  return Object.values(output).some((value) => value !== undefined);
}
