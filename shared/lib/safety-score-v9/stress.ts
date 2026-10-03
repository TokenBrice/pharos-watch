
/**
 * Per-asset stress state retained alongside an evaluated asset.
 *
 * Diagnostic only: nothing here feeds a score, a cap, or a published field. The
 * replay/calibration/curation CLIs read `exitPortfolio.circulatingUsd` from it
 * to supply-weight their reports.
 *
 * The published `stressStateDigest` and the what-if evaluator that consumed this
 * state (`evaluateV9StressState`, `V9SupportedStressShock`) were removed under
 * decision D11 — the digest had no reader and cost one canonicalize+sha256 per
 * asset per publication. Only the supply-weighting summary is retained; route
 * projections are transient evaluation inputs, not diagnostic state.
 */
export interface V9RetainedStressState {
  schemaVersion: 1;
  exitPortfolio: {
    circulatingUsd: number | null;
    portfolioStatus: "reviewed-complete" | "incomplete";
  } | null;
}

export function buildV9RetainedStressState(
  exitPortfolio: V9RetainedStressState["exitPortfolio"],
): V9RetainedStressState {
  return { schemaVersion: 1, exitPortfolio };
}
