/**
 * Report Card grade presentation and the shared survivors of the retired
 * Safety Score V8 engine.
 *
 * The V8 dimension scorers, penalty blends, and overall-grade aggregation were
 * deleted with the engine; Safety Score V9 owns scoring end to end. What
 * remains here is the grade scale used by every consumer surface, plus the two
 * non-scoring helpers (blacklist resolution and collateral-quality rollup) that
 * live producer paths still call.
 */

export {
  GRADE_THRESHOLDS, REPORT_CARD_GRADE_RANK, UNKNOWN_REPORT_CARD_GRADE_RANK,
  getReportCardGradeRank, REPORT_CARD_GRADE_COLORS, GRADE_RADAR_COLORS,
  scoreToGrade, gradeRange, type ReportCardGradeRange,
} from "./report-card-core";
export {
  computeCollateralQualityFromReserves,
  inferResilienceDefaults,
} from "./report-card-resilience";
export {
  createBlacklistResolutionContext,
  enrichLiveSlicesForBlacklist,
  getBlacklistStatusLabel,
  getReserveBlacklistabilityExposurePct,
  isBlacklistable,
  resolveBlacklistStatus,
  resolveBlacklistStatuses,
  type BlacklistStatus,
} from "./report-card-blacklist-matchers";
