/**
 * DEWS evidence policy.
 *
 * Classifies the signal grid into discrete evidence-kind tags
 * (market-price, dex-liquidity, flow, issuer-control, yield, systemic).
 * These tags gate the "insufficient evidence" cap that prevents DEWS from
 * graduating beyond WATCH on data-quality-only inputs.
 */

import type { DewsSignalKey } from "@shared/lib/dews-config";
import type { DEWSEvidenceKind, DEWSInput, SignalResult } from "./types";

export const EVIDENCE_STRESS_THRESHOLD = 10;

/**
 * Known sub-bps rounding window on non-USD pegs (accepted, not a defect).
 *
 * `value >= 10` sits exactly on the `[25, 10]` knot of the divergence curve, so
 * for the `diverg` signal it is equivalent to `worstBps >= 25`. On USD pegs the
 * whole-bps rounding upstream is one-directional — evidence can only be gained,
 * which is the conservative direction. Non-USD pegs take a x0.7 damper
 * (`signal-families.ts`), putting the effective threshold at ~32.143 bps, which
 * is not integer-aligned: for `worstBps` in (32.143, 32.5) the unrounded value
 * cleared 10 while the rounded 32 yields 9.94, so `market-price` evidence is
 * lost across a ~0.36 bps window.
 *
 * Left as-is deliberately. It gates an evidence *kind* — which releases the
 * `WATCH_MAX_SCORE` cap — rather than moving a score directly, and the fix
 * (carrying sub-bps precision through the signal grid) costs more determinism
 * than the window is worth. Every other threshold is safe: `piecewiseLinear` is
 * continuous and the composite margin is <=0.39 points on an integer score.
 */
export function hasStressEvidence(signal: SignalResult): boolean {
  return signal.available && signal.value >= EVIDENCE_STRESS_THRESHOLD;
}

export function classifyEvidenceKinds(
  signals: Record<DewsSignalKey, SignalResult>,
  input: DEWSInput,
  psiAmplifier: number,
): DEWSEvidenceKind[] {
  const kinds = new Set<DEWSEvidenceKind>();

  if (hasStressEvidence(signals.diverg) && input.price !== null && Number.isFinite(input.price)) {
    kinds.add("market-price");
  }

  if (hasStressEvidence(signals.pool) || hasStressEvidence(signals.liq)) {
    kinds.add("dex-liquidity");
  }

  if (hasStressEvidence(signals.flow)) {
    kinds.add("flow");
  }

  if (hasStressEvidence(signals.black)) {
    kinds.add("issuer-control");
  }

  if (hasStressEvidence(signals.yield)) {
    kinds.add("yield");
  }

  if (psiAmplifier > 1) {
    kinds.add("systemic");
  }

  return [...kinds];
}
