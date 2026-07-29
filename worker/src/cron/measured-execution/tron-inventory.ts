import { canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import {
  TRON_MEASURED_TARGET_SCHEMA_VERSION,
  TronMeasuredExecutionTargetSchema,
  buildTronMeasuredExecutionTargetId,
  type TronMeasuredExecutionTarget,
  type TronMeasuredExecutionToken,
} from "@shared/types/tron-measured-execution";
import type { DexApiPool, DexApiPoolToken } from "../../lib/dex-api-types";
import {
  resolveStablecoinIdForDexApiToken,
} from "../../lib/dex-api-token-pricing";
import type { PriceValidationReferences } from "../../lib/price-validation";
import {
  buildNativeMeasuredExecutionToken,
  buildNativeMeasuredPoolDirectionKey,
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

function buildToken(input: {
  pool: DexApiPool;
  token: DexApiPoolToken;
  tokenIndex: number;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
}): TronMeasuredExecutionToken | null {
  return buildNativeMeasuredExecutionToken({
    chain: "tron",
    pool: input.pool,
    token: input.token,
    tokenIndex: input.tokenIndex,
    chainAddressToId: input.chainAddressToId,
    symbolToChainScopedIds: input.symbolToChainScopedIds,
    validationReferences: input.validationReferences,
    stablecoinPriceById: input.stablecoinPriceById,
    allowSourceTokenUsd: true,
  }) as TronMeasuredExecutionToken | null;
}

export function buildTronMeasuredExecutionTargets(input: {
  pools: readonly DexApiPool[];
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  capturedAt: number;
}): Map<string, TronMeasuredExecutionTarget> {
  const targets = new Map<string, TronMeasuredExecutionTarget>();
  for (const pool of input.pools) {
    if (canonicalExitRouteChain(pool.chain) !== "tron" || pool.tokens.length !== 2) continue;
    const adapter = getTronMeasuredExecutionAdapter(pool.source, pool.poolType);
    if (
      !adapter ||
      pool.feeRate !== 0.003 ||
      !Number.isFinite(pool.tvlUsd) ||
      pool.tvlUsd <= 0
    ) continue;
    const poolId = pool.poolAddress.trim();

    for (let inputIndex = 0; inputIndex < 2; inputIndex++) {
      const rawTokenIn = pool.tokens[inputIndex]!;
      const stablecoinId = resolveStablecoinIdForDexApiToken(
        "tron",
        rawTokenIn,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
      );
      if (!stablecoinId) continue;
      const outputIndex = inputIndex === 0 ? 1 : 0;
      const tokenIn = buildToken({
        pool,
        token: rawTokenIn,
        tokenIndex: inputIndex,
        chainAddressToId: input.chainAddressToId,
        symbolToChainScopedIds: input.symbolToChainScopedIds,
        validationReferences: input.validationReferences,
        stablecoinPriceById: input.stablecoinPriceById,
      });
      const tokenOut = buildToken({
        pool,
        token: pool.tokens[outputIndex]!,
        tokenIndex: outputIndex,
        chainAddressToId: input.chainAddressToId,
        symbolToChainScopedIds: input.symbolToChainScopedIds,
        validationReferences: input.validationReferences,
        stablecoinPriceById: input.stablecoinPriceById,
      });
      if (!tokenIn || !tokenOut || tokenIn.trackedAssetId !== stablecoinId) continue;
      if (tokenOut.trackedAssetId === stablecoinId || tokenIn.address === tokenOut.address) continue;

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
        tokenIn,
        tokenOut,
        feeRate: 0.003,
        retainedTvlUsd: pool.tvlUsd,
        retainedPoolPriceUsd: tokenIn.referencePriceUsd,
        capturedAt: input.capturedAt,
      });
      if (parsed.success) targets.set(buildTronMeasuredPoolDirectionKey(stablecoinId, poolId), parsed.data);
    }
  }
  return targets;
}
