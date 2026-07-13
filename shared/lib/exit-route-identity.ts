import { CHAIN_META, resolveChainId } from "./chains";

export function canonicalExitRouteChain(chain: string): string {
  return resolveChainId(chain) ?? chain.trim().toLowerCase();
}

export function canonicalExitRouteScopedId(chain: string, identifier: string): string {
  const canonicalChain = canonicalExitRouteChain(chain);
  const trimmed = identifier.trim();
  return CHAIN_META[canonicalChain]?.type === "evm" ? trimmed.toLowerCase() : trimmed;
}

export function canonicalExitRouteScopedKey(chain: string, identifier: string): string {
  const canonicalChain = canonicalExitRouteChain(chain);
  const trimmed = identifier.trim();
  const separatorIndex = trimmed.indexOf(":");
  const unscoped =
    separatorIndex >= 0 && canonicalExitRouteChain(trimmed.slice(0, separatorIndex)) === canonicalChain
      ? trimmed.slice(separatorIndex + 1)
      : trimmed;
  return `${canonicalChain}:${canonicalExitRouteScopedId(canonicalChain, unscoped)}`;
}

export function canonicalExitRouteAssetKey(chain: string, address: string): string {
  return canonicalExitRouteScopedKey(chain, address);
}

export function encodeExitRouteIdentityPart(value: string): string {
  return encodeURIComponent(value.trim());
}

/**
 * Correlation keys are case-insensitive labels except for chain-scoped
 * non-EVM identifiers such as Solana pool and mint addresses.
 */
export function normalizeExitRouteCorrelationKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const segments = trimmed.split(":");
  const identityPrefix = segments[0]?.toLowerCase();
  const hasIdentityPrefix = identityPrefix === "asset-key" || identityPrefix === "pool" || identityPrefix === "token";
  const chainIndex = hasIdentityPrefix ? 1 : 0;
  const chain = segments[chainIndex];
  const identifier = segments.slice(chainIndex + 1).join(":");
  const canonicalChain = chain ? resolveChainId(chain) : null;

  if (canonicalChain && identifier) {
    const scoped = `${canonicalChain}:${canonicalExitRouteScopedId(canonicalChain, identifier)}`;
    return hasIdentityPrefix ? `${identityPrefix}:${scoped}` : scoped;
  }

  return trimmed.toLowerCase();
}
