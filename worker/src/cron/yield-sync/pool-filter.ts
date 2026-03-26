import { EXPLICIT_YIELD_SOURCE_POOL_MAP, YIELD_POOL_MAP, YIELD_VARIANT_MAP } from "../yield-config";
import type { DlPool } from "./types";

const yieldNativePoolIds = new Set(Object.values(YIELD_POOL_MAP));
const explicitYieldPoolIds = new Set(
  Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP)
    .flat()
    .map((config) => config.poolId),
);
const yieldVariantSymbols = new Set(
  Object.values(YIELD_VARIANT_MAP).map((variant) => variant.variantSymbol.toLowerCase()),
);

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (yieldNativePoolIds.has(pool.pool)) return true;
  if (explicitYieldPoolIds.has(pool.pool)) return true;
  return yieldVariantSymbols.has(pool.symbol.toLowerCase());
}
