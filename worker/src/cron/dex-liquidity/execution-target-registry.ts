export type DexExecutionTargetFactorySlotId =
  | "quoter-v2"
  | "uniswap-v4"
  | "orca-whirlpool"
  | "raydium-clmm"
  | "evm-v2";

export interface DexExecutionTargetFactoryRegistration {
  slotId: DexExecutionTargetFactorySlotId;
  platform: "evm" | "solana";
  lifecycle: "active" | "shadow" | "disabled";
  profileIds: readonly string[];
  implementationModule: string;
  build(input: DexExecutionTargetFactoryInput): DexExecutionTargetFactoryOutput | null;
}

export interface DexExecutionTargetFactoryInput {
  context: PoolProcessingContext;
  identity: ResolvedPoolIdentity;
  enrichment: PoolProtocolEnrichment;
  stablecoinId: string;
}

export type DexExecutionTargetFactoryOutput = Partial<PoolExecutionCapability>;

/**
 * Frozen target-factory slots. The paths are leaf ownership boundaries, not a
 * dynamic-import mechanism; Worker bundling remains statically analyzable.
 */
export const DEX_EXECUTION_TARGET_FACTORY_REGISTRY: readonly DexExecutionTargetFactoryRegistration[] = [
  {
    slotId: "quoter-v2",
    platform: "evm",
    lifecycle: "active",
    profileIds: [
      "uniswap-v3-quoter-v2",
      "pancakeswap-v3-quoter-v2",
      "aerodrome-slipstream-quoter-v2",
    ],
    implementationModule: "./execution-targets/quoter-v2",
    build: buildQuoterV2RegisteredExecutionTarget,
  },
  {
    slotId: "uniswap-v4",
    platform: "evm",
    lifecycle: "active",
    profileIds: ["uniswap-v4-hook-free-quoter-v1"],
    implementationModule: "./execution-targets/uniswap-v4",
    build: buildUniswapV4RegisteredExecutionTarget,
  },
  {
    slotId: "orca-whirlpool",
    platform: "solana",
    lifecycle: "shadow",
    profileIds: ["orca-whirlpool-exact-v1"],
    implementationModule: "../measured-execution/solana-clmm/orca",
    build: buildOrcaWhirlpoolRegisteredExecutionTarget,
  },
  {
    slotId: "raydium-clmm",
    platform: "solana",
    lifecycle: "shadow",
    profileIds: ["raydium-clmm-exact-v1"],
    implementationModule: "../measured-execution/solana-clmm/raydium",
    build: buildRaydiumClmmRegisteredExecutionTarget,
  },
  {
    slotId: "evm-v2",
    platform: "evm",
    lifecycle: "active",
    profileIds: ["evm-v2-constant-product-v1"],
    implementationModule: "./execution-targets/evm-v2",
    build: buildEvmV2RegisteredExecutionTarget,
  },
] as const;

export function buildRegisteredDexExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput {
  return DEX_EXECUTION_TARGET_FACTORY_REGISTRY.reduce<DexExecutionTargetFactoryOutput>(
    (combined, registration) => ({ ...combined, ...(registration.build(input) ?? {}) }),
    {},
  );
}

/**
 * An empty reduction means no registered leaf recognized the exact pool. Keep
 * that distinct from a fail-closed leaf result such as `target-unresolved`,
 * which must be retained by every caller of the registry.
 */
export function hasRegisteredDexExecutionTargetOutput(
  output: DexExecutionTargetFactoryOutput,
): boolean {
  return Object.values(output).some((value) => value !== undefined);
}
import type {
  PoolExecutionCapability,
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";
import { buildQuoterV2RegisteredExecutionTarget } from "./execution-targets/quoter-v2";
import { buildUniswapV4RegisteredExecutionTarget } from "./execution-targets/uniswap-v4";
import { buildEvmV2RegisteredExecutionTarget } from "./execution-targets/evm-v2";
import { buildOrcaWhirlpoolRegisteredExecutionTarget } from "../measured-execution/solana-clmm/orca";
import { buildRaydiumClmmRegisteredExecutionTarget } from "../measured-execution/solana-clmm/raydium";
