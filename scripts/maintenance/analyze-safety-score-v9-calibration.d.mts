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
export function projectScoreBearingCalibrationInput(evaluatedAsset: unknown): Record<string, unknown>;
export function analyzeV9Calibration(
  baseline: unknown,
  candidate: unknown,
  fridayEvidence?: unknown,
): CalibrationAnalysisReport;
