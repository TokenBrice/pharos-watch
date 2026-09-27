import { EXTRA_FALLBACK_RPC_URLS, PUBLIC_RPC_URLS } from "@shared/lib/chain-rpc-registry";

export function getPublicRpcUrl(chainId: string): string | undefined {
  return PUBLIC_RPC_URLS[chainId];
}

export function getPublicFallbackRpcUrls(chainId: string): string[] {
  const primary = getPublicRpcUrl(chainId);
  return [...(primary ? [primary] : []), ...(EXTRA_FALLBACK_RPC_URLS[chainId] ?? [])];
}

export function getSecondaryFallbackRpcUrl(chainId: string): string | undefined {
  return EXTRA_FALLBACK_RPC_URLS[chainId]?.[0];
}
