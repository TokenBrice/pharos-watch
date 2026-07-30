import {
  TRON_MEASURED_TARGET_SCHEMA_VERSION,
  TronMeasuredExecutionTargetSchema,
  buildTronMeasuredExecutionTargetId,
  type TronMeasuredExecutionTarget,
  type TronMeasuredExecutionToken,
} from "@shared/types/tron-measured-execution";
import {
  buildNativeMeasuredExecutionTargets,
  buildNativeMeasuredPoolDirectionKey,
  type NativeMeasuredExecutionInventoryAdapter,
  type NativeMeasuredExecutionInventoryInput,
} from "./native-inventory";
import {
  SUNSWAP_V2_FACTORY_ADDRESS,
  SUNSWAP_V2_FACTORY_CODE_HASH,
  SUNSWAP_V2_PAIR_CODE_HASH,
  getTronMeasuredExecutionAdapter,
} from "./tron-registry";

export function buildTronMeasuredPoolDirectionKey(stablecoinId: string, poolId: string): string {
  return buildNativeMeasuredPoolDirectionKey({
    stablecoinId,
    chain: "tron",
    poolId,
  });
}

type TronPoolAdapter = NonNullable<ReturnType<typeof getTronMeasuredExecutionAdapter>>;

const TRON_INVENTORY_ADAPTER: NativeMeasuredExecutionInventoryAdapter<
  TronMeasuredExecutionTarget,
  TronPoolAdapter
> = {
  chain: "tron",
  allowSourceTokenUsd: true,
  getPoolAdapter: (pool) => getTronMeasuredExecutionAdapter(pool.source, pool.poolType),
  isPoolEligible: (pool) => pool.feeRate === 0.003,
  buildTarget: ({ pool, poolId, stablecoinId, tokenIn, tokenOut, adapter, capturedAt }) => {
    const targetId = buildTronMeasuredExecutionTargetId({
      stablecoinId,
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
    });
    const parsed = TronMeasuredExecutionTargetSchema.safeParse({
      schemaVersion: TRON_MEASURED_TARGET_SCHEMA_VERSION,
      targetId,
      stablecoinId,
      adapterProfileId: adapter.adapterProfileId,
      protocol: adapter.protocol,
      chain: "tron",
      poolId,
      poolType: adapter.poolType,
      factoryAddress: SUNSWAP_V2_FACTORY_ADDRESS,
      expectedFactoryCodeHash: SUNSWAP_V2_FACTORY_CODE_HASH,
      expectedPairCodeHash: SUNSWAP_V2_PAIR_CODE_HASH,
      tokenIn: tokenIn as TronMeasuredExecutionToken,
      tokenOut: tokenOut as TronMeasuredExecutionToken,
      feeRate: 0.003,
      retainedTvlUsd: pool.tvlUsd,
      retainedPoolPriceUsd: tokenIn.referencePriceUsd,
      capturedAt,
    });
    return parsed.success ? parsed.data : null;
  },
};

export function buildTronMeasuredExecutionTargets(
  input: NativeMeasuredExecutionInventoryInput,
): Map<string, TronMeasuredExecutionTarget> {
  return buildNativeMeasuredExecutionTargets(input, TRON_INVENTORY_ADAPTER);
}
