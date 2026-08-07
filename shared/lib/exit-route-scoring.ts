/**
 * Single definition of the exit route-scoring engine.
 *
 * Two published views ask the same question of the same route evidence and used
 * to answer it with two independently-maintained copies of one set of tables:
 *
 * - the **redemption backstop domain score** (`redemption-backstop-scoring.ts`),
 *   which measures a route against a *supply-denominator* request, and
 * - the **Safety Score V9 Exit pillar** (`safety-score-v9/exit.ts`), which
 *   measures the same route against a *stress* request snapped to the policy
 *   notional grid.
 *
 * The constant tables below are now the single definition. The V9 methodology
 * policy JSON (`semantic.exit`) remains the versioned, replay-pinned artifact
 * the evaluator reads — it is not generated at runtime, but it is CI-validated
 * against this module by `exit-policy-constants-pin.test.ts`, so the two can no
 * longer drift silently.
 *
 * Both views compose the same primitives here (breakpoint interpolation, band
 * resolution, the capacity blend, the weighted component sum). What stays with
 * each caller is what is genuinely its own: the redemption view's
 * capacity-level constraint application and its route-family caps; V9's
 * materiality floor and 50-cap, evidence/fee ceilings, danger interlock, and
 * redundancy credit.
 *
 * Runtime-neutral: no worker, Next.js, or D1 imports.
 */

export type ExitAccessModel = "permissionless-onchain" | "whitelisted-onchain" | "issuer-api" | "manual";
export type ExitSettlementModel = "atomic" | "immediate" | "same-day" | "days" | "queued";
export type ExitExecutionModel = "deterministic-onchain" | "deterministic-basket" | "rules-based-nav" | "opaque";
export type ExitOutputAssetType =
  | "stable-single"
  | "stable-basket"
  | "bluechip-collateral"
  | "mixed-collateral"
  | "nav";
export type ExitHolderEligibility =
  | "any-holder"
  | "verified-customer"
  | "whitelisted-primary"
  | "pre-incident-holder"
  | "issuer-discretionary"
  | "unknown";
export type ExitModeledConfidence = "high" | "medium" | "low";
export type ExitObservationConfidence = "high" | "medium" | "low" | "unknown";

export interface ExitBreakpoint {
  value: number;
  score: number;
}

/** A delay band matched by upper bound; `maxSec: null` is the unbounded tail. */
export interface ExitDelayBand {
  maxSec: number | null;
  multiplier: number;
}

/** A penalty band matched by descending threshold. */
export interface ExitThresholdBand {
  threshold: number;
  multiplier: number;
}

export interface ExitComponentWeights {
  access: number;
  settlement: number;
  executionCertainty: number;
  capacity: number;
  outputAssetQuality: number;
  cost: number;
}

export interface ExitComponentScores {
  access: number;
  settlement: number;
  executionCertainty: number;
  capacity: number;
  outputAssetQuality: number;
  cost: number;
}

/**
 * The reviewed exit scoring tables. Every value here is mirrored into
 * `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`
 * (`semantic.exit`) and pinned by test; change one and the pin fails until the
 * policy JSON is reissued with a methodology version bump.
 *
 * Route-family score ceilings:
 * - `queueRedeem` (70): queued redemption inherently involves multi-hour or
 *   multi-day settlement friction plus FIFO processing, so even a perfect
 *   component mix stays below a permissionless atomic rail.
 * - `offchainIssuer` (65): offchain institutional redemption is gated by KYC,
 *   primary-market access, and banking-hour settlement; the ceiling reflects the
 *   residual par-exit guarantee a CeFi-issued coin carries for retail holders
 *   without a live instant buffer.
 *
 * See the redemption backstop methodology v3.7 changelog entry.
 */
export const EXIT_ROUTE_SCORING_TABLES = {
  request: {
    notionalGridUsd: [100_000, 1_000_000, 10_000_000, 25_000_000],
    referenceNotionalUsd: 1_000_000,
    supplyRatio: 0.05,
    floorUsd: 100_000,
    capUsd: 25_000_000,
    maxCostBps: 200,
    settlementHorizonSec: 300,
  },
  componentWeights: {
    access: 0.2,
    settlement: 0.15,
    executionCertainty: 0.15,
    capacity: 0.25,
    outputAssetQuality: 0.15,
    cost: 0.1,
  },
  accessScores: {
    "permissionless-onchain": 100,
    "whitelisted-onchain": 75,
    "issuer-api": 40,
    manual: 20,
  },
  settlementScores: {
    atomic: 100,
    immediate: 90,
    "same-day": 65,
    days: 35,
    queued: 20,
  },
  executionScores: {
    "deterministic-onchain": 100,
    "deterministic-basket": 80,
    "rules-based-nav": 60,
    opaque: 30,
  },
  outputAssetScores: {
    "stable-single": 100,
    "stable-basket": 80,
    "bluechip-collateral": 65,
    "mixed-collateral": 45,
    nav: 20,
  },
  routeFamilyCaps: {
    queueRedeem: 70,
    offchainIssuer: 65,
  },
  coverageRatioBreakpoints: [
    { value: 0, score: 0 },
    { value: 0.01, score: 20 },
    { value: 0.05, score: 40 },
    { value: 0.1, score: 60 },
    { value: 0.25, score: 80 },
    { value: 0.5, score: 100 },
  ],
  absoluteCapacityBreakpoints: [
    { value: 0, score: 0 },
    { value: 100_000, score: 20 },
    { value: 1_000_000, score: 40 },
    { value: 10_000_000, score: 60 },
    { value: 50_000_000, score: 80 },
    { value: 250_000_000, score: 100 },
  ],
  settlementDelayBands: [
    { maxSec: 3_600, multiplier: 1 },
    { maxSec: 86_400, multiplier: 0.9 },
    { maxSec: 604_800, multiplier: 0.75 },
    { maxSec: null, multiplier: 0.6 },
  ],
  queueBacklogBands: [
    { threshold: 1, multiplier: 0.65 },
    { threshold: 0.5, multiplier: 0.8 },
    { threshold: 0, multiplier: 0.9 },
  ],
  minimumRedeemBands: [
    { threshold: 1_000_000, multiplier: 0.75 },
    { threshold: 10_000, multiplier: 0.9 },
  ],
  holderEligibilityMultipliers: {
    "any-holder": 1,
    "verified-customer": 0.9,
    "whitelisted-primary": 0.85,
    "pre-incident-holder": 0.85,
    "issuer-discretionary": 0.6,
    // Unknown live holder eligibility stays only mildly capacity-penalized here;
    // model-confidence cohort breadth separately treats unknown as weak evidence.
    unknown: 0.85,
  },
  modeledConfidenceFactors: {
    high: 1,
    medium: 0.75,
    low: 0.35,
  },
  observationConfidenceFactors: {
    high: 1,
    medium: 0.85,
    low: 0.6,
    unknown: 0.35,
  },
  scoreableEvidenceKinds: {
    dex: ["measured-executable-depth", "reserve-based-amm-simulation", "direct-orderbook-depth"],
    redemption: ["documented-terms", "live-reserve-state", "onchain-contract-state"],
  },
  documentedTermsMaxAgeSec: 365 * 86_400,
} as const satisfies {
  request: {
    notionalGridUsd: readonly number[];
    referenceNotionalUsd: number;
    supplyRatio: number;
    floorUsd: number;
    capUsd: number;
    maxCostBps: number;
    settlementHorizonSec: number;
  };
  componentWeights: ExitComponentWeights;
  accessScores: Record<ExitAccessModel, number>;
  settlementScores: Record<ExitSettlementModel, number>;
  executionScores: Record<ExitExecutionModel, number>;
  outputAssetScores: Record<ExitOutputAssetType, number>;
  routeFamilyCaps: { queueRedeem: number; offchainIssuer: number };
  coverageRatioBreakpoints: readonly ExitBreakpoint[];
  absoluteCapacityBreakpoints: readonly ExitBreakpoint[];
  settlementDelayBands: readonly ExitDelayBand[];
  queueBacklogBands: readonly ExitThresholdBand[];
  minimumRedeemBands: readonly ExitThresholdBand[];
  holderEligibilityMultipliers: Record<ExitHolderEligibility, number>;
  modeledConfidenceFactors: Record<ExitModeledConfidence, number>;
  observationConfidenceFactors: Record<ExitObservationConfidence, number>;
  scoreableEvidenceKinds: { dex: readonly string[]; redemption: readonly string[] };
  documentedTermsMaxAgeSec: number;
};

/** Share of the capacity component carried by completion coverage rather than absolute size. */
export const EXIT_COVERAGE_SHARE_OF_CAPACITY = 0.6;

/**
 * The two exit requests the one engine answers.
 *
 * - `supply-denominator` — the redemption domain score's modeled exit size:
 *   the clamped share of circulating supply, used directly as the denominator.
 * - `stress-grid` — the V9 Exit pillar's stress request: the same clamped share,
 *   then snapped up to the reviewed notional grid so route capacity curves stay
 *   comparable across assets.
 */
export type ExitRequestKind = "supply-denominator" | "stress-grid";

export interface ExitScoringRequest {
  kind: ExitRequestKind;
  /** The notional the route must clear. */
  requestedNotionalUsd: number;
  maxCostBps: number;
  settlementHorizonSec: number;
  /** The pre-grid clamped supply share, retained for attribution. */
  rawSupplyRequestUsd: number;
}

export interface ExitRequestPolicy {
  notionalGridUsd: readonly number[];
  supplyRatio: number;
  floorUsd: number;
  capUsd: number;
  maxCostBps: number;
  settlementHorizonSec: number;
}

/** The clamped share of circulating supply both requests are derived from. */
export function resolveExitRequestSupplyNotionalUsd(
  circulatingUsd: number | null | undefined,
  policy: Pick<ExitRequestPolicy, "supplyRatio" | "floorUsd" | "capUsd">,
): number | null {
  if (circulatingUsd == null || !Number.isFinite(circulatingUsd) || circulatingUsd <= 0) return null;
  return Math.min(policy.capUsd, Math.max(policy.floorUsd, circulatingUsd * policy.supplyRatio));
}

export function resolveExitScoringRequest(
  kind: ExitRequestKind,
  circulatingUsd: number | null | undefined,
  policy: ExitRequestPolicy,
): ExitScoringRequest | null {
  const rawSupplyRequestUsd = resolveExitRequestSupplyNotionalUsd(circulatingUsd, policy);
  if (rawSupplyRequestUsd === null) return null;
  const grid = [...policy.notionalGridUsd].sort((left, right) => left - right);
  const requestedNotionalUsd =
    kind === "stress-grid"
      ? (grid.find((notional) => notional >= rawSupplyRequestUsd) ?? grid[grid.length - 1]!)
      : rawSupplyRequestUsd;
  return {
    kind,
    requestedNotionalUsd,
    maxCostBps: policy.maxCostBps,
    settlementHorizonSec: policy.settlementHorizonSec,
    rawSupplyRequestUsd,
  };
}

/**
 * Linear interpolation across a monotonically increasing breakpoint ladder,
 * clamped at both ends. Unrounded: the V9 pillar carries the fractional score
 * into its component ladder, and the redemption view rounds at its own boundary.
 */
export function interpolateExitBreakpointScore(value: number, breakpoints: readonly ExitBreakpoint[]): number {
  const first = breakpoints[0]!;
  if (value <= first.value) return first.score;
  const top = breakpoints[breakpoints.length - 1]!;
  if (value >= top.value) return top.score;
  for (let index = 1; index < breakpoints.length; index += 1) {
    const lower = breakpoints[index - 1]!;
    const upper = breakpoints[index]!;
    if (value > upper.value) continue;
    const span = upper.value - lower.value;
    if (span <= 0) return upper.score;
    const progress = (value - lower.value) / span;
    return lower.score + (upper.score - lower.score) * progress;
  }
  return top.score;
}

/**
 * Resolve a delay band by upper bound. Returns `null` when no band matches, so
 * each view keeps its own documented fall-through (the redemption view treats a
 * non-finite delay as unpenalized; the V9 pillar rejects it upstream).
 */
export function resolveExitDelayBandMultiplier(delaySec: number, bands: readonly ExitDelayBand[]): number | null {
  if (!Number.isFinite(delaySec)) return null;
  return bands.find((band) => band.maxSec === null || delaySec <= band.maxSec)?.multiplier ?? null;
}

/**
 * Resolve a penalty band by descending threshold. `comparison` is load-bearing:
 * the queue-backlog ladder matches at-or-above its threshold, while the
 * minimum-redeem ladder has always matched strictly above it — a route whose
 * minimum sits exactly on a threshold takes the gentler band.
 */
export function resolveExitThresholdBandMultiplier(
  value: number,
  bands: readonly ExitThresholdBand[],
  comparison: "at-or-above" | "above" = "at-or-above",
): number | null {
  const match = bands.find((band) => (comparison === "above" ? value > band.threshold : value >= band.threshold));
  return match?.multiplier ?? null;
}

/** Blend coverage completion and absolute size into the capacity component. */
export function blendExitCapacityComponent(coverageScore: number, absoluteScore: number): number {
  return (
    coverageScore * EXIT_COVERAGE_SHARE_OF_CAPACITY + absoluteScore * (1 - EXIT_COVERAGE_SHARE_OF_CAPACITY)
  );
}

/** The weighted component ladder shared by both exit views. */
export function composeExitComponentScore(
  components: ExitComponentScores,
  weights: ExitComponentWeights,
): number {
  return (
    components.access * weights.access +
    components.settlement * weights.settlement +
    components.executionCertainty * weights.executionCertainty +
    components.capacity * weights.capacity +
    components.outputAssetQuality * weights.outputAssetQuality +
    components.cost * weights.cost
  );
}
