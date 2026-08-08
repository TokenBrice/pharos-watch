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

/**
 * Weight vectors carry **one** Safety Score input — the published overall
 * (`safetyOverall`) — alongside published outputs of the other domains. The
 * V8-era vectors also carried V9's own pillars (`resilience` = backing,
 * `decentralization` = control, `effectiveExit` = exit) and a dependency-risk
 * scalar the Selector re-derived from V9's raw graph, so every one of those
 * signals was priced twice: once inside the composite and once beside it.
 * `selector-v2.0` folds their weight back into the composite that already
 * contains them. Exclusion floors and why-keys still *re-bin* individual
 * pillars — that is reading a published output, not adding it to a blend.
 *
 * The peg slots are the second de-duplication: `pegScoreNow` and
 * `pegStability*` both read the peg domain's `pegScore`, so a profile now
 * spends its peg budget on exactly one slot. The peg domain stays in the
 * vectors on purpose: the Picker exists to let a user weight a domain
 * differently from the house view, which is a preference, not a re-derivation.
 */

/** Treasury weights — sum = 100. */
const TREASURY_WEIGHTS: WeightVector<"treasury"> = {
  safetyOverall: 55,
  pegStabilityHistory: 22,
  dewsInverted: 13,
  bluechip: 10,
  supplyLog: 0,
} as const;

/** Yield weights — sum = 100. */
const YIELD_WEIGHTS: WeightVector<"yield"> = {
  pharosYieldScore: 28,
  safetyOverall: 19,
  yieldVariance: 16,
  sourceRiskInverted: 13,
  excessApy: 10,
  pegStabilityLive: 8,
  liquidity: 6,
} as const;

/** Active Trading weights — sum = 100. */
const TRADING_WEIGHTS: WeightVector<"trading"> = {
  liquidity: 30,
  pegScoreNow: 30,
  dewsInverted: 15,
  safetyOverall: 14,
  supplyLog: 8,
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
      // Trading spends its whole peg budget on `pegScoreNow` now that the
      // duplicate live-stability slot is gone.
      shiftWeight(vector, "pegScoreNow", 5, ["supplyLog", "liquidityDiversification"]);
    }
  }

  if (input.exitSpeed === "1h") {
    // A one-hour exit horizon over-weights the live exit read. That used to be
    // split between the DEX liquidity domain and the V9 Exit pillar; with the
    // pillar folded into the composite, the whole shift lands on liquidity.
    if (input.profile === "treasury") {
      shiftWeight(vector, "liquidity", 6, ["bluechip", "safetyOverall"]);
    } else if (input.profile === "yield") {
      shiftWeight(vector, "liquidity", 3, ["excessApy", "pharosYieldScore"]);
      shiftWeight(vector, "sourceRiskInverted", 2, ["pharosYieldScore"]);
    } else {
      shiftWeight(vector, "liquidity", 4, ["supplyLog", "safetyOverall"]);
    }
  }

  if (input.profile === "treasury" && input.horizon === "6mplus") {
    // A multi-quarter horizon prefers structural quality over live stress and
    // third-party alignment; the structural read is the composite itself.
    shiftWeight(vector, "safetyOverall", 5, ["dewsInverted", "bluechip", "pegStabilityHistory"]);
  }

  if (input.composability === "high") {
    if (input.profile === "yield") {
      shiftWeight(vector, "liquidity", 2, ["safetyOverall"]);
    } else if (input.profile === "trading") {
      shiftWeight(vector, "liquidityDiversification", 2, ["safetyOverall", "supplyLog"]);
    }
  }

  if (treasuryActiveDeFiIntent(input)) {
    // Deploying treasury into active DeFi trades the long-horizon house view
    // for live venue depth and live stress.
    shiftWeight(vector, "liquidity", 10, ["bluechip", "safetyOverall"]);
    shiftWeight(vector, "dewsInverted", 4, ["safetyOverall"]);
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
