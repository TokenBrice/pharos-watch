interface CalibrationAnalysisReport {
  gates: Record<string, boolean>;
  fridayEvidence: {
    composite: Record<string, unknown>;
    freshCaptures: Record<string, unknown>;
    causalAttribution: Record<string, unknown>;
  };
}

interface RealACandidateCheckResult {
  checks: Record<string, boolean>;
  evidenceFreshness: {
    referencedCount: number;
    missingIds: string[];
    noncurrentIds: string[];
    passed: boolean;
  };
  controls: {
    unresolvedReasonCodes: string[];
    unresolvedProfileGapCodes: string[];
    passed: boolean;
  };
  passed: boolean;
}

interface QualifyingCard {
  assetId: string;
  score: number;
  grade: string;
}

export function deriveCalibrationGradePolicy(formula: {
  gradeThresholds: readonly { grade: string; minScore: number }[];
  scoreDecimals: number;
}): {
  order: string[];
  boundaries: number[];
  ranges: Record<string, { minScore: number; maxScore: number }>;
};

export function computeCalibrationBaseInputGenerationId(input: unknown): string;
export function computeCalibrationFactSetDigest(compiledFacts: unknown): string;
export function computeCalibrationResultDigest(evaluatedSet: unknown): string;
export function computeCalibrationIdentityDigest(domain: string, identity: unknown): string;
export function computeCalibrationCandidateId(identity: unknown): string;
export function evaluateRealACandidateChecks(
  card: unknown,
  evaluated: unknown,
  facts: unknown,
): RealACandidateCheckResult;
export function captureMovements(captures: readonly unknown[]): Array<Record<string, unknown>>;
export function repeatedRealAAssetIds(
  candidateRealAIds: readonly string[],
  qualifyingByCapture: readonly (readonly string[])[],
): string[];
export function qualifyingCompositeCards(cards: readonly unknown[]): QualifyingCard[];
export function measuredAdverseFDrivers(card: unknown): Record<string, boolean>;

/**
 * The re-derived D1-D6 gate metrics. Members whose cohort can be empty or mix
 * in unknown supply are nullable and read as null - not zero - when their
 * input is unobserved, so their gates fail closed rather than passing
 * vacuously or with an incomplete numerator.
 */
export interface DistributionGateMetrics {
  materialEvidenceCoverageExTop2: number | null;
  supplyObservationCoverage: number | null;
  maxNrSupplyUsd: number | null;
  unattributedFCount: number;
  unattributedFSupplyShare: number | null;
  freeFloatingLargestBucketShare: number | null;
  freeFloatingLargestTupleShare: number | null;
  materialCohortCMinusOrBetterShare: number | null;
  materialCohortBMinusOrBetterCount: number;
  scoreIqr: number | null;
}
export function distributionGates(metrics: DistributionGateMetrics): Record<string, boolean>;

export interface DistributionSummary {
  expectedCount: number;
  ratedCount: number;
  nrIds: string[];
  ratedSupplyShare: number;
  totalSupply: number;
  cMinusOrBetter: number;
  bMinusOrBetter: number;
  largestPillarTuple: string | null;
  largestPillarTupleShare: number | null;
  largestScoreBucket: string | null;
  largestScoreBucketShare: number | null;
  distributionMetrics: DistributionGateMetrics;
  distributionDiagnostics: Record<string, unknown>;
}

export function summarizeDistribution(replay: unknown): DistributionSummary;
export function projectScoreBearingCalibrationInput(evaluatedAsset: unknown): Record<string, unknown>;
export function analyzeV9Calibration(
  baseline: unknown,
  candidate: unknown,
  fridayEvidence?: unknown,
): CalibrationAnalysisReport;
