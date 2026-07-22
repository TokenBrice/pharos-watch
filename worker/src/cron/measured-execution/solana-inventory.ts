import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import {
  SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
  SolanaMeasuredExecutionTargetSchema,
  buildSolanaMeasuredExecutionTargetId,
  type SolanaMeasuredExecutionTarget,
  type SolanaMeasuredExecutionToken,
} from "@shared/types/solana-measured-execution";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexApiPool, DexApiPoolToken } from "../../lib/dex-api-types";
import {
  deriveTokenUsdPrice,
  getTokenReferenceUsdPrice,
  resolveStablecoinIdForDexApiToken,
} from "../../lib/dex-api-token-pricing";
import { getSolanaMeasuredExecutionAdapter } from "./solana-registry";

export function buildSolanaMeasuredPoolDirectionKey(stablecoinId: string, poolId: string): string {
  const trimmedPoolId = poolId.trim();
  const physicalPoolId = trimmedPoolId.startsWith("solana:") ? trimmedPoolId.slice("solana:".length) : trimmedPoolId;
  return `${stablecoinId.trim().toLowerCase()}|${canonicalExitRouteAssetKey("solana", physicalPoolId)}`;
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
  const directPrice = getTokenReferenceUsdPrice(
    input.token,
    "solana",
    input.chainAddressToId,
    input.symbolToChainScopedIds,
    input.validationReferences,
    input.stablecoinPriceById,
  );
  const referencePriceUsd =
    directPrice ??
    deriveTokenUsdPrice(
      input.pool,
      input.tokenIndex,
      input.chainAddressToId,
      input.symbolToChainScopedIds,
      input.validationReferences,
      input.stablecoinPriceById,
    );
  const symbol = input.token.symbol.trim();
  if (
    referencePriceUsd == null ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0 ||
    !symbol ||
    !Number.isInteger(input.token.decimals) ||
    input.token.decimals < 0 ||
    input.token.decimals > 255
  )
    return null;
  const trackedAssetId = resolveStablecoinIdForDexApiToken(
    "solana",
    input.token,
    input.chainAddressToId,
    input.symbolToChainScopedIds,
  );
  return {
    address: input.token.address.trim(),
    symbol,
    decimals: input.token.decimals,
    referencePriceUsd,
    referencePriceSource: directPrice == null ? "pool-implied" : "tracked",
    ...(trackedAssetId ? { trackedAssetId } : {}),
  };
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
