import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
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
