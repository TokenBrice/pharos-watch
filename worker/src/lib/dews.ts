/**
 * Depeg Early Warning Score (DEWS) — pure, stateless compute function.
 *
 * Estimates per-coin depeg probability using 8 sub-signals (0-100 each),
 * combined via weighted average with redistribution for missing signals.
 *
 * Pattern: same as stability-index.ts — no DB access, no side effects.
 *
 * Code is split into focused helpers under `./dews/`:
 *   - `dews/signal-families.ts` — per-signal scoring (supply, pool, liq, etc.)
 *   - `dews/evidence-policy.ts` — evidence-kind classification
 *   - `dews/compatibility.ts` — band-gate + piecewise-linear utilities
 *
 * This file owns the public types and the `computeDEWS` orchestrator that
 * combines those pieces into the byte-identical scoring result consumed by
 * /api/stress-signals, alerts, and DEWS persistence.
 */

import type { ThreatBand } from "@shared/lib/classification";
import { clamp } from "@shared/lib/math";
import { DEWS_SIGNAL_LABELS, DEWS_SIGNAL_WEIGHTS, type DewsSignalKey } from "@shared/lib/dews-config";
import { CONTAGION_AMPLIFIER_CAP } from "./constants";
import { getThreatBand, piecewiseLinear } from "./dews/compatibility";
import { classifyEvidenceKinds } from "./dews/evidence-policy";
import {
  computeBlacklistSignal,
  computeDivergSignal,
  computeFlowSignal,
  computeLiquiditySignal,
  computePoolSignal,
  computePriceSignal,
  computeSupplySignal,
  computeYieldSignal,
} from "./dews/signal-families";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ThreatBand };

// Re-exported for back-compat with existing imports (tests, downstream callers).
export { getThreatBand, piecewiseLinear };

export type {
  DEWSEvidenceKind,
  DewsInsufficientEvidenceReason,
  DewsTopContributor,
  PoolEntry,
  SignalResult,
  DEWSInput,
} from "./dews/types";

// Internal alias to keep the rest of this file compiling against the shared types.
import type {
  DEWSEvidenceKind,
  DewsInsufficientEvidenceReason,
  DewsTopContributor,
  SignalResult,
  DEWSInput,
} from "./dews/types";

export interface DEWSResult {
  score: number;
  band: ThreatBand;
  signals: Record<string, SignalResult>;
  amplifiers: { psi: number; contagion: number };
  baseScore: number;
  finalScore: number;
  availableWeight: number;
  effectiveWeights: Partial<Record<DewsSignalKey, number>>;
  evidenceKinds: DEWSEvidenceKind[];
  insufficientEvidenceReason: DewsInsufficientEvidenceReason | null;
  dataQualityScore: number;
  topContributors: DewsTopContributor[];
  sourceAges?: Record<string, number | null>;
  staleFlags?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_AVAILABLE_WEIGHT = 0.3;
const SEVERE_ISSUER_CONTROL_THRESHOLD = 55;
const WATCH_MAX_SCORE = 35;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function roundMetric(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Main compute
// ---------------------------------------------------------------------------

export function computeDEWS(input: DEWSInput): DEWSResult | null {
  const signals: Record<DewsSignalKey, SignalResult> = {
    supply: computeSupplySignal(input),
    pool: computePoolSignal(input),
    liq: computeLiquiditySignal(input),
    price: computePriceSignal(input),
    diverg: computeDivergSignal(input),
    black: computeBlacklistSignal(input),
    flow: computeFlowSignal(input),
    yield: computeYieldSignal(input),
  };

  // Weighted average with redistribution for missing signals
  let totalWeight = 0;
  let weightedSum = 0;
  const effectiveWeights: Partial<Record<DewsSignalKey, number>> = {};
  const weightedContributions: DewsTopContributor[] = [];

  for (const [key, signal] of Object.entries(signals) as Array<[DewsSignalKey, SignalResult]>) {
    if (signal.available) {
      totalWeight += DEWS_SIGNAL_WEIGHTS[key];
      weightedSum += DEWS_SIGNAL_WEIGHTS[key] * signal.value;
    }
  }

  // Require at least 2 available signals (weight >= 0.30) for a score
  if (totalWeight < MIN_AVAILABLE_WEIGHT) {
    return null;
  }

  // Systemic backdrop: amplify individual stress when market is under pressure.
  // PSI < 75 (below STEADY) = market stress.
  // At PSI 75: no amplification. At PSI 40: 15% amplification. At PSI 0: 30% amplification.
  const psiAmplifier =
    input.psiScore !== null && input.psiScore < 75 ? 1 + Math.max(0, (75 - input.psiScore) / 75) * 0.3 : 1;
  const contagionAmplifier = clamp(input.contagionAmplifier ?? 1, 1, CONTAGION_AMPLIFIER_CAP);
  const baseScore = weightedSum / totalWeight;
  for (const [key, signal] of Object.entries(signals) as Array<[DewsSignalKey, SignalResult]>) {
    if (!signal.available) continue;
    const effectiveWeight = DEWS_SIGNAL_WEIGHTS[key] / totalWeight;
    effectiveWeights[key] = effectiveWeight;
    weightedContributions.push({
      key,
      label: DEWS_SIGNAL_LABELS[key],
      value: roundMetric(signal.value),
      effectiveWeight: roundMetric(effectiveWeight, 4),
      contribution: roundMetric(effectiveWeight * signal.value),
    });
  }

  const evidenceKinds = classifyEvidenceKinds(signals, input, psiAmplifier);
  const hasMarketOrLiquidityEvidence =
    evidenceKinds.includes("market-price") || evidenceKinds.includes("dex-liquidity");
  const hasSevereIssuerControlEvidence =
    signals.black.available && signals.black.value >= SEVERE_ISSUER_CONTROL_THRESHOLD;
  const dataQualityScore = signals.price.available ? signals.price.value : 0;

  const amplifiedScore = baseScore * psiAmplifier * contagionAmplifier;
  const preliminaryScore = Math.round(clamp(amplifiedScore, 0, 100));
  let score = preliminaryScore;
  let insufficientEvidenceReason: DewsInsufficientEvidenceReason | null = null;
  if (preliminaryScore > WATCH_MAX_SCORE && !hasMarketOrLiquidityEvidence && !hasSevereIssuerControlEvidence) {
    score = WATCH_MAX_SCORE;
    const nonSystemicEvidenceKinds = evidenceKinds.filter((kind) => kind !== "systemic");
    insufficientEvidenceReason =
      dataQualityScore >= 50 && nonSystemicEvidenceKinds.length === 0
        ? "data_quality_only"
        : "missing_market_or_liquidity_evidence";
  }
  const band = getThreatBand(score);

  return {
    score,
    band,
    signals,
    amplifiers: { psi: psiAmplifier, contagion: contagionAmplifier },
    baseScore: roundMetric(baseScore),
    finalScore: score,
    availableWeight: roundMetric(totalWeight, 4),
    effectiveWeights,
    evidenceKinds,
    insufficientEvidenceReason,
    dataQualityScore: roundMetric(dataQualityScore),
    topContributors: weightedContributions
      .filter((contributor) => contributor.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3),
    ...(input.sourceAges ? { sourceAges: input.sourceAges } : {}),
    ...(input.staleFlags ? { staleFlags: input.staleFlags } : {}),
  };
}
