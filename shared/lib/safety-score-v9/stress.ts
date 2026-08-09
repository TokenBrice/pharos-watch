import type { V9ExitEvaluationRoute } from "./exit";
import type { V9ProductionScoreInput } from "./score";

/**
 * Per-asset scoring state retained alongside an evaluated asset.
 *
 * Diagnostic only: nothing here feeds a score, a cap, or a published field. The
 * replay/calibration/curation CLIs read `exitPortfolio.circulatingUsd` from it
 * to supply-weight their reports.
 *
 * The published `stressStateDigest` and the what-if evaluator that consumed this
 * state (`evaluateV9StressState`, `V9SupportedStressShock`) were removed under
 * decision D11 — the digest had no reader and cost one canonicalize+sha256 per
 * asset per publication. Without a digest there is nothing to keep canonical
 * here either, so the payload is assembled as-is.
 */
export interface V9RetainedStressState {
  schemaVersion: 1;
  scoreInput: V9ProductionScoreInput;
  exitPortfolio: {
    circulatingUsd: number | null;
    portfolioStatus: "reviewed-complete" | "incomplete";
    routes: readonly V9ExitEvaluationRoute[];
  } | null;
}

export function buildV9RetainedStressState(
  scoreInput: V9ProductionScoreInput,
  exitPortfolio: V9RetainedStressState["exitPortfolio"],
): V9RetainedStressState {
  return { schemaVersion: 1, scoreInput, exitPortfolio };
}
