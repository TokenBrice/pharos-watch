import { normalizeDexSymbol } from "../../lib/dex-constants";
import type { DexApiPoolToken } from "../../lib/dex-api-types";
import type { SymbolLookups } from "./types";

export interface TokenResolutionResult {
  status: "matched" | "ambiguous" | "unresolved";
  stablecoinId?: string;
  matchType?: "chain-address" | "unique-chain-symbol";
}

export function normalizeTokenAddress(address: string): string {
  return (address ?? "").trim().toLowerCase();
}

export function buildChainAddressKey(chain: string, address: string): string {
  return `${chain.toLowerCase()}:${normalizeTokenAddress(address)}`;
}

export const makeChainAddressKey = buildChainAddressKey;

export function resolveStablecoinToken(
  chain: string,
  token: Pick<DexApiPoolToken, "address" | "symbol">,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): TokenResolutionResult {
  const byChainAddress = lookups.chainAddressToId.get(buildChainAddressKey(chain, token.address));
  if (byChainAddress) {
    return {
      status: "matched",
      stablecoinId: byChainAddress,
      matchType: "chain-address",
    };
  }

  const symbol = normalizeDexSymbol(token.symbol);
  if (!symbol) return { status: "unresolved" };

  const chainScoped = lookups.symbolToChainScopedIds.get(symbol)?.get(chain.toLowerCase()) ?? [];
  if (chainScoped.length === 1) {
    return {
      status: "matched",
      stablecoinId: chainScoped[0],
      matchType: "unique-chain-symbol",
    };
  }
  if (chainScoped.length > 1) {
    return { status: "ambiguous" };
  }

  return { status: "unresolved" };
}

export function resolveTrackedStablecoinId(
  input: { chain: string; address?: string | null; symbol?: string | null },
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): TokenResolutionResult {
  return resolveStablecoinToken(
    input.chain,
    {
      address: input.address ?? "",
      symbol: input.symbol ?? "",
    },
    lookups,
  );
}

export function getChainScopedSymbolIds(
  symbol: string,
  chain: string,
  lookups: Pick<SymbolLookups, "symbolToChainScopedIds">,
): string[] {
  const normalized = normalizeDexSymbol(symbol);
  if (!normalized) return [];
  return lookups.symbolToChainScopedIds.get(normalized)?.get(chain.toLowerCase()) ?? [];
}

export function getUniqueChainScopedSymbolId(
  symbol: string,
  chain: string,
  lookups: Pick<SymbolLookups, "symbolToChainScopedIds">,
): string | undefined {
  const ids = getChainScopedSymbolIds(symbol, chain, lookups);
  return ids.length === 1 ? ids[0] : undefined;
}

export function learnResolvedChainAddress(
  lookups: Pick<SymbolLookups, "chainAddressToId">,
  chain: string,
  address: string,
  stablecoinId: string,
): void {
  lookups.chainAddressToId.set(buildChainAddressKey(chain, address), stablecoinId);
}
