import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/lib/exit-route-identity";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexApiPool, DexApiPoolToken } from "../../lib/dex-api-types";
import {
  deriveTokenUsdPrice,
  getTokenReferenceUsdPrice,
  resolveStablecoinIdForDexApiToken,
} from "../../lib/dex-api-token-pricing";

export type NativeMeasuredExecutionChain = "solana" | "tron";
export type NativeMeasuredExecutionReferencePriceSource =
  | "tracked"
  | "source-token-usd"
  | "pool-implied";

export interface NativeMeasuredExecutionTokenFields {
  address: string;
  symbol: string;
  decimals: number;
  referencePriceUsd: number;
  referencePriceSource: NativeMeasuredExecutionReferencePriceSource;
  trackedAssetId?: string;
}

export interface NativeMeasuredExecutionInventoryInput {
  pools: readonly DexApiPool[];
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  capturedAt: number;
}

export interface NativeMeasuredExecutionInventoryAdapter<TTarget, TPoolAdapter> {
  chain: NativeMeasuredExecutionChain;
  stripPoolChainPrefix?: boolean;
  allowSourceTokenUsd?: boolean;
  getPoolAdapter(pool: DexApiPool): TPoolAdapter | null;
  isPoolEligible(pool: DexApiPool, adapter: TPoolAdapter): boolean;
  buildTarget(input: {
    pool: DexApiPool;
    poolId: string;
    stablecoinId: string;
    tokenIn: NativeMeasuredExecutionTokenFields;
    tokenOut: NativeMeasuredExecutionTokenFields;
    adapter: TPoolAdapter;
    capturedAt: number;
  }): TTarget | null;
}

export function buildNativeMeasuredPoolDirectionKey(input: {
  stablecoinId: string;
  chain: NativeMeasuredExecutionChain;
  poolId: string;
  stripChainPrefix?: boolean;
}): string {
  const trimmedPoolId = input.poolId.trim();
  const physicalPoolId =
    input.stripChainPrefix && trimmedPoolId.startsWith(`${input.chain}:`)
      ? trimmedPoolId.slice(`${input.chain}:`.length)
      : trimmedPoolId;
  return `${input.stablecoinId.trim().toLowerCase()}|${canonicalExitRouteAssetKey(input.chain, physicalPoolId)}`;
}

export function buildNativeMeasuredExecutionToken(input: {
  chain: NativeMeasuredExecutionChain;
  pool: DexApiPool;
  token: DexApiPoolToken;
  tokenIndex: number;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  allowSourceTokenUsd?: boolean;
}): NativeMeasuredExecutionTokenFields | null {
  const trackedAssetId = resolveStablecoinIdForDexApiToken(
    input.chain,
    input.token,
    input.chainAddressToId,
    input.symbolToChainScopedIds,
  );
  const trackedPrice = getTokenReferenceUsdPrice(
    input.token,
    input.chain,
    input.chainAddressToId,
    input.symbolToChainScopedIds,
    input.validationReferences,
    input.stablecoinPriceById,
  );
  const sourcePrice =
    input.allowSourceTokenUsd === true &&
    input.token.priceUsd != null &&
    Number.isFinite(input.token.priceUsd) &&
    input.token.priceUsd > 0
      ? input.token.priceUsd
      : null;
  const impliedPrice = deriveTokenUsdPrice(
    input.pool,
    input.tokenIndex,
    input.chainAddressToId,
    input.symbolToChainScopedIds,
    input.validationReferences,
    input.stablecoinPriceById,
  );
  const referencePriceUsd = trackedPrice ?? sourcePrice ?? impliedPrice;
  const symbol = input.token.symbol.trim();
  if (
    referencePriceUsd == null ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0 ||
    !symbol ||
    !Number.isInteger(input.token.decimals) ||
    input.token.decimals < 0 ||
    input.token.decimals > 255
  ) return null;
  return {
    address: input.token.address.trim(),
    symbol,
    decimals: input.token.decimals,
    referencePriceUsd,
    referencePriceSource: trackedPrice != null
      ? "tracked"
      : sourcePrice != null
        ? "source-token-usd"
        : "pool-implied",
    ...(trackedAssetId ? { trackedAssetId } : {}),
  };
}

export function buildNativeMeasuredExecutionTargets<TTarget, TPoolAdapter>(
  input: NativeMeasuredExecutionInventoryInput,
  adapter: NativeMeasuredExecutionInventoryAdapter<TTarget, TPoolAdapter>,
): Map<string, TTarget> {
  const targets = new Map<string, TTarget>();
  for (const pool of input.pools) {
    if (canonicalExitRouteChain(pool.chain) !== adapter.chain || pool.tokens.length !== 2) continue;
    const poolAdapter = adapter.getPoolAdapter(pool);
    if (
      !poolAdapter ||
      !adapter.isPoolEligible(pool, poolAdapter) ||
      !Number.isFinite(pool.tvlUsd) ||
      pool.tvlUsd <= 0
    ) continue;
    const poolId = pool.poolAddress.trim();

    for (let inputIndex = 0; inputIndex < pool.tokens.length; inputIndex++) {
      const rawTokenIn = pool.tokens[inputIndex]!;
      const stablecoinId = resolveStablecoinIdForDexApiToken(
        adapter.chain,
        rawTokenIn,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
      );
      if (!stablecoinId) continue;
      const outputIndex = inputIndex === 0 ? 1 : 0;
      const tokenIn = buildNativeMeasuredExecutionToken({
        chain: adapter.chain,
        pool,
        token: rawTokenIn,
        tokenIndex: inputIndex,
        chainAddressToId: input.chainAddressToId,
        symbolToChainScopedIds: input.symbolToChainScopedIds,
        validationReferences: input.validationReferences,
        stablecoinPriceById: input.stablecoinPriceById,
        allowSourceTokenUsd: adapter.allowSourceTokenUsd,
      });
      const tokenOut = buildNativeMeasuredExecutionToken({
        chain: adapter.chain,
        pool,
        token: pool.tokens[outputIndex]!,
        tokenIndex: outputIndex,
        chainAddressToId: input.chainAddressToId,
        symbolToChainScopedIds: input.symbolToChainScopedIds,
        validationReferences: input.validationReferences,
        stablecoinPriceById: input.stablecoinPriceById,
        allowSourceTokenUsd: adapter.allowSourceTokenUsd,
      });
      if (!tokenIn || !tokenOut || tokenIn.trackedAssetId !== stablecoinId) continue;
      if (tokenOut.trackedAssetId === stablecoinId || tokenIn.address === tokenOut.address) continue;
      const target = adapter.buildTarget({
        pool,
        poolId,
        stablecoinId,
        tokenIn,
        tokenOut,
        adapter: poolAdapter,
        capturedAt: input.capturedAt,
      });
      if (!target) continue;
      targets.set(
        buildNativeMeasuredPoolDirectionKey({
          stablecoinId,
          chain: adapter.chain,
          poolId,
          stripChainPrefix: adapter.stripPoolChainPrefix,
        }),
        target,
      );
    }
  }
  return targets;
}
