import { z } from "zod";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";
import { V9FactSourceFingerprintsV2Schema } from "./safety-score-v9-facts";
import { V9ReasonCodeSchema } from "./safety-score-v9";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");
const UnixSecondsSchema = z.number().int().nonnegative();
const NonNegativeUsdSchema = z.number().finite().nonnegative();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalArrayBy<T>(schema: z.ZodType<T>, keyOf: (value: T) => string) {
  return z.array(schema).superRefine((values, ctx) => {
    const keys = values.map(keyOf);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate !== undefined) ctx.addIssue({ code: "custom", message: `Duplicate canonical key: ${duplicate}` });
    if (keys.some((key, index) => index > 0 && compareText(keys[index - 1]!, key) >= 0)) {
      ctx.addIssue({ code: "custom", message: "Values must be in canonical ascending order" });
    }
  });
}

const CanonicalStringArraySchema = canonicalArrayBy(CanonicalTextSchema, (value) => value);
const CanonicalReasonCodeArraySchema = canonicalArrayBy(V9ReasonCodeSchema, (value) => value);

/** Locked V9-9 release floors. A release decision cannot weaken these at runtime. */
export const V9_RELEASE_COVERAGE_FLOORS = {
  // Re-derived 2026-07-22 (owner ruling, reshape-v2 D6): the original 305 was
  // calibrated against the pre-withhold engine. New floor = stacked-CF rateable
  // count 281 minus a 10-asset drift buffer; NR-insufficient withholds never
  // count toward it. The number is published in the release notes and the
  // readiness doc; a rated-count regression below it still blocks release.
  minimumRateableAssets: 271,
  minimumRateableWeightBps: 9_900,
  topCutoffPosition: 25,
  minimumArchetypeRateableAssets: 3,
  minimumArchetypeRateableWeightBps: 8_000,
  calibrationCohortAssets: 24,
  calibrationRequiredRateableAssets: 21,
  calibrationIntentionalEvidenceGapAssets: 3,
  minimumDexContributingAssets: 45,
  minimumRedemptionContributingAssets: 27,
} as const;

export const V9CanonicalWeightDispositionSchema = z.enum(["current-valid", "missing", "invalid"]);
export type V9CanonicalWeightDisposition = z.infer<typeof V9CanonicalWeightDispositionSchema>;

export const V9ReleaseCohortWeightV1Schema = z
  .object({
    disposition: V9CanonicalWeightDispositionSchema,
    canonicalUsd: NonNegativeUsdSchema.nullable(),
    conservativeUpperBoundUsd: NonNegativeUsdSchema.nullable(),
    sourceGenerationId: CanonicalTextSchema.nullable(),
    observedAtSec: UnixSecondsSchema.nullable(),
    rank: z.number().int().positive().nullable(),
    topCutoffMember: z.boolean(),
  })
  .strict()
  .superRefine((weight, ctx) => {
    if (weight.disposition === "current-valid") {
      if (weight.canonicalUsd === null || weight.sourceGenerationId === null || weight.observedAtSec === null) {
        ctx.addIssue({ code: "custom", message: "Current valid weight requires value and exact source identity" });
      }
      if (weight.conservativeUpperBoundUsd !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["conservativeUpperBoundUsd"],
          message: "Valid weight has no fallback bound",
        });
      }
      if (weight.rank === null) {
        ctx.addIssue({ code: "custom", path: ["rank"], message: "Current valid weight requires a frozen rank" });
      }
    } else {
      if (weight.canonicalUsd !== null || weight.rank !== null || weight.topCutoffMember) {
        ctx.addIssue({
          code: "custom",
          message: "Missing or invalid weight cannot claim a value, rank, or top membership",
        });
      }
    }
  });
export type V9ReleaseCohortWeightV1 = z.infer<typeof V9ReleaseCohortWeightV1Schema>;

export const V9CalibrationCohortDispositionSchema = z.enum([
  "required-rateable",
  "intentional-evidence-gap",
  "not-member",
]);
export type V9CalibrationCohortDisposition = z.infer<typeof V9CalibrationCohortDispositionSchema>;

export const V9NrReviewV1Schema = z
  .object({
    state: z.enum(["not-required", "reviewed"]),
    reasonCodes: CanonicalReasonCodeArraySchema,
    disposition: z.enum(["owned", "cannot-currently-establish"]).nullable(),
    owner: CanonicalTextSchema.nullable(),
    reviewedAtSec: UnixSecondsSchema.nullable(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.state === "not-required") {
      if (
        review.reasonCodes.length > 0 ||
        review.disposition !== null ||
        review.owner !== null ||
        review.reviewedAtSec !== null
      ) {
        ctx.addIssue({ code: "custom", message: "Rateable disposition cannot carry an NR review" });
      }
      return;
    }
    if (review.reasonCodes.length === 0 || review.disposition === null || review.reviewedAtSec === null) {
      ctx.addIssue({ code: "custom", message: "Reviewed NR requires stable reasons, a disposition, and review time" });
    }
    if (review.disposition === "owned" && review.owner === null) {
      ctx.addIssue({ code: "custom", path: ["owner"], message: "Owned NR requires an owner" });
    }
    if (review.disposition === "cannot-currently-establish" && review.owner !== null) {
      ctx.addIssue({ code: "custom", path: ["owner"], message: "Explicit cannot-establish disposition has no owner" });
    }
  });
export type V9NrReviewV1 = z.infer<typeof V9NrReviewV1Schema>;

export const V9ReleaseCohortAssetV1Schema = z
  .object({
    assetId: CanonicalTextSchema,
    archetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
    weight: V9ReleaseCohortWeightV1Schema,
    calibrationDisposition: V9CalibrationCohortDispositionSchema,
    nrReview: V9NrReviewV1Schema,
  })
  .strict();
export type V9ReleaseCohortAssetV1 = z.infer<typeof V9ReleaseCohortAssetV1Schema>;

export const V9CoverageIdentityBindingV1Schema = z
  .object({
    factSetDigest: Sha256Schema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    policyId: CanonicalTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    evaluatedSetDigest: Sha256Schema,
    scoreResultDigest: Sha256Schema,
    evaluationProjectionDigest: Sha256Schema,
    registryPayloadDigest: Sha256Schema,
    weightPayloadDigest: Sha256Schema,
  })
  .strict();
export type V9CoverageIdentityBindingV1 = z.infer<typeof V9CoverageIdentityBindingV1Schema>;

export const V9ReleaseCohortManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    cohortId: CanonicalTextSchema,
    capturedAtSec: UnixSecondsSchema,
    bindings: V9CoverageIdentityBindingV1Schema,
    continuingActiveV8RateableCount: z.number().int().nonnegative(),
    assets: canonicalArrayBy(V9ReleaseCohortAssetV1Schema, (asset) => asset.assetId).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const [index, asset] of manifest.assets.entries()) {
      if (asset.nrReview.reviewedAtSec !== null && asset.nrReview.reviewedAtSec > manifest.capturedAtSec) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", index, "nrReview", "reviewedAtSec"],
          message: "NR review cannot be later than the V9 publication clock",
        });
      }
      if (asset.weight.observedAtSec !== null && asset.weight.observedAtSec > manifest.capturedAtSec) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", index, "weight", "observedAtSec"],
          message: "Weight observation cannot be later than the V9 publication clock",
        });
      }
    }
  });
export type V9ReleaseCohortManifestV1 = z.infer<typeof V9ReleaseCohortManifestV1Schema>;

const V9CoverageSourceGenerationsSchema = z
  .object({
    registry: CanonicalTextSchema,
    dex: CanonicalTextSchema,
    redemption: CanonicalTextSchema,
    liveReserves: CanonicalTextSchema,
    chainSupply: CanonicalTextSchema,
    peg: CanonicalTextSchema,
    researchOverlays: CanonicalTextSchema,
    shockCoverage: CanonicalTextSchema.optional(),
  })
  .strict();

export const V9CoverageEvaluationAssetV1Schema = z
  .object({
    assetId: CanonicalTextSchema,
    finalScore: z.number().finite().min(0).max(100).nullable(),
    nrReasonCodes: CanonicalReasonCodeArraySchema,
    primaryExitRouteKey: CanonicalTextSchema.nullable(),
    includedExitRouteKeys: CanonicalStringArraySchema,
  })
  .strict()
  .superRefine((asset, ctx) => {
    if ((asset.finalScore === null) !== asset.nrReasonCodes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["nrReasonCodes"],
        message: "NR assets require stable reasons while rateable assets cannot carry NR reasons",
      });
    }
    if (asset.primaryExitRouteKey !== null && !asset.includedExitRouteKeys.includes(asset.primaryExitRouteKey)) {
      ctx.addIssue({ code: "custom", path: ["primaryExitRouteKey"], message: "Primary route must be included" });
    }
  });
export type V9CoverageEvaluationAssetV1 = z.infer<typeof V9CoverageEvaluationAssetV1Schema>;

/** Identity-preserving release-gate projection of one V9 evaluated set. */
const V9CoverageEvaluationSnapshotV1Shape = {
  schemaVersion: z.literal(1),
  factSetDigest: Sha256Schema,
  baseInputGenerationId: BaseInputGenerationIdSchema,
  policyId: CanonicalTextSchema,
  policyDigest: Sha256Schema,
  evaluationBuildDigest: Sha256Schema,
  producerCapabilityDigest: Sha256Schema,
  evaluatedSetDigest: Sha256Schema,
  scoreResultDigest: Sha256Schema,
  asOfSec: UnixSecondsSchema,
  sourceGenerations: V9CoverageSourceGenerationsSchema,
  assets: canonicalArrayBy(V9CoverageEvaluationAssetV1Schema, (asset) => asset.assetId).min(1),
} as const;

/** Canonical score-bearing projection payload, excluding its self-authenticating digest. */
export const V9CoverageEvaluationProjectionPayloadV1Schema = z.object(V9CoverageEvaluationSnapshotV1Shape).strict();
export type V9CoverageEvaluationProjectionPayloadV1 = z.infer<typeof V9CoverageEvaluationProjectionPayloadV1Schema>;

export const V9CoverageEvaluationSnapshotV1Schema = z
  .object({
    ...V9CoverageEvaluationSnapshotV1Shape,
    evaluationProjectionDigest: Sha256Schema,
  })
  .strict();
export type V9CoverageEvaluationSnapshotV1 = z.infer<typeof V9CoverageEvaluationSnapshotV1Schema>;

export const V9_COVERAGE_BLOCKER_CODES = [
  "active-id-bijection-failed",
  "archetype-manifest-mismatch",
  "archetype-rateable-count-below-floor",
  "archetype-weight-rateability-below-80-percent",
  "as-of-mismatch",
  "base-input-generation-mismatch",
  "calibration-cohort-composition-mismatch",
  "calibration-cohort-size-mismatch",
  "calibration-required-asset-not-rateable",
  "canonical-weight-fact-mismatch",
  "canonical-weight-unbounded",
  "dex-v9-contributing-assets-below-45",
  "evaluated-set-digest-mismatch",
  "evaluation-projection-digest-mismatch",
  "evaluation-build-digest-mismatch",
  "evaluation-build-not-current",
  "fact-set-digest-mismatch",
  "manifest-rank-mismatch",
  "manifest-top-cutoff-membership-mismatch",
  "nr-reason-mismatch",
  "nr-review-missing",
  "policy-digest-mismatch",
  "policy-id-mismatch",
  "producer-capability-digest-mismatch",
  "rateable-asset-count-below-floor",
  "rateable-asset-has-nr-review",
  "redemption-v9-contributing-assets-below-27",
  "registry-digest-mismatch",
  "score-result-digest-mismatch",
  "source-generation-mismatch",
  "supply-weight-rateability-below-99-percent",
  "top-cutoff-asset-not-rateable",
  "top-cutoff-evidence-incomplete",
  "top-cutoff-indeterminate",
  "top-cutoff-weight-not-current-valid",
  "unresolved-archetype",
  "weight-digest-mismatch",
] as const;
export const V9CoverageBlockerCodeSchema = z.enum(V9_COVERAGE_BLOCKER_CODES);
export type V9CoverageBlockerCode = z.infer<typeof V9CoverageBlockerCodeSchema>;

export const V9CoverageBlockerV1Schema = z
  .object({
    code: V9CoverageBlockerCodeSchema,
    assetId: CanonicalTextSchema.nullable(),
    archetype: z.enum(MECHANISM_ARCHETYPE_VALUES).nullable(),
    message: CanonicalTextSchema,
  })
  .strict();
export type V9CoverageBlockerV1 = z.infer<typeof V9CoverageBlockerV1Schema>;

const V9CoverageIdsSchema = z
  .object({
    factOnly: CanonicalStringArraySchema,
    evaluationOnly: CanonicalStringArraySchema,
    manifestOnly: CanonicalStringArraySchema,
    missingFromEvaluation: CanonicalStringArraySchema,
    missingFromManifest: CanonicalStringArraySchema,
  })
  .strict();

const V9CoverageRouteLaneSchema = z
  .object({
    lane: z.enum(["dex", "redemption"]),
    routeCount: z.number().int().nonnegative(),
    scoreEligibleRouteCount: z.number().int().nonnegative(),
    exactCoverageRouteCount: z.number().int().nonnegative(),
    currentRouteCount: z.number().int().nonnegative(),
    capabilityCompleteRouteCount: z.number().int().nonnegative(),
    outputResolvedRouteCount: z.number().int().nonnegative(),
    valuationCurrentRouteCount: z.number().int().nonnegative(),
    v9ContributingRouteCount: z.number().int().nonnegative(),
    v9ContributingAssetIds: CanonicalStringArraySchema,
    minimumContributingAssets: z.number().int().nonnegative(),
    floorPassed: z.boolean(),
  })
  .strict();

const V9CoverageRouteAssetLaneSchema = z
  .object({
    assetId: CanonicalTextSchema,
    lane: z.enum(["dex", "redemption"]),
    routeKeys: CanonicalStringArraySchema,
    scoreEligibleRouteKeys: CanonicalStringArraySchema,
    currentRouteKeys: CanonicalStringArraySchema,
    capabilityCompleteRouteKeys: CanonicalStringArraySchema,
    outputResolvedRouteKeys: CanonicalStringArraySchema,
    valuationCurrentRouteKeys: CanonicalStringArraySchema,
    v9ContributingRouteKeys: CanonicalStringArraySchema,
  })
  .strict();

const V9ReserveAssetCoverageSchema = z
  .object({
    assetId: CanonicalTextSchema,
    exposureCount: z.number().int().nonnegative(),
    sourceNativeExposureCount: z.number().int().nonnegative(),
    curatedExposureCount: z.number().int().nonnegative(),
    curatedFallbackExposureCount: z.number().int().nonnegative(),
    structuredExposureCount: z.number().int().nonnegative(),
    unstructuredExposureCount: z.number().int().nonnegative(),
    totalExposureWeight: z.number().finite().nonnegative(),
    sourceNativeExposureWeight: z.number().finite().nonnegative(),
    structuredExposureWeight: z.number().finite().nonnegative(),
  })
  .strict();

const V9ReviewDomainCoverageSchema = z
  .object({
    domain: z.enum(["backing", "control", "access", "peg", "supply", "implementation"]),
    activeCount: z.number().int().nonnegative(),
    applicabilityReviewedCount: z.number().int().nonnegative(),
    currentCompleteCount: z.number().int().nonnegative(),
    currentCompleteBps: z.number().int().min(0).max(10_000),
    incompleteAssetIds: CanonicalStringArraySchema,
    unresolvedApplicabilityAssetIds: CanonicalStringArraySchema,
  })
  .strict();

const V9ArchetypeCoverageSchema = z
  .object({
    archetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
    activeCount: z.number().int().nonnegative(),
    rateableCount: z.number().int().nonnegative(),
    requiredRateableCount: z.number().int().nonnegative(),
    countFloorPassed: z.boolean(),
    boundedWeightUsd: NonNegativeUsdSchema,
    rateableWeightUsd: NonNegativeUsdSchema,
    unboundedWeightAssetIds: CanonicalStringArraySchema,
    rateableWeightBps: z.number().int().min(0).max(10_000).nullable(),
    weightFloorPassed: z.boolean(),
    passed: z.boolean(),
  })
  .strict();

/** Machine-readable result of the strict V9-9 release-cohort gate. */
export const V9ReleaseCoverageReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    cohortId: CanonicalTextSchema,
    decision: z.enum(["gate-passed", "no-go"]),
    identities: z
      .object({
        factSetDigest: Sha256Schema,
        baseInputGenerationId: BaseInputGenerationIdSchema,
        policyId: CanonicalTextSchema,
        policyDigest: Sha256Schema,
        evaluationBuildDigest: Sha256Schema,
        producerCapabilityDigest: Sha256Schema,
        evaluatedSetDigest: Sha256Schema,
        scoreResultDigest: Sha256Schema,
        evaluationProjectionDigest: Sha256Schema,
        asOfSec: UnixSecondsSchema,
        sourceFingerprints: V9FactSourceFingerprintsV2Schema,
      })
      .strict(),
    identityChecks: z.record(z.string(), z.boolean()),
    floors: z
      .object({
        minimumRateableAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumRateableAssets),
        minimumRateableWeightBps: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumRateableWeightBps),
        topCutoffPosition: z.literal(V9_RELEASE_COVERAGE_FLOORS.topCutoffPosition),
        minimumArchetypeRateableAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumArchetypeRateableAssets),
        minimumArchetypeRateableWeightBps: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumArchetypeRateableWeightBps),
        calibrationCohortAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.calibrationCohortAssets),
        calibrationRequiredRateableAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.calibrationRequiredRateableAssets),
        calibrationIntentionalEvidenceGapAssets: z.literal(
          V9_RELEASE_COVERAGE_FLOORS.calibrationIntentionalEvidenceGapAssets,
        ),
        minimumDexContributingAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumDexContributingAssets),
        minimumRedemptionContributingAssets: z.literal(V9_RELEASE_COVERAGE_FLOORS.minimumRedemptionContributingAssets),
      })
      .strict(),
    activeSet: z
      .object({
        factCount: z.number().int().nonnegative(),
        evaluationCount: z.number().int().nonnegative(),
        manifestCount: z.number().int().nonnegative(),
        exactBijection: z.boolean(),
        differences: V9CoverageIdsSchema,
      })
      .strict(),
    rateability: z
      .object({
        activeCount: z.number().int().nonnegative(),
        rateableCount: z.number().int().nonnegative(),
        notRatedCount: z.number().int().nonnegative(),
        continuingActiveV8RateableCount: z.number().int().nonnegative(),
        requiredRateableCount: z.number().int().nonnegative(),
        passed: z.boolean(),
      })
      .strict(),
    weights: z
      .object({
        currentValidAssetIds: CanonicalStringArraySchema,
        missingAssetIds: CanonicalStringArraySchema,
        invalidAssetIds: CanonicalStringArraySchema,
        unboundedAssetIds: CanonicalStringArraySchema,
        boundedCanonicalWeightUsd: NonNegativeUsdSchema,
        rateableCanonicalWeightUsd: NonNegativeUsdSchema,
        rateableWeightBps: z.number().int().min(0).max(10_000).nullable(),
        passed: z.boolean(),
      })
      .strict(),
    topCutoff: z
      .object({
        position: z.literal(V9_RELEASE_COVERAGE_FLOORS.topCutoffPosition),
        cutoffUsd: NonNegativeUsdSchema.nullable(),
        determinate: z.boolean(),
        derivedMemberIds: CanonicalStringArraySchema,
        manifestMemberIds: CanonicalStringArraySchema,
        currentValidMemberIds: CanonicalStringArraySchema,
        rateableMemberIds: CanonicalStringArraySchema,
        evidenceCompleteMemberIds: CanonicalStringArraySchema,
        ranksConsistent: z.boolean(),
        membershipConsistent: z.boolean(),
        passed: z.boolean(),
      })
      .strict(),
    calibration: z
      .object({
        memberIds: CanonicalStringArraySchema,
        requiredRateableIds: CanonicalStringArraySchema,
        intentionalEvidenceGapIds: CanonicalStringArraySchema,
        ratedRequiredIds: CanonicalStringArraySchema,
        passed: z.boolean(),
      })
      .strict(),
    nrReviews: z
      .object({
        notRatedAssetIds: CanonicalStringArraySchema,
        reviewedAssetIds: CanonicalStringArraySchema,
        missingReviewAssetIds: CanonicalStringArraySchema,
        reasonMismatchAssetIds: CanonicalStringArraySchema,
        passed: z.boolean(),
      })
      .strict(),
    reserves: z
      .object({
        exposureCount: z.number().int().nonnegative(),
        sourceNativeExposureCount: z.number().int().nonnegative(),
        curatedExposureCount: z.number().int().nonnegative(),
        curatedFallbackExposureCount: z.number().int().nonnegative(),
        structuredExposureCount: z.number().int().nonnegative(),
        unstructuredExposureCount: z.number().int().nonnegative(),
        totalExposureWeight: z.number().finite().nonnegative(),
        sourceNativeExposureWeight: z.number().finite().nonnegative(),
        structuredExposureWeight: z.number().finite().nonnegative(),
        assets: canonicalArrayBy(V9ReserveAssetCoverageSchema, (asset) => asset.assetId),
      })
      .strict(),
    exit: z
      .object({
        lanes: z.tuple([V9CoverageRouteLaneSchema, V9CoverageRouteLaneSchema]),
        assets: canonicalArrayBy(V9CoverageRouteAssetLaneSchema, (entry) => `${entry.assetId}:${entry.lane}`),
        passed: z.boolean(),
      })
      .strict(),
    reviews: z.tuple([
      V9ReviewDomainCoverageSchema,
      V9ReviewDomainCoverageSchema,
      V9ReviewDomainCoverageSchema,
      V9ReviewDomainCoverageSchema,
      V9ReviewDomainCoverageSchema,
      V9ReviewDomainCoverageSchema,
    ]),
    archetypes: canonicalArrayBy(V9ArchetypeCoverageSchema, (entry) => entry.archetype),
    producerCapabilityDigest: Sha256Schema,
    blockers: z.array(V9CoverageBlockerV1Schema),
    reportDigest: Sha256Schema,
  })
  .strict();
export type V9ReleaseCoverageReportV1 = z.infer<typeof V9ReleaseCoverageReportV1Schema>;
