/**
 * Report Card grading engine.
 *
 * Public export surface only. Scoring families live in focused internal modules
 * so callers keep a single import path while hotspot pressure stays contained.
 */

export {
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  NO_LIQUIDITY_PENALTY,
  GRADE_THRESHOLDS, REPORT_CARD_GRADE_RANK, UNKNOWN_REPORT_CARD_GRADE_RANK,
  getReportCardGradeRank, REPORT_CARD_GRADE_COLORS, GRADE_RADAR_COLORS,
  scoreToGrade, gradeRange, type ReportCardGradeRange,
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
export {
  GOVERNANCE_QUALITY_SCORE,
  BRIDGE_ROUTE_RISK_BLEND_WEIGHT,
  BRIDGE_ROUTE_RISK_LABEL,
  BRIDGE_ROUTE_RISK_SCORE,
  ORACLE_RISK_BLEND_WEIGHT,
  ORACLE_RISK_LABEL,
  ORACLE_RISK_SCORE,
  isOracleRiskApplicable,
  resolveBridgeRouteRiskScore,
  resolveGovernanceQuality,
  resolveOracleRiskScore,
  scoreDecentralization,
  scoreDecentralizationBreakdown,
} from "./report-card-governance";
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
} from "./report-card-blacklist-matchers";
