import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import type { DexApiPoolToken } from "../../lib/dex-api-types";
import type { SymbolLookups } from "./types";

export interface TokenResolutionResult {
  status: "matched" | "ambiguous" | "unresolved";
  stablecoinId?: string;
  matchType?: "chain-address" | "unique-chain-symbol";
}

export interface TokenResolutionOptions {
  allowSymbolFallback?: boolean;
  allowSymbolFallbackWhenAddressPresent?: boolean;
}

export function normalizeTokenAddress(address: string): string {
  return (address ?? "").trim().toLowerCase();
}

export function buildChainAddressKey(chain: string, address: string): string {
  return canonicalExitRouteAssetKey(chain, address);
}

export function resolveStablecoinToken(
  chain: string,
  token: Pick<DexApiPoolToken, "address" | "symbol">,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
  options?: TokenResolutionOptions,
): TokenResolutionResult {
  const normalizedAddress = canonicalExitRouteScopedId(chain, token.address ?? "");
  if (normalizedAddress) {
    const byChainAddress = lookups.chainAddressToId.get(buildChainAddressKey(chain, normalizedAddress));
    if (byChainAddress) {
      return {
        status: "matched",
        stablecoinId: byChainAddress,
        matchType: "chain-address",
      };
    }

    if (options?.allowSymbolFallbackWhenAddressPresent !== true) {
      return { status: "unresolved" };
    }
  }

  if (options?.allowSymbolFallback === false) return { status: "unresolved" };

  const symbol = normalizeDexSymbol(token.symbol);
  if (!symbol) return { status: "unresolved" };

  const chainScoped = lookups.symbolToChainScopedIds.get(symbol)?.get(canonicalExitRouteChain(chain)) ?? [];
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
  options?: TokenResolutionOptions,
): TokenResolutionResult {
  return resolveStablecoinToken(
    input.chain,
    {
      address: input.address ?? "",
      symbol: input.symbol ?? "",
    },
    lookups,
    options,
  );
}

export function getChainScopedSymbolIds(
  symbol: string,
  chain: string,
  lookups: Pick<SymbolLookups, "symbolToChainScopedIds">,
): string[] {
  const normalized = normalizeDexSymbol(symbol);
  if (!normalized) return [];
  return lookups.symbolToChainScopedIds.get(normalized)?.get(canonicalExitRouteChain(chain)) ?? [];
}
