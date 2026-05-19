/**
 * Profile weight vectors and the load-time `sum = 100` invariant.
 *
 * The vectors below are the R2-final numbers from
 * `agents/selector-implementation-plan.md` §3.2. A buggy edit must break at
 * module import time, not at test time — `assertWeightsSumTo100` runs for
 * each profile when this module loads.
 */
import {
  SELECTOR_PROFILES,
  type SelectorProfile,
  type WeightKey,
  type WeightVector,
} from "./types";

/**
 * Bumped on any weight or exclusion-rule change. Matches `ENGINE_VERSION`.
 */
export const WEIGHTS_VERSION = "selector-v1.0";

/** R2-final Treasury weights — sum = 100. */
const TREASURY_WEIGHTS: WeightVector<"treasury"> = {
  safetyOverall: 30,
  resilience: 20,
  dependencyRisk: 17,
  pegStabilityHistory: 12,
  decentralization: 10,
  dewsInverted: 6,
  bluechip: 5,
  supplyLog: 0,
} as const;

/** R2-final Yield weights — sum = 100. */
const YIELD_WEIGHTS: WeightVector<"yield"> = {
  pharosYieldScore: 28,
  yieldVariance: 16,
  safetyOverall: 14,
  sourceRiskInverted: 13,
  excessApy: 10,
  pegStabilityLive: 8,
  liquidity: 6,
  resilience: 5,
} as const;

/** R2-final Active Trading weights — sum = 100. */
const TRADING_WEIGHTS: WeightVector<"trading"> = {
  liquidity: 30,
  pegScoreNow: 20,
  dewsInverted: 15,
  pegStabilityLive: 10,
  effectiveExit: 10,
  supplyLog: 8,
  safetyOverall: 4,
  liquidityDiversification: 3,
} as const;

/**
 * Throws when the supplied weight vector does not sum to 100. Used at module
 * load and re-exported so callers (frontend, snapshot recall) can re-assert
 * over a deserialized vector.
 */
export function assertWeightsSumTo100(
  profile: SelectorProfile,
  vector: WeightVector,
): void {
  const total = Object.values(vector).reduce<number>(
    (acc, value) => acc + (typeof value === "number" ? value : 0),
    0,
  );
  if (total !== 100) {
    throw new Error(
      `[selector/weights] ${profile} vector sums to ${total}, expected 100`,
    );
  }
}

/** Weight vectors keyed by profile. */
export const WEIGHT_VECTORS: {
  treasury: WeightVector<"treasury">;
  yield: WeightVector<"yield">;
  trading: WeightVector<"trading">;
} = {
  treasury: TREASURY_WEIGHTS,
  yield: YIELD_WEIGHTS,
  trading: TRADING_WEIGHTS,
};

// Load-time invariant.
for (const profile of SELECTOR_PROFILES) {
  assertWeightsSumTo100(profile, WEIGHT_VECTORS[profile]);
}

/**
 * Pro-rata redistribute the slots whose raw value is null across the
 * non-null slots in the same vector. Returns the new weights in the same
 * key order as `presentKeys`.
 */
export function redistributeWeights(
  vector: WeightVector,
  presentKeys: readonly WeightKey[],
): Map<WeightKey, number> {
  const present = new Map<WeightKey, number>();
  let totalPresent = 0;
  for (const key of presentKeys) {
    const weight = vector[key];
    if (typeof weight === "number") {
      present.set(key, weight);
      totalPresent += weight;
    }
  }

  if (totalPresent === 0) {
    return present; // caller treats this as degenerate
  }

  const redistributed = new Map<WeightKey, number>();
  for (const [key, weight] of present) {
    redistributed.set(key, (weight / totalPresent) * 100);
  }
  return redistributed;
}
