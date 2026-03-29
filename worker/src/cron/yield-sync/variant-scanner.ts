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

function maybeAddVariant(
  pool: DlPool,
  seen: Set<string>,
  trackedSymbols: Set<string>,
  candidateSymbol: string,
  normalizedSymbol: string,
  results: DiscoveredVariant[],
): void {
  if (!trackedSymbols.has(candidateSymbol) || seen.has(normalizedSymbol)) {
    return;
  }

  results.push({
    baseSymbol: candidateSymbol,
    variantSymbol: pool.symbol,
    poolId: pool.pool,
    chain: pool.chain,
    project: pool.project,
    tvlUsd: pool.tvlUsd,
    apy: pool.apy,
  });
  seen.add(normalizedSymbol);
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
        maybeAddVariant(pool, seen, trackedSymbols, sym.slice(prefixUpper.length), sym, results);
      }
    }

    for (const suffix of WRAPPER_SUFFIX_PATTERNS) {
      const suffixUpper = suffix.toUpperCase();
      if (sym.endsWith(suffixUpper) && sym.length > suffixUpper.length) {
        maybeAddVariant(pool, seen, trackedSymbols, sym.slice(0, -suffixUpper.length), sym, results);
      }
    }
  }
  return results;
}
