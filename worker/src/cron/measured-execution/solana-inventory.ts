import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  SolanaMeasuredExecutionTargetSchema,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
  type SolanaMeasuredExecutionToken,
} from "@shared/types/solana-measured-execution";
import {
  buildNativeMeasuredExecutionTargets,
  buildNativeMeasuredPoolDirectionKey,
  type NativeMeasuredExecutionInventoryAdapter,
  type NativeMeasuredExecutionInventoryInput,
} from "./native-inventory";
import { getSolanaMeasuredExecutionAdapter } from "./solana-registry";

export function buildSolanaMeasuredPoolDirectionKey(stablecoinId: string, poolId: string): string {
  return buildNativeMeasuredPoolDirectionKey({
    stablecoinId,
    chain: "solana",
    poolId,
    stripChainPrefix: true,
  });
}

type SolanaPoolAdapter = NonNullable<ReturnType<typeof getSolanaMeasuredExecutionAdapter>>;

const SOLANA_INVENTORY_ADAPTER: NativeMeasuredExecutionInventoryAdapter<
  SolanaMeasuredExecutionTarget,
  SolanaPoolAdapter
> = {
  chain: "solana",
  stripPoolChainPrefix: true,
  getPoolAdapter: (pool) => getSolanaMeasuredExecutionAdapter(pool.source, pool.poolType),
  isPoolEligible: () => true,
  buildTarget: ({ pool, poolId, stablecoinId, tokenIn, tokenOut, adapter, capturedAt }) => {
    const targetId = buildSolanaMeasuredExecutionTargetId({
      stablecoinId,
      adapterProfileId: adapter.adapterProfileId,
      protocol: adapter.protocol,
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
    });
    const parsed = SolanaMeasuredExecutionTargetSchema.safeParse({
      schemaVersion: SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
      targetId,
      stablecoinId,
      adapterProfileId: adapter.adapterProfileId,
      protocol: adapter.protocol,
      chain: "solana",
      poolId,
      poolType: adapter.poolType,
      tokenIn: tokenIn as SolanaMeasuredExecutionToken,
      tokenOut: tokenOut as SolanaMeasuredExecutionToken,
      retainedTvlUsd: pool.tvlUsd,
      retainedPoolPriceUsd: tokenIn.referencePriceUsd,
      capturedAt,
    });
    return parsed.success ? parsed.data : null;
  },
};

export function buildSolanaMeasuredExecutionTargets(
  input: NativeMeasuredExecutionInventoryInput,
): Map<string, SolanaMeasuredExecutionTarget> {
  return buildNativeMeasuredExecutionTargets(input, SOLANA_INVENTORY_ADAPTER);
}
