/**
 * Report Card grading engine.
 *
 * Public export surface only. Scoring families live in focused internal modules
 * so callers keep a single import path while hotspot pressure stays contained.
 */

export {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  NO_LIQUIDITY_PENALTY,
  DIMENSION_LABELS,
  DIMENSION_SHORT_LABELS,
  GRADE_THRESHOLDS,
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_ORDER,
  GRADE_RADAR_COLORS,
  scoreToGrade,
  gradeRange,
} from "./report-card-core";
export { scorePegStability, scoreLiquidity } from "./report-card-peg-liquidity";
export {
  computeCollateralQualityFromReserves,
  chainInfraScore,
  chainInfraLabel,
  inferResilienceDefaults,
  resolveResilienceFactors,
  scoreResilience,
} from "./report-card-resilience";
export { GOVERNANCE_QUALITY_SCORE, resolveGovernanceQuality, scoreDecentralization } from "./report-card-governance";
export { scoreDependencyRisk } from "./report-card-dependency";
export { applyVariantOverallCap, computeOverallGrade, computeStressedGrades } from "./report-card-overall";
export {
  createBlacklistResolutionContext,
  enrichLiveSlicesForBlacklist,
  getBlacklistStatusLabel,
  isBlacklistable,
  resolveBlacklistStatus,
  resolveBlacklistStatuses,
  type BlacklistStatus,
} from "./report-card-blacklist-risk";
