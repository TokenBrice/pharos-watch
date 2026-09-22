import {
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../../lib/yield-config/yield-config";
import type { DlPool } from "./types";

const NATIVE_YIELD_POOL_IDS = new Set(Object.values(YIELD_POOL_MAP));
const EXPLICIT_YIELD_POOL_IDS = new Set(
  Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP)
    .flat()
    .map((config) => config.poolId),
);
const YIELD_VARIANT_SYMBOLS = new Set(
  Object.values(YIELD_VARIANT_MAP).map((variant) => variant.variantSymbol.toLowerCase()),
);

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (NATIVE_YIELD_POOL_IDS.has(pool.pool)) return true;
  if (EXPLICIT_YIELD_POOL_IDS.has(pool.pool)) return true;
  return YIELD_VARIANT_SYMBOLS.has(pool.symbol.toLowerCase());
}
