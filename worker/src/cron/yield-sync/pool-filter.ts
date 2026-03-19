import { YIELD_POOL_MAP, YIELD_VARIANT_MAP } from "../yield-config";
import type { DlPool } from "./types";

function getYieldNativePoolIds(): Set<string> {
  return new Set(Object.values(YIELD_POOL_MAP));
}

function getYieldVariantSymbols(): Set<string> {
  return new Set(
    Object.values(YIELD_VARIANT_MAP).map((variant) => variant.variantSymbol.toLowerCase()),
  );
}

export function isYieldRelevantDlPool(
  pool: Pick<DlPool, "pool" | "symbol" | "stablecoin" | "exposure">,
): boolean {
  if (pool.exposure !== "single") return false;
  if (pool.stablecoin) return true;
  if (getYieldNativePoolIds().has(pool.pool)) return true;
  return getYieldVariantSymbols().has(pool.symbol.toLowerCase());
}
