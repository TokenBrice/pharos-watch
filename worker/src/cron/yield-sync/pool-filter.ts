import {
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../../lib/yield-config/yield-config";
import type { DlPool } from "./types";

function isNativeYieldPoolId(poolId: string): boolean {
  return Object.values(YIELD_POOL_MAP).includes(poolId);
}

function isExplicitYieldPoolId(poolId: string): boolean {
  return Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP)
    .flat()
    .some((config) => config.poolId === poolId);
}

function isYieldVariantSymbol(symbol: string): boolean {
  const normalizedSymbol = symbol.toLowerCase();
  return Object.values(YIELD_VARIANT_MAP)
    .some((variant) => variant.variantSymbol.toLowerCase() === normalizedSymbol);
}

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (isNativeYieldPoolId(pool.pool)) return true;
  if (isExplicitYieldPoolId(pool.pool)) return true;
  return isYieldVariantSymbol(pool.symbol);
}
