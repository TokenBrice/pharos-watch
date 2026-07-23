import type { V9EvidenceResponsibility } from "./safety-score-v9-fact-primitives";
import type { V9Grade } from "./safety-score-v9";

export const V9_PRODUCTION_ACCEPTANCE_THRESHOLDS = {
  minimumGenerationCount: 3,
  minimumObservationWindowSec: 48 * 60 * 60,
  maximumObservationWindowSec: 72 * 60 * 60,
  bMinusOrBetterMinimumBps: 1_800,
  cPlusThroughDMaximumBps: 7_000,
  dMaximumBps: 3_000,
  exactScoreBucketExclusiveMaximumBps: 1_000,
  notRatedMaximumBps: 1_500,
  exTopTwoBMinusOrBetterSupplyMinimumBps: 4_500,
  syntheticEvidenceFloorMaximumCount: 0,
  minimumSyntheticAPlusArchetypeCount: 3,
  maximumUnexplainedGradeDistance: 1,
  flagshipMovementAttributionThreshold: 5,
} as const;

export const V9_PRODUCTION_ACCEPTANCE_TOP_TWO_ASSET_IDS = [
  "usdc-circle",
  "usdt-tether",
] as const;

export const V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS = [
  "usdg-base-and-deployment-separated",
  "usdc-wrapper-local-risk-separated",
  "frxusd-wtgxx-role-reviewed",
  "named-family-causal-explanations",
  "tusd-watch-explained",
] as const;

export const V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS = [
  "pillar-improvement-monotonic",
  "unmitigated-dependency-monotonic",
  "active-depeg-noncompensable",
  "global-reserve-impairment-noncompensable",
  "global-mint-control-noncompensable",
  "critical-serial-dependency-noncompensable",
  "parent-wrapper-propagated-once",
] as const;

export type V9ProductionAcceptanceDecision = "gate-passed" | "no-go";

export type V9ProductionAcceptanceNoGoReason =
  | "adverse-control-gate-failed"
  | "distribution-gate-failed"
  | "generation-asset-set-mismatch"
  | "generation-count-below-three"
  | "generation-identity-mismatch"
  | "generation-incomplete"
  | "generation-internal-asset-set-mismatch"
  | "generation-internal-identity-mismatch"
  | "generation-sequence-invalid"
  | "generation-supply-invalid"
  | "monotonic-control-gate-failed"
  | "named-sentinel-gate-failed"
  | "producer-caused-downgrade"
  | "synthetic-a-plus-gate-failed"
  | "unexplained-flagship-movement"
  | "unexplained-grade-movement"
  | "v8-classification-gate-failed"
  | "validation-evidence-missing";

export type V9ProductionDistributionGateId =
  | "b-minus-or-better-share"
  | "c-plus-through-d-share"
  | "d-share"
  | "exact-score-bucket-share"
  | "not-rated-share"
  | "ex-top-two-b-minus-or-better-supply-share"
  | "supply-input-validity"
  | "synthetic-evidence-floor-count";

export type V9ProductionMovementCause =
  | "availability-only"
  | "economic-or-disclosure"
  | "mixed"
  | "none";

export type V9ProductionV8MovementClassification =
  | "intentional-strictness"
  | "corrected-optimism"
  | "producer-gap"
  | "methodology-capability"
  | "defect";

export interface V9ProductionAcceptanceCandidateIdentity {
  schemaVersion: 1;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
}

export interface V9ProductionAcceptanceCandidateResultBinding {
  candidateId: string;
  baseInputGenerationId: string;
  factSetDigest: string;
  resultDigest: string;
}

export interface V9ProductionDistributionGate {
  id: V9ProductionDistributionGateId;
  passed: boolean;
  actual: number;
  threshold: number;
  unit: "basis-points" | "count";
  comparator: "at-least" | "at-most" | "strictly-below" | "equals";
  numerator: number | null;
  denominator: number | null;
}

export interface V9ProductionScoreBucket {
  score: number;
  count: number;
  shareBps: number;
}

export interface V9ProductionDistributionReport {
  decision: V9ProductionAcceptanceDecision;
  activeCount: number;
  ratedCount: number;
  notRatedCount: number;
  gradeHistogram: Record<V9Grade, number>;
  bMinusOrBetter: { count: number; shareBps: number };
  cPlusThroughD: { count: number; shareBps: number };
  d: { count: number; shareBps: number };
  notRated: { count: number; shareBps: number };
  largestExactScoreBucket: V9ProductionScoreBucket | null;
  exactScoreBuckets: readonly V9ProductionScoreBucket[];
  syntheticEvidenceFloorIds: readonly string[];
  invalidSupplyAssetIds: readonly string[];
  exTopTwoSupply: {
    excludedAssetIds: readonly string[];
    totalUsd: number;
    bMinusOrBetterUsd: number;
    bMinusOrBetterShareBps: number;
  };
  gates: readonly V9ProductionDistributionGate[];
}

export interface V9ProductionGenerationReport {
  sourceGeneration: string;
  baseInputGenerationId: string;
  clockSec: number;
  candidateId: string;
  factSetDigest: string;
  resultDigest: string;
  candidateIdentity: V9ProductionAcceptanceCandidateIdentity;
  internalIdentityPassed: boolean;
  internalIdentityIssues: readonly string[];
  internalAssetSetPassed: boolean;
  internalAssetSetIssues: readonly string[];
  complete: boolean;
  completenessIssues: readonly string[];
  supplyValid: boolean;
  supplyIssues: readonly string[];
  assetIds: readonly string[];
  distribution: V9ProductionDistributionReport;
}

export interface V9ProductionGenerationMovement {
  assetId: string;
  fromSourceGeneration: string;
  toSourceGeneration: string;
  fromScore: number | null;
  toScore: number | null;
  scoreDelta: number | null;
  fromGrade: V9Grade;
  toGrade: V9Grade;
  gradeDistance: number | null;
  rateabilityChanged: boolean;
  flagship: boolean;
  scoreBearingInputChanged: boolean;
  changedScoreBearingFields: readonly string[];
  economicOrDisclosureCauseChanged: boolean;
  changedEconomicOrDisclosureFields: readonly string[];
  availabilityCauseChanged: boolean;
  changedAvailabilityFields: readonly string[];
  changedAvailabilityResponsibilities: readonly V9EvidenceResponsibility[];
  cause: V9ProductionMovementCause;
  fromScoreBearingInputDigest: string;
  toScoreBearingInputDigest: string;
  producerCausedDowngrade: boolean;
  unexplainedGradeMovement: boolean;
  unexplainedFlagshipMovement: boolean;
}

export interface V9ProductionStabilityReport {
  generationCountPassed: boolean;
  consecutiveCompleteGenerationCount: number;
  qualifyingSourceGenerations: readonly string[];
  observationWindowSec: number | null;
  identitiesMatch: boolean;
  assetSetsMatch: boolean;
  sequenceValid: boolean;
  movements: readonly V9ProductionGenerationMovement[];
  producerCausedDowngradeIds: readonly string[];
  unexplainedGradeMovementIds: readonly string[];
  unexplainedFlagshipMovementIds: readonly string[];
}

export interface V9ProductionQualitativeSentinelEvidence {
  id: (typeof V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS)[number];
  passed: boolean;
  detail: string;
  evidenceRefs: readonly string[];
}

export interface V9ProductionSyntheticAPlusEvidence {
  scenarioId: string;
  archetype: string;
  score: number | null;
  grade: V9Grade;
  resultDigest: string;
}

export interface V9ProductionMonotonicControlEvidence {
  id: (typeof V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS)[number];
  caseCount: number;
  failureCount: number;
  evidenceRefs: readonly string[];
}

export interface V9ProductionV8CardEvidence {
  id: string;
  grade: V9Grade;
}

export interface V9ProductionV8MovementClassificationEvidence {
  assetId: string;
  classification: V9ProductionV8MovementClassification;
  summary: string;
  evidenceRefs: readonly string[];
}

export interface V9ProductionSupplementalValidationEvidence {
  schemaVersion: 1;
  kind: "safety-score-v9-production-validation-evidence";
  candidateIdentity: V9ProductionAcceptanceCandidateIdentity;
  candidateResult: V9ProductionAcceptanceCandidateResultBinding;
  qualitativeSentinels: readonly V9ProductionQualitativeSentinelEvidence[];
  syntheticAPlusScenarios: readonly V9ProductionSyntheticAPlusEvidence[];
  monotonicControls: readonly V9ProductionMonotonicControlEvidence[];
  v8: {
    cards: readonly V9ProductionV8CardEvidence[];
    movementClassifications: readonly V9ProductionV8MovementClassificationEvidence[];
  };
}

export interface V9ProductionSentinelVerdict {
  ruleId: string;
  assetIds: readonly string[];
  passed: boolean;
  observed: string;
  required: string;
  detail: string;
}

export interface V9ProductionSyntheticAPlusReport {
  passed: boolean;
  scenarioCount: number;
  qualifyingScenarioIds: readonly string[];
  distinctQualifyingArchetypes: readonly string[];
  issues: readonly string[];
}

export interface V9ProductionMonotonicControlVerdict {
  id: (typeof V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS)[number];
  passed: boolean;
  caseCount: number;
  failureCount: number;
  evidenceRefs: readonly string[];
}

export interface V9ProductionV8MovementReport {
  assetId: string;
  v8Grade: V9Grade;
  v9Grade: V9Grade;
  gradeDistance: number | null;
  rateabilityChanged: boolean;
  classification: V9ProductionV8MovementClassification | null;
  blockingClassification: boolean;
  summary: string | null;
  evidenceRefs: readonly string[];
}

export interface V9ProductionV8ClassificationReport {
  passed: boolean;
  assetSetsMatch: boolean;
  requiredMovementCount: number;
  classifiedMovementCount: number;
  movements: readonly V9ProductionV8MovementReport[];
  issues: readonly string[];
}

export interface V9ProductionValidationEvidenceReport {
  provided: boolean;
  identityMatches: boolean;
  candidateResultMatches: boolean;
  namedSentinelsPassed: boolean;
  namedSentinels: readonly V9ProductionSentinelVerdict[];
  adverseControlsPassed: boolean;
  adverseControls: readonly V9ProductionSentinelVerdict[];
  syntheticAPlus: V9ProductionSyntheticAPlusReport;
  monotonicControlsPassed: boolean;
  monotonicControls: readonly V9ProductionMonotonicControlVerdict[];
  v8Classification: V9ProductionV8ClassificationReport;
  issues: readonly string[];
}

export interface V9ProductionAcceptanceReport {
  schemaVersion: 1;
  kind: "safety-score-v9-production-acceptance";
  decision: V9ProductionAcceptanceDecision;
  thresholds: typeof V9_PRODUCTION_ACCEPTANCE_THRESHOLDS;
  noGoReasons: readonly V9ProductionAcceptanceNoGoReason[];
  generations: readonly V9ProductionGenerationReport[];
  stability: V9ProductionStabilityReport;
  validationEvidence: V9ProductionValidationEvidenceReport;
}

export interface V9ProductionSourceReceipt {
  sourceCommit: string;
  branch: string;
  runtimeVersion: string;
  expectedRuntimeVersion: string;
  trackedWorktreeClean: boolean;
  validatedAtSec: number;
}

export interface V9ProductionGenerationVerificationReceipt {
  inputIndex: number;
  verified: boolean;
  exactCachePayloadDigest: string;
  replayPayloadDigest: string;
  extensionPayloadDigest: string | null;
  sourceGeneration: string | null;
  baseInputGenerationId: string | null;
  clockSec: number | null;
  sourceUpdatedAtSec: number | null;
  capturedAtSec: number | null;
  v8PublicationIdentity: {
    model: "v8";
    schemaVersion: 1;
    methodologyVersion: string;
    evaluationBuildDigest: string;
    baseInputGenerationId: string;
    publicationGenerationId: string;
  } | null;
  candidateId: string | null;
  factSetDigest: string | null;
  resultDigest: string | null;
  candidateIdentity: V9ProductionAcceptanceCandidateIdentity | null;
  activeAssetCount: number | null;
  supplyTotalUsd: number | null;
  issues: readonly string[];
}

export interface V9ProductionCaptureLedgerEntry {
  ordinal: number;
  captureId: string;
  status: "complete" | "failed";
  capturedAtSec: number;
  sourceGeneration: string | null;
  baseInputGenerationId: string | null;
  exactCachePayloadDigest: string | null;
  replayPayloadDigest: string | null;
  failureReason: string | null;
}

export interface V9ProductionCaptureLedger {
  schemaVersion: 1;
  kind: "safety-score-v9-production-capture-ledger";
  entries: readonly V9ProductionCaptureLedgerEntry[];
}

export interface V9ProductionCaptureLedgerReport {
  provided: boolean;
  parsed: boolean;
  continuityPassed: boolean;
  trailingCompleteCaptureIds: readonly string[];
  issues: readonly string[];
}

export interface V9ProductionHoldoutBindingReport {
  provided: boolean;
  suppliedReportProvided: boolean;
  scorerProofProvided: boolean;
  parsed: boolean;
  scorerProofParsed: boolean;
  statisticsRecomputed: boolean;
  scoresRecomputed: boolean;
  recomputedCaseCount: number;
  suppliedReportMatches: boolean;
  digestValid: boolean;
  decisionPassed: boolean;
  identityMatches: boolean;
  scorerIdentityMatches: boolean;
  releaseCandidateId: string | null;
  reportDigest: string | null;
  issues: readonly string[];
}

export type V9StrictProductionNoGoReason =
  | "acceptance-contract-failed"
  | "capture-recency-failed"
  | "capture-ledger-continuity-failed"
  | "capture-ledger-missing"
  | "d-to-nr-noncredit-unresolved"
  | "generation-verification-failed"
  | "holdout-gate-failed"
  | "holdout-identity-mismatch"
  | "holdout-missing"
  | "holdout-scores-unverified"
  | "source-commit-unbound"
  | "runtime-mismatch";

export interface V9StrictProductionAcceptanceReport {
  schemaVersion: 1;
  kind: "safety-score-v9-strict-production-acceptance";
  decision: V9ProductionAcceptanceDecision;
  noGoReasons: readonly V9StrictProductionNoGoReason[];
  source: V9ProductionSourceReceipt;
  generationVerifications: readonly V9ProductionGenerationVerificationReceipt[];
  captureLedger: V9ProductionCaptureLedgerReport;
  holdout: V9ProductionHoldoutBindingReport;
  dToNrNonCreditAssetIds: readonly string[];
  acceptance: V9ProductionAcceptanceReport | null;
}
