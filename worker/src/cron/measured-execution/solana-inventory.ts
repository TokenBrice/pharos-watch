import { canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  SolanaMeasuredExecutionTargetSchema,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
  type SolanaMeasuredExecutionToken,
} from "@shared/types/solana-measured-execution";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexApiPool, DexApiPoolToken } from "../../lib/dex-api-types";
import { resolveStablecoinIdForDexApiToken } from "../../lib/dex-api-token-pricing";
import {
  buildNativeMeasuredExecutionToken,
  buildNativeMeasuredPoolDirectionKey,
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

function buildToken(input: {
  pool: DexApiPool;
  token: DexApiPoolToken;
  tokenIndex: number;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
}): SolanaMeasuredExecutionToken | null {
  const token = buildNativeMeasuredExecutionToken({
    chain: "solana",
    pool: input.pool,
    token: input.token,
    tokenIndex: input.tokenIndex,
    chainAddressToId: input.chainAddressToId,
    symbolToChainScopedIds: input.symbolToChainScopedIds,
    validationReferences: input.validationReferences,
    stablecoinPriceById: input.stablecoinPriceById,
  });
  return token as SolanaMeasuredExecutionToken | null;
}

export function buildSolanaMeasuredExecutionTargets(input: {
  pools: readonly DexApiPool[];
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  capturedAt: number;
}): Map<string, SolanaMeasuredExecutionTarget> {
  const targets = new Map<string, SolanaMeasuredExecutionTarget>();
  for (const pool of input.pools) {
    if (canonicalExitRouteChain(pool.chain) !== "solana" || pool.tokens.length !== 2) continue;
    const adapter = getSolanaMeasuredExecutionAdapter(pool.source, pool.poolType);
    if (!adapter || !Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0) continue;
    const poolId = pool.poolAddress.trim();

    for (let inputIndex = 0; inputIndex < pool.tokens.length; inputIndex++) {
      const rawTokenIn = pool.tokens[inputIndex]!;
      const stablecoinId = resolveStablecoinIdForDexApiToken(
        "solana",
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
        tokenIn,
        tokenOut,
        retainedTvlUsd: pool.tvlUsd,
        retainedPoolPriceUsd: tokenIn.referencePriceUsd,
        capturedAt: input.capturedAt,
      });
      if (!parsed.success) continue;
      targets.set(buildSolanaMeasuredPoolDirectionKey(stablecoinId, poolId), parsed.data);
    }
  }
  return targets;
}
