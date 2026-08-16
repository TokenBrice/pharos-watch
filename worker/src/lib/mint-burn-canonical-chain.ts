// Lightweight canonical-chain overrides for consumers that only need to
// exclude known non-economic rows from downstream aggregates without loading
// the full mint-burn contract registry.
//
// DEWS (worker/src/lib/dews/source-state.ts) and the daily digest
// (worker/src/cron/daily-digest/collectors-market.ts) import from this file
// on a hot path — do NOT add imports that pull in mint-burn-contracts.ts or
// other heavy registries here. Gauge mcap weighting helpers that need the
// full MINT_BURN_CONFIGS list live in mint-burn-mcap-weighting.ts instead.

const NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN = new Map<string, string>([
  ["usdai-usd-ai", "arbitrum"],
]);

function getCanonicalMintBurnChainId(stablecoinId: string): string {
  return NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN.get(stablecoinId) ?? "ethereum";
}

export function isCanonicalMintBurnPair(stablecoinId: string, chainId: string): boolean {
  return getCanonicalMintBurnChainId(stablecoinId) === chainId;
}
