import type { DlPool } from "./types";

const MIN_VARIANT_TVL_USD = 500_000;
const WRAPPER_PREFIX_PATTERNS = ["s", "st", "w"];
const WRAPPER_SUFFIX_PATTERNS = ["SAVE", "VAULT", "EARN", "STAKE"];

interface DiscoveredVariant {
  baseSymbol: string;
  variantSymbol: string;
  poolId: string;
  chain: string;
  project: string;
  tvlUsd: number;
  apy: number;
}

export function scanForNewVariants(
  dlPools: DlPool[],
  trackedSymbols: Set<string>,
  knownVariantSymbols: Set<string>,
): DiscoveredVariant[] {
  const results: DiscoveredVariant[] = [];
  const seen = new Set<string>();

  for (const pool of dlPools) {
    if (pool.exposure !== "single") continue;
    if (pool.tvlUsd < MIN_VARIANT_TVL_USD) continue;
    if (pool.apy <= 0) continue;

    const sym = pool.symbol.toUpperCase();
    if (knownVariantSymbols.has(sym)) continue;

    for (const prefix of WRAPPER_PREFIX_PATTERNS) {
      const prefixUpper = prefix.toUpperCase();
      if (sym.startsWith(prefixUpper) && sym.length > prefixUpper.length) {
        const candidate = sym.slice(prefixUpper.length);
        if (trackedSymbols.has(candidate) && !seen.has(sym)) {
          results.push({
            baseSymbol: candidate,
            variantSymbol: pool.symbol,
            poolId: pool.pool,
            chain: pool.chain,
            project: pool.project,
            tvlUsd: pool.tvlUsd,
            apy: pool.apy,
          });
          seen.add(sym);
        }
      }
    }

    for (const suffix of WRAPPER_SUFFIX_PATTERNS) {
      const suffixUpper = suffix.toUpperCase();
      if (sym.endsWith(suffixUpper) && sym.length > suffixUpper.length) {
        const candidate = sym.slice(0, -suffixUpper.length);
        if (trackedSymbols.has(candidate) && !seen.has(sym)) {
          results.push({
            baseSymbol: candidate,
            variantSymbol: pool.symbol,
            poolId: pool.pool,
            chain: pool.chain,
            project: pool.project,
            tvlUsd: pool.tvlUsd,
            apy: pool.apy,
          });
          seen.add(sym);
        }
      }
    }
  }
  return results;
}
