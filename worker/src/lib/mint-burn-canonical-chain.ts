// Lightweight canonical-chain overrides for consumers that only need to
// exclude known non-economic rows from downstream aggregates without loading
// the full mint-burn contract registry.

const NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN = new Map<string, string>([
  ["usdai-usd-ai", "arbitrum"],
]);

function getCanonicalMintBurnChainId(stablecoinId: string): string {
  return NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN.get(stablecoinId) ?? "ethereum";
}

export function isCanonicalMintBurnPair(stablecoinId: string, chainId: string): boolean {
  return getCanonicalMintBurnChainId(stablecoinId) === chainId;
}
