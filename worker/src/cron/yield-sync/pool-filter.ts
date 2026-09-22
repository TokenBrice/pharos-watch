import {
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../../lib/yield-config/yield-config";
import type { DlPool } from "./types";

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (Object.values(YIELD_POOL_MAP).includes(pool.pool)) return true;
  if (Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP).flat().some((config) => config.poolId === pool.pool)) {
    return true;
  }
  const normalizedSymbol = pool.symbol.toLowerCase();
  return Object.values(YIELD_VARIANT_MAP)
    .some((variant) => variant.variantSymbol.toLowerCase() === normalizedSymbol);
}
