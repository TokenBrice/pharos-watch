import { logWorkerEventArgs } from "../../lib/structured-log";
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

type VariantMatchOutcome = "added" | "duplicate";

function maybeAddVariant(
  pool: DlPool,
  seen: Set<string>,
  trackedSymbols: Set<string>,
  candidateSymbol: string,
  normalizedSymbol: string,
  results: DiscoveredVariant[],
): VariantMatchOutcome | null {
  if (!trackedSymbols.has(candidateSymbol)) {
    return null;
  }
  if (seen.has(normalizedSymbol)) {
    return "duplicate";
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
  return "added";
}

/**
 * C20 — the same wrapper symbol can appear on several chains with different TVL, and
 * DeFiLlama's iteration order is arbitrary. Scan the deepest pool first so the
 * reported variant is the largest one (the previous first-wins rule kept a $500k row
 * over its $900k twin) and log how many same-symbol duplicates were dropped.
 */
export function scanForNewVariants(
  dlPools: DlPool[],
  trackedSymbols: Set<string>,
  knownVariantSymbols: Set<string>,
): DiscoveredVariant[] {
  const results: DiscoveredVariant[] = [];
  const seen = new Set<string>();
  let discardedDuplicateCount = 0;

  for (const pool of [...dlPools].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    if (pool.exposure !== "single") continue;
    if (pool.tvlUsd < MIN_VARIANT_TVL_USD) continue;
    if (pool.apy <= 0) continue;

    const sym = pool.symbol.toUpperCase();
    if (knownVariantSymbols.has(sym)) continue;

    for (const prefix of WRAPPER_PREFIX_PATTERNS) {
      const prefixUpper = prefix.toUpperCase();
      if (sym.startsWith(prefixUpper) && sym.length > prefixUpper.length) {
        const outcome = maybeAddVariant(pool, seen, trackedSymbols, sym.slice(prefixUpper.length), sym, results);
        if (outcome === "duplicate") discardedDuplicateCount += 1;
      }
    }

    for (const suffix of WRAPPER_SUFFIX_PATTERNS) {
      const suffixUpper = suffix.toUpperCase();
      if (sym.endsWith(suffixUpper) && sym.length > suffixUpper.length) {
        const outcome = maybeAddVariant(pool, seen, trackedSymbols, sym.slice(0, -suffixUpper.length), sym, results);
        if (outcome === "duplicate") discardedDuplicateCount += 1;
      }
    }
  }

  if (discardedDuplicateCount > 0) {
    logWorkerEventArgs("handler", "info",
      `[sync-yield-data] Variant scanner kept the highest-TVL pool for ${discardedDuplicateCount} duplicate wrapper symbol match(es)`,
    );
  }
  return results;
}
