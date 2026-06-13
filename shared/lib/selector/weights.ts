/**
 * Profile weight vectors and the load-time `sum = 100` invariant.
 *
 * The vectors below are the maintained profile weights for the Picker. A buggy
 * edit must break at module import time, not at test time —
 * `assertWeightsSumTo100` runs for
 * each profile when this module loads.
 */
import {
  SELECTOR_PROFILES,
  type SelectorInput,
  type SelectorProfile,
  type WeightKey,
  type WeightVector,
} from "./types";
import { SELECTOR_VERSION } from "./version";

/**
 * Bumped on any weight or exclusion-rule change. Matches `ENGINE_VERSION`.
 */
export const WEIGHTS_VERSION = SELECTOR_VERSION;

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

function shiftWeight(
  vector: Partial<Record<WeightKey, number>>,
  to: WeightKey,
  amount: number,
  from: readonly WeightKey[],
): void {
  let remaining = amount;
  let moved = 0;
  for (const key of from) {
    if (remaining <= 0) break;
    const current = vector[key] ?? 0;
    if (current <= 0) continue;
    const take = Math.min(current, remaining);
    vector[key] = current - take;
    remaining -= take;
    moved += take;
  }
  if (moved > 0) {
    vector[to] = (vector[to] ?? 0) + moved;
  }
}

function venueIncludes(input: SelectorInput, value: string): boolean {
  return input.venuePreferences?.includes(value as never) ?? false;
}

function treasuryActiveDeFiIntent(input: SelectorInput): boolean {
  return (
    input.profile === "treasury" &&
    (input.composability === "high" || venueIncludes(input, "active"))
  );
}

/**
 * Apply deterministic answer-conditioned overlays to the base profile vector.
 * The base `WEIGHT_VECTORS` remain the published R2 tables; this helper is
 * what the engine uses for a concrete selector run.
 */
export function getWeightVectorForInput(input: SelectorInput): WeightVector {
  const vector: Partial<Record<WeightKey, number>> = {
    ...WEIGHT_VECTORS[input.profile],
  };

  if (input.depegTolerance === "zero") {
    if (input.profile === "treasury") {
      shiftWeight(vector, "pegStabilityHistory", 5, ["bluechip", "dewsInverted"]);
    } else if (input.profile === "yield") {
      shiftWeight(vector, "pegStabilityLive", 5, ["excessApy", "pharosYieldScore"]);
    } else {
      shiftWeight(vector, "pegScoreNow", 3, ["supplyLog"]);
      shiftWeight(vector, "pegStabilityLive", 2, ["liquidityDiversification"]);
    }
  }

  if (input.exitSpeed === "1h") {
    if (input.profile === "treasury") {
      shiftWeight(vector, "liquidity", 3, ["bluechip", "safetyOverall"]);
      shiftWeight(vector, "effectiveExit", 3, ["resilience", "dependencyRisk"]);
    } else if (input.profile === "yield") {
      shiftWeight(vector, "liquidity", 3, ["excessApy", "pharosYieldScore"]);
      shiftWeight(vector, "sourceRiskInverted", 2, ["pharosYieldScore"]);
    } else {
      shiftWeight(vector, "liquidity", 2, ["supplyLog"]);
      shiftWeight(vector, "effectiveExit", 2, ["safetyOverall"]);
    }
  }

  if (input.profile === "treasury" && input.horizon === "6mplus") {
    shiftWeight(vector, "dependencyRisk", 3, ["dewsInverted", "bluechip"]);
    shiftWeight(vector, "resilience", 2, ["pegStabilityHistory"]);
  }

  if (input.composability === "high") {
    if (input.profile === "yield") {
      shiftWeight(vector, "liquidity", 2, ["safetyOverall"]);
    } else if (input.profile === "trading") {
      shiftWeight(vector, "liquidityDiversification", 2, ["safetyOverall", "supplyLog"]);
    }
  }

  if (treasuryActiveDeFiIntent(input)) {
    shiftWeight(vector, "decentralization", 8, ["bluechip", "safetyOverall"]);
    shiftWeight(vector, "liquidity", 6, ["safetyOverall", "resilience"]);
    shiftWeight(vector, "effectiveExit", 6, ["dependencyRisk", "resilience"]);
  }

  if (input.profile === "yield") {
    if (venueIncludes(input, "dex")) {
      shiftWeight(vector, "liquidity", 3, ["excessApy"]);
    }
    if (venueIncludes(input, "wrap") || venueIncludes(input, "lend")) {
      shiftWeight(vector, "sourceRiskInverted", 2, ["excessApy"]);
    }
  }

  assertWeightsSumTo100(input.profile, vector);
  return vector as WeightVector;
}
