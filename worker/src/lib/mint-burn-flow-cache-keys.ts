// Cache keys for published mint/burn flow payloads.
//
// Deliberately dependency-free: hot paths that must not load the mint-burn
// contract registry (daily digest, DEWS) read the published aggregate payload
// through these keys instead of recomputing flow aggregates themselves.
// `worker/src/lib/mint-burn-flows-service.ts` re-exports them for both delivery paths.

export const FLOW_CACHE_PREFIX = "mint-burn-flows:v3";

export function aggregateFlowCacheKey(hours: number): string {
  return `${FLOW_CACHE_PREFIX}:aggregate:${hours}`;
}

export function perCoinFlowCacheKey(stablecoinId: string, hours: number): string {
  return `${FLOW_CACHE_PREFIX}:coin:${stablecoinId}:${hours}`;
}
