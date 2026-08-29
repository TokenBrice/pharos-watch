// Public surface for yield-sync cache serialization and key assembly.
// Implementation is split across three siblings under ./cache/:
//   - normalization.ts            shared coercion primitives + RFR payloads
//                                 + deterministic on-chain health state +
//                                 yield-rankings published-cutoff parsing
//   - defillama-pool-cache.ts     DL pool shaping (validate/filter/build/parse)
//   - supplemental-cache-keys.ts  supplemental keying + supplemental cache
//                                 (build/parse) + candidate validation
export {
  buildRiskFreeRateCachePayload,
  serializeRiskFreeRateCache,
  buildRiskFreeRatesCachePayload,
  serializeRiskFreeRatesCache,
  parseRiskFreeRateCache,
  parseRiskFreeRatesCache,
  getDefaultDeterministicOnChainHealthState,
  serializeDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  type DeterministicOnChainHealthState,
} from "./cache/normalization";

export {
  buildDlStablecoinPoolsCache,
  parseDlStablecoinPoolsCache,
} from "./cache/defillama-pool-cache";

export {
  getYieldSupplementalFamilyCacheKey,
  buildYieldSupplementalFamilyCache,
  parseYieldSupplementalSourcesCache,
} from "./cache/supplemental-cache-keys";
