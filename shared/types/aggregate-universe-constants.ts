export const CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1 = "core-stablecoins-v1" as const;
export const CORE_STABLECOIN_AGGREGATE_UNIVERSE = "core-stablecoins-v2" as const;
export const CORE_STABLECOIN_AGGREGATE_UNIVERSES = [
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
] as const;

export type CoreStablecoinAggregateUniverse = (typeof CORE_STABLECOIN_AGGREGATE_UNIVERSES)[number];

/**
 * Single cutover-date authority (UTC YYYY-MM-DD, effective 00:00:00Z) for the
 * listing-policy v2 core aggregate switch (`core-stablecoins-v1` -> `core-stablecoins-v2`).
 * Historical dates strictly before this instant keep the frozen v1 membership;
 * dates from this instant onward use the v2 core aggregate.
 */
export const CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE = "2026-11-26" as const;
export const CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC =
  Date.parse(`${CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE}T00:00:00Z`) / 1000;

export function getCoreAggregateUniverseForTimestamp(timestampSec: number): CoreStablecoinAggregateUniverse {
  return timestampSec < CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC
    ? CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1
    : CORE_STABLECOIN_AGGREGATE_UNIVERSE;
}
