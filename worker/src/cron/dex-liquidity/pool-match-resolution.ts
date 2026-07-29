import type { LlamaPool, SymbolLookups } from "./types";
import { parsePoolSymbols } from "./pool-helpers";
import { buildChainAddressKey, getChainScopedSymbolIds, normalizeTokenAddress } from "./token-resolution";

export interface LlamaPoolStablecoinMatch {
  hasUnderlyingTokenAddresses: boolean;
  matchedIds: Set<string>;
  poolSymbols: string[];
}

export function resolveLlamaPoolStablecoinMatches(
  pool: Pick<LlamaPool, "chain" | "symbol" | "underlyingTokens">,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): LlamaPoolStablecoinMatch {
  const poolSymbols = parsePoolSymbols(pool.symbol);
  const matchedIds = new Set<string>();
  const hasUnderlyingTokenAddresses =
    pool.underlyingTokens?.some((addr) => normalizeTokenAddress(addr).length > 0) ?? false;

  if (hasUnderlyingTokenAddresses) {
    for (const addr of pool.underlyingTokens ?? []) {
      const id = lookups.chainAddressToId.get(buildChainAddressKey(pool.chain, addr));
      if (id) matchedIds.add(id);
    }
  }

  if (!hasUnderlyingTokenAddresses) {
    for (const sym of poolSymbols) {
      const ids = getChainScopedSymbolIds(sym, pool.chain, lookups);
      if (ids.length === 1) {
        matchedIds.add(ids[0]!);
      }
    }
  }

  return {
    hasUnderlyingTokenAddresses,
    matchedIds,
    poolSymbols,
  };
}
