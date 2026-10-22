import { z } from "zod";
import { ReserveBoundedFactSchema } from "@shared/types/reserve-bounded-facts";
import { ReserveScopedAdmissionSchema } from "@shared/types/safety-score-v9-reserve-scope";
import { AdmittedProviderRowExclusionSchema } from "@shared/types/safety-score-v9-supply-attribution";
import { admitV9ControlExecutionScopeBatch, isV9AdmittedControlExecutionScope, type V9ControlExecutionScope, type V9ControlExecutionScopeRootReuse } from "@shared/types/safety-score-v9-control-scope";
import { compareCodeUnits } from "@shared/lib/compare";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isRecord } from "@shared/lib/type-guards";
import { canonicalV9DependencyEdgeKey } from "@shared/lib/safety-score-v9/facts";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { createV9ValueInterner, deepFreeze } from "@shared/types/safety-score-v9-immutable";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  defaultV9DependencyEconomicRole,
  V9DependencyEconomicRoleSchema,
} from "@shared/types/dependency-types";
import {
  V9AccessReviewV2Schema,
  V9EffectiveDependenciesInputFields,
  V9DependencyEdgeInputSchema,
  validateV9DependencyRole,
  V9DeploymentControlFactBaseSchema,
  V1005InProcessAssetIssuanceFactsSchema,
  V9EconomicControlReviewV2Schema,
  V9ExitRouteFactBaseSchema,
  V9ReserveAssetClassSchema,
  V9ResolvedMechanismArchetypeSchema,
  V9VariantKindSchema,
} from "@shared/types/safety-score-v9-facts";
import { canonicalV9ExecutionCostKey } from "@shared/types/safety-score-v9-fact-primitives";
import {
  V9CdpStressCoverageFactSchema,
  V9MechanismRiskReviewSchema,
} from "@shared/types/safety-score-v9-backing";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
} from "@shared/types/exit-route";
import { ReserveSliceSchema } from "@shared/types/reserves";
import type { ReserveSlice } from "@shared/types/reserves";
import { CustodyModelSchema, WRAPPER_OPERATOR_VALUES } from "@shared/types/core";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-primitives";
import { SafetyScoreV9WrapperAllocationReviewSchema, V9AllocationScopeIdentityReviewSchema } from "@shared/types/safety-score-v9-allocation";
import { SafetyScoreV9WrapperLocalReviewSchema } from "@shared/types/safety-score-v9-wrapper-local-review";
import { canonicalArrayBy } from "@shared/types/safety-score-v9-fact-primitives";
import {
  CanonicalFailureDomainsSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
  V9BridgeSupplyRouteV2Schema,
  V9PegReferenceKindSchema,
  V9MechanismExitDispositionSchema,
  V9MechanismExitFactKeySchema,
  V9MechanismQualitySchema,
} from "@shared/types/safety-score-v9-fact-input-primitives";
import {
  V9RouteLaneSchema,
  V9RouteOutputKindSchema,
  V9RouteValuationBasisSchema,
  V9RouteValuationConfidenceSchema,
} from "@shared/types/safety-score-v9-fact-input-primitives";
import { ResearchEvidenceSchema, ComponentEvidenceBindingSchema } from "@shared/types/safety-score-v9-research-evidence";

export function computeSafetyScoreV9ReserveExposureKey(slice: ReserveSlice): string {
  if (slice.sourceKey) {
    return `reserve:${domainDigest("safety-score-v9.reserve-exposure-source-key.v1", {
      sourceKey: slice.sourceKey,
    }).slice(0, 24)}`;
  }
  return `reserve:${domainDigest("safety-score-v9.reserve-exposure-key.v1", {
    name: slice.name.trim(),
    coinId: slice.coinId ?? null,
    dependencyType: slice.depType ?? null,
  }).slice(0, 24)}`;
}


const SourceClockSchema = z
  .object({
    generationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    maxAgeSec: z.number().int().nonnegative().nullable(),
  })
  .strict();


const ReserveApplicabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("required") }).strict(),
  z.object({ state: z.literal("not-applicable"), rationale: CanonicalTextSchema }).strict(),
]);

const ReserveClassificationSchema = z
  .object({
    exposureKey: CanonicalTextSchema,
    classificationKey: CanonicalTextSchema,
    assetClass: V9ReserveAssetClassSchema.nullable(),
    issuerOrObligorKey: CanonicalTextSchema.nullable(),
    riskFactors: canonicalArrayBy(CanonicalTextSchema, (value) => value),
    liquidityHorizon: z.enum(["immediate", "one-day", "seven-days", "over-seven-days", "unknown"]).nullable(),
    maturityDaysMax: z.number().int().nonnegative().nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
    trackedAssetId: CanonicalTextSchema.nullable().optional(),
    trackedAssetDisposition: z.enum(["source", "reviewed-non-link"]).optional(),
    /** Exact reviewed source identity whose amount remains unclassified. */
    unclassifiedResidual: z.literal(true).optional(),
    publishedResidualCategory: z.literal(true).optional(),
  })
  .strict();

const DependencyEdgeOverlaySchema = z
  .object({
    upstreamAssetId: V9DependencyEdgeInputSchema.shape.upstreamAssetId,
    dependencyType: V9DependencyEdgeInputSchema.shape.dependencyType,
    weight: V9DependencyEdgeInputSchema.shape.weight,
    economicRole: V9DependencyEconomicRoleSchema.optional(),
    failureDomains: V9DependencyEdgeInputSchema.shape.failureDomains,
    intermediary: V9DependencyEdgeInputSchema.shape.intermediary,
  })
  .strict()
  .superRefine((edge, ctx) => {
    const role = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
    if (role === "serial-claim" && edge.weight !== 1) {
      ctx.addIssue({ code: "custom", path: ["weight"], message: "Serial dependencies must have weight 1" });
    }
    validateV9DependencyRole(edge, ctx, "Basket exposures must be collateral edges");
  });

const EffectiveDependenciesOverlaySchema = z
  .object({
    ...V9EffectiveDependenciesInputFields,
    edges: canonicalArrayBy(DependencyEdgeOverlaySchema, (edge) => {
      const role = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
      return canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId, role);
    }),
  })
  .strict();

const RouteExecutionCostSchema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    maxCostBps: z.number().finite().nonnegative(),
    executionCostBps: z.number().finite().nonnegative(),
  })
  .strict();

export const RouteValuationSchema = z
  .object({
    basis: V9RouteValuationBasisSchema,
    referenceAssetKey: CanonicalTextSchema,
    unitValueUsd: z.number().finite().nonnegative(),
    expectedUnitValueUsd: z.number().finite().positive(),
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    maxAgeSec: z.number().int().nonnegative().nullable(),
    confidence: V9RouteValuationConfidenceSchema,
    url: z.string().url().nullable(),
    contentSha256: Sha256Schema.nullable(),
  })
  .strict()
  .refine((valuation) => valuation.unitValueUsd > 0 || valuation.basis === "commodity-delivery", {
    message: "Only physical delivery can have zero deliverable value",
  });

export const RouteOutputReviewSchema = z
  .object({
    kind: V9RouteOutputKindSchema,
    sameNotionalEligible: z.literal(false).optional(),
    unboundedDeliveryCap: z.number().finite().min(0).max(100).optional(),
    assetKeys: canonicalArrayBy(CanonicalTextSchema, (value) => value).refine((values) => values.length > 0, {
      message: "Route output requires at least one asset key",
    }),
    basketWeights: canonicalArrayBy(
      z.object({ assetKey: CanonicalTextSchema, weight: z.number().finite().positive().max(1) }).strict(),
      (entry) => entry.assetKey,
    ),
    valuation: RouteValuationSchema.nullable(),
  })
  .strict();

export const RouteReviewSchema = V9ExitRouteFactBaseSchema
  .extend({
    // Producer-only overlay: the review-side settlement horizon and measured
    // execution costs have no compiled-fact counterpart, and the review output
    // shape is the producer's own projection (`RouteOutputReviewSchema`).
    settlementHorizonSec: z.number().int().nonnegative().optional(),
    // Explicit null clears a superseded captured unquantified-fee label.
    feeEvidence: V9ExitRouteFactBaseSchema.shape.feeEvidence.unwrap().nullable().optional(),
    // Only a current admitted completed-endpoint review may clear this marker.
    settlementBoundUnproven: z.boolean().optional(),
    executionCosts: canonicalArrayBy(
      RouteExecutionCostSchema,
      canonicalV9ExecutionCostKey,
    ),
    output: RouteOutputReviewSchema.nullable(),
    // Optional for retained extension-v2 compatibility. Current redemption
    // reviews distinguish a known-but-unpriceable external output from an
    // issuer-undisclosed settlement asset without making either scoreable.
    unresolvedOutputResponsibility: z
      .enum(["integration-missing", "issuer-undisclosed", "producer-failed"])
      .optional(),
  })
  .strict();

export const RejectionSchema = z
  .object({ code: CanonicalTextSchema, reason: CanonicalTextSchema, rejectedAtSec: UnixSecondsSchema })
  .strict();

const RetainedRouteSchema = z
  .object({
    lane: V9RouteLaneSchema,
    observation: ExitRouteObservationSchema,
    disposition: z.enum(["observed", "rejected"]),
    rejection: RejectionSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const laneResult =
      value.lane === "dex"
        ? DexExitRouteObservationSchema.safeParse(value.observation)
        : RedemptionExitRouteObservationSchema.safeParse(value.observation);
    if (!laneResult.success) ctx.addIssue({ code: "custom", path: ["observation"], message: "Route lane mismatch" });
    if ((value.disposition === "rejected") !== (value.rejection !== null)) {
      ctx.addIssue({ code: "custom", path: ["rejection"], message: "Rejected routes require rejection metadata" });
    }
  });

// Producer-side control inventory overlay: the compiled control fact's
// reviewed shape, minus the compiled-only `sourceGenerationId`/`status`.
const ControlOverlaySchema = V9DeploymentControlFactBaseSchema;

const ControlReviewSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("reviewed-controls"),
      controls: canonicalArrayBy(ControlOverlaySchema, (control) => control.controlKey).refine(
        (controls) => controls.length > 0,
        { message: "Reviewed control posture requires at least one control" },
      ),
    })
    .strict(),
  z
    .object({
      state: z.literal("partially-reviewed-controls"),
      controls: canonicalArrayBy(ControlOverlaySchema, (control) => control.controlKey).refine(
        (controls) => controls.length > 0,
        { message: "Partial control inventory requires at least one control" },
      ),
      rationale: CanonicalTextSchema,
    })
    .strict(),
  z.object({ state: z.literal("no-privileged-controls"), rationale: CanonicalTextSchema }).strict(),
]);

const PegReferenceSchema = z
  .object({
    referenceKind: V9PegReferenceKindSchema,
    referenceKey: CanonicalTextSchema,
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();

const SupplyReviewSchema = z
  .object({
    selectedBridgeRoutes: canonicalArrayBy(
      V9BridgeSupplyRouteV2Schema,
      (route) => route.deploymentRouteKey,
    ),
    selectedRouteSupplyShare: FractionSchema,
    unknownRouteSupplyShare: FractionSchema,
    unreviewedRouteSupplyShare: FractionSchema,
    failureDomains: CanonicalFailureDomainsSchema,
    providerRowExclusions: z.array(AdmittedProviderRowExclusionSchema).optional(),
  })
  .strict();

const ReviewedStaticReserveRowsSchema = z
  .object({
    rows: canonicalArrayBy(
      ReserveSliceSchema,
      (row) => `${computeSafetyScoreV9ReserveExposureKey(row)}:${stableJsonStringifyV1(row)}`,
    ).refine((rows) => rows.length > 0, { message: "Reviewed static reserve admission requires rows" }),
    evidenceClass: z.enum(["independent", "issuer-attested", "static-validated"]),
    provenance: z.enum(["curated", "curated-fallback", "audited-fallback"]).default("curated"),
    sourceKind: z.enum(["standing-structure", "portfolio-observation", "financial-report"]).optional(),
    scopeId: z.string().min(1).optional(),
  })
  .strict();

const MechanismExitFactOverlaySchema = z
  .object({
    factKey: V9MechanismExitFactKeySchema,
    disposition: V9MechanismExitDispositionSchema,
    quality: V9MechanismQualitySchema.nullable(),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if ((fact.disposition === "supported") !== (fact.quality !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["quality"],
        message: "Supported mechanism exit facts require quality; unavailable facts cannot claim quality",
      });
    }
  });

const WrapperCustodyReviewSchema = z
  .object({
    // Authored wrapper custody model only; absence does not prove on-chain custody.
    custodyModel: CustodyModelSchema.default("unknown"),
    providers: canonicalArrayBy(
      z
        .object({
          providerKey: CanonicalTextSchema,
          role: z.enum(["custodian", "subcustodian", "bank", "prime-broker", "other"]),
          shareFraction: FractionSchema.nullable(),
        })
        .strict(),
      (provider) => provider.providerKey,
    ),
    segregation: z.enum(["segregated", "omnibus", "mixed", "unknown"]),
    bankruptcyRemoteness: z.enum(["structured", "contractual-only", "none", "unknown"]),
    rehypothecation: z.enum(["prohibited", "permitted", "conditional", "unknown"]),
    knownUnknownExposureShare: FractionSchema.nullable(),
  })
  .strict();

/**
 * Asset-local admission failure. A baseline producer or extension validator
 * that cannot build or admit one asset's local overlay replaces it with a
 * conservative stub carrying this marker; compilation then quarantines the
 * asset to producer-failed NR instead of rejecting the cohort (R8).
 */
const AssetAdmissionQuarantineSchema = z
  .object({
    code: z.enum(["fact-build-failed", "fact-validation-failed"]),
    path: CanonicalTextSchema,
    message: z.string().min(1).max(500),
  })
  .strict();
export type SafetyScoreV9AssetAdmissionQuarantine = z.infer<typeof AssetAdmissionQuarantineSchema>;

const AssetExtensionSchema = z
  .object({
    assetId: CanonicalTextSchema,
    assetIssuerKey: CanonicalTextSchema.nullable().optional(),
    archetype: V9ResolvedMechanismArchetypeSchema,
    variantKind: V9VariantKindSchema,
    wrapperOperator: z.enum(WRAPPER_OPERATOR_VALUES).optional(),
    launchedAtSec: UnixSecondsSchema.nullable(),
    mechanismRiskReview: V9MechanismRiskReviewSchema.nullable(),
    mechanismReviewGapDisposition: z
      .object({
        responsibility: z.literal("method-unsupported"),
        rationale: CanonicalTextSchema,
        componentKeys: canonicalArrayBy(CanonicalTextSchema, (componentKey) => componentKey),
      })
      .strict()
      .optional(),
    // Mechanism components the reviewer adjudicated as reviewed-but-unpublished.
    // The facts stay bounded-unknown, so this changes no score; it carries the
    // adjudication to the gap message, which is the only place a reader can
    // tell a completed review from an outstanding one.
    mechanismReviewedUnavailable: canonicalArrayBy(
      z
        .object({
          componentKey: CanonicalTextSchema,
          rationale: CanonicalTextSchema,
          sourceUrl: CanonicalTextSchema,
          reviewedAt: CanonicalTextSchema,
          searchedSurfaces: z.array(z.string().url()).min(1),
        })
        .strict(),
      (row) => row.componentKey,
    ).optional(),
    mechanismExitFacts: canonicalArrayBy(
      MechanismExitFactOverlaySchema,
      (fact) => fact.factKey,
    ).optional(),
    cdpStressCoverage: V9CdpStressCoverageFactSchema.optional(),
    dependencies: EffectiveDependenciesOverlaySchema.nullable(),
    reserveApplicability: ReserveApplicabilitySchema,
    reserveClassifications: canonicalArrayBy(ReserveClassificationSchema, (row) => row.exposureKey),
    reserveBoundFacts: canonicalArrayBy(ReserveBoundedFactSchema, (row) => row.factKey).optional(),
    reviewedStaticReserveRows: ReviewedStaticReserveRowsSchema.nullable().optional(),
    reserveScopeAdmissions: z.array(ReserveScopedAdmissionSchema).optional(),
    routeReviews: canonicalArrayBy(RouteReviewSchema, (row) => `${row.lane}:${row.routeId}`),
    retainedRoutes: canonicalArrayBy(
      RetainedRouteSchema,
      (row) => `${row.lane}:${row.observation.routeId}:${stableJsonStringifyV1(row.observation)}`,
    ),
    controlReview: ControlReviewSchema.nullable(),
    issuanceFacts: V1005InProcessAssetIssuanceFactsSchema.optional(),
    economicControlReview: V9EconomicControlReviewV2Schema.nullable(),
    accessReview: V9AccessReviewV2Schema.nullable(),
    pegReference: PegReferenceSchema.nullable(),
    supplyReview: SupplyReviewSchema.nullable(),
    // Optional only for retained extension-v2 compatibility. The current
    // baseline producer emits the reviewed registry projection when available.
    wrapperCustodyReview: WrapperCustodyReviewSchema.nullable().optional(),
    wrapperAllocationReview: SafetyScoreV9WrapperAllocationReviewSchema.nullable().optional(),
    wrapperLocalReviews: canonicalArrayBy(SafetyScoreV9WrapperLocalReviewSchema, (review) => review.kind).optional(),
    allocationScopeIdentityReview: V9AllocationScopeIdentityReviewSchema.optional(),
    parentBackingInheritance: ParentBackingInheritanceSchema.optional(),
    researchEvidence: canonicalArrayBy(ResearchEvidenceSchema, (evidence) => evidence.evidenceKey).default([]),
    componentEvidence: canonicalArrayBy(ComponentEvidenceBindingSchema, (binding) => binding.componentKey).default([]),
    admissionQuarantine: AssetAdmissionQuarantineSchema.optional(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.controlReview && "controls" in asset.controlReview) {
      for (const [index, control] of asset.controlReview.controls.entries()) {
        if (control.issuanceFactsRef !== undefined && (control.controlKind === "bridge" ||
            control.issuanceFactsRef !== asset.issuanceFacts?.ref || control.issuanceGovernance !== undefined ||
            control.issuanceProcess !== undefined || control.processDiagnostics !== undefined)) {
          ctx.addIssue({ code: "custom", path: ["controlReview", "controls", index, "issuanceFactsRef"],
            message: "Native issuance reference must resolve to the asset facts without inline governance/process/diagnostics" });
        }
        if (asset.issuanceFacts && control.controlKind !== "bridge" && control.issuanceFactsRef !== asset.issuanceFacts.ref) {
          ctx.addIssue({ code: "custom", path: ["controlReview", "controls", index, "issuanceFactsRef"],
            message: "Every native control must reference the canonical asset issuance facts" });
        }
      }
    }
    for (const [field, review] of [
      ["wrapperAllocationReview", asset.wrapperAllocationReview],
      ["allocationScopeIdentityReview", asset.allocationScopeIdentityReview],
    ] as const) {
      if (review != null && review.assetId !== asset.assetId) {
        ctx.addIssue({ code: "custom", path: [field, "assetId"], message: "Allocation review must match extension asset" });
      }
    }
    for (const [index, review] of (asset.wrapperLocalReviews ?? []).entries()) {
      if (review.assetId !== asset.assetId) {
        ctx.addIssue({ code: "custom", path: ["wrapperLocalReviews", index, "assetId"], message: "Local review must match extension asset" });
      }
    }
    if (asset.cdpStressCoverage !== undefined && asset.archetype !== "cdp") {
      ctx.addIssue({
        code: "custom",
        path: ["cdpStressCoverage"],
        message: "Only CDP extension assets may carry stress-coverage facts",
      });
    }
    const evidenceKeys = new Set(asset.researchEvidence.map((evidence) => evidence.evidenceKey));
    for (let bindingIndex = 0; bindingIndex < asset.componentEvidence.length; bindingIndex += 1) {
      const binding = asset.componentEvidence[bindingIndex]!;
      for (let keyIndex = 0; keyIndex < binding.evidenceKeys.length; keyIndex += 1) {
        if (evidenceKeys.has(binding.evidenceKeys[keyIndex]!)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["componentEvidence", bindingIndex, "evidenceKeys", keyIndex],
          message: `Unknown research evidence key: ${binding.evidenceKeys[keyIndex]}`,
        });
      }
    }
  });

type AdmittedAssetExtension = z.infer<typeof AssetExtensionSchema>;

interface AssetClockIssue {
  path: (string | number)[];
  message: string;
}

/** Point-in-time admission checks of one asset against the extension clock. */
function assetExtensionClockIssues(asset: AdmittedAssetExtension, compiledAtSec: number): AssetClockIssue[] {
  const issues: AssetClockIssue[] = [];
  for (let evidenceIndex = 0; evidenceIndex < asset.researchEvidence.length; evidenceIndex += 1) {
    const evidence = asset.researchEvidence[evidenceIndex]!;
    if (evidence.observedAtSec > compiledAtSec) {
      issues.push({
        path: ["researchEvidence", evidenceIndex, "observedAtSec"],
        message: "Research evidence observation cannot be later than the extension clock",
      });
    }
    if (evidence.publishedAtSec !== null && evidence.publishedAtSec > compiledAtSec) {
      issues.push({
        path: ["researchEvidence", evidenceIndex, "publishedAtSec"],
        message: "Research evidence publication cannot be later than the extension clock",
      });
    }
  }
  return issues;
}

const ExtensionEnvelopeShape = {
  schemaVersion: z.literal(3),
  registryFingerprint: Sha256Schema,
  compiledAtSec: UnixSecondsSchema,
  sources: z
    .object({
      registryObservedAtSec: UnixSecondsSchema,
      unavailableRedemptionObservedAtSec: UnixSecondsSchema,
      liveReserves: SourceClockSchema,
      chainSupply: SourceClockSchema,
      peg: SourceClockSchema,
      researchOverlays: SourceClockSchema,
    })
    .strict(),
  routeFreshness: z
    .object({
      dexMaxAgeSec: z.number().int().nonnegative(),
      redemptionMaxAgeSec: z.number().int().nonnegative(),
      documentedTermsMaxAgeSec: z.number().int().nonnegative(),
    })
    .strict(),
};
const EMPTY_EXTENSION_MESSAGE = "Safety Score v9 extension requires at least one asset";

export const SafetyScoreV9FactSetExtensionV2Schema = z
  .object({
    ...ExtensionEnvelopeShape,
    assets: canonicalArrayBy(AssetExtensionSchema, (asset) => asset.assetId).refine((assets) => assets.length > 0, {
      message: EMPTY_EXTENSION_MESSAGE,
    }),
  })
  .strict()
  .superRefine((extension, ctx) => {
    for (let assetIndex = 0; assetIndex < extension.assets.length; assetIndex += 1) {
      for (const issue of assetExtensionClockIssues(extension.assets[assetIndex]!, extension.compiledAtSec)) {
        ctx.addIssue({ code: "custom", path: ["assets", assetIndex, ...issue.path], message: issue.message });
      }
    }
  });

export type SafetyScoreV9FactSetExtensionV2 = z.infer<typeof SafetyScoreV9FactSetExtensionV2Schema>;
export type AssetExtension = SafetyScoreV9FactSetExtensionV2["assets"][number];

const admittedExtensionAssets = new WeakSet<object>();

function isAdmittedExtensionAsset(value: unknown): value is AssetExtension {
  return isRecord(value) && admittedExtensionAssets.has(value);
}

function sealAdmittedExtensionAsset(asset: AssetExtension): AssetExtension {
  if (isAdmittedExtensionAsset(asset)) return asset;
  // Strict parsing owns mutable subtrees; only branded immutable scopes and issuance bundles retain identity.
  const admitted = createV9ValueInterner(undefined, isV9AdmittedControlExecutionScope)(asset);
  deepFreeze(admitted);
  admittedExtensionAssets.add(admitted);
  return admitted;
}

function batchAdmitExtensionControlScopes(value: unknown, reuseScopeRoot?: V9ControlExecutionScopeRootReuse): unknown {
  if (isAdmittedExtensionAsset(value) || !isRecord(value)) return value;
  const review = value.controlReview;
  if (!isRecord(review) || !Array.isArray(review.controls)) return value;
  const controls = review.controls;
  const scopes: unknown[] = [];
  for (const control of controls) {
    if (!isRecord(control)) continue;
    if (control.executionScope !== undefined) scopes.push(control.executionScope);
    if (Array.isArray(control.executionScopeContributors)) for (const contributor of control.executionScopeContributors) {
      if (isRecord(contributor) && contributor.scope !== undefined) scopes.push(contributor.scope);
    }
  }
  if (scopes.length === 0) return value;
  let admittedScopes: V9ControlExecutionScope[];
  try {
    admittedScopes = admitV9ControlExecutionScopeBatch(scopes);
    if (reuseScopeRoot) for (let index = 0; index < admittedScopes.length; index++) {
      admittedScopes[index] = reuseScopeRoot(admittedScopes[index]!);
    }
  } catch (error) {
    // Preserve the ordinary Asset parser's original field paths and R8 quarantine for invalid scopes.
    if (error instanceof z.ZodError) return value;
    throw error;
  }
  let index = 0;
  return { ...value, controlReview: { ...review, controls: controls.map((control: unknown) => {
    if (!isRecord(control)) return control;
    const contributors = control.executionScopeContributors;
    const hasContributors = Array.isArray(contributors) && contributors.some((row) => isRecord(row) && row.scope !== undefined);
    if (control.executionScope === undefined && !hasContributors) return control;
    return { ...control,
      ...(control.executionScope === undefined ? {} : { executionScope: admittedScopes[index++] }),
      ...(hasContributors ? { executionScopeContributors: contributors.map((row: unknown) =>
        isRecord(row) && row.scope !== undefined ? { ...row, scope: admittedScopes[index++] } : row) } : {}),
    };
  }) } };
}

/** Strict admission once; immutable identity permits reuse without a second fact-graph clone. */
export function admitSafetyScoreV9ExtensionAsset(
  value: unknown,
  compiledAtSec: number,
  reuseScopeRoot?: V9ControlExecutionScopeRootReuse,
  hydrateCdpStressCoverage: (asset: unknown) => unknown = (asset) => asset,
): AssetExtension {
  const assetId = salvage(CanonicalTextSchema, isRecord(value) ? value.assetId : undefined, null);
  if (assetId === null) throw new Error("Safety Score v9 extension asset has no canonical assetId");
  return admitExtensionAsset(batchAdmitExtensionControlScopes(value, reuseScopeRoot), assetId, compiledAtSec, hydrateCdpStressCoverage);
}

/** Envelope-only view: registry identity, clocks, freshness, and a non-empty asset list stay cohort-global. */
const ExtensionEnvelopeSchema = z
  .object({
    ...ExtensionEnvelopeShape,
    assets: z.array(z.unknown()).min(1, EMPTY_EXTENSION_MESSAGE),
  })
  .strict();

function salvage<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Conservative stand-in for one asset whose local overlay could not be built
 * or admitted. Only identity and graph-shape fields that validate on their own
 * are retained (so dependents still resolve their edges and the cohort graph
 * stays checkable); every score-bearing review is absent. Compilation turns the
 * marker into a producer-failed quarantine, never a rated or dropped asset.
 */
export function quarantinedSafetyScoreV9ExtensionAsset(
  source: unknown,
  assetId: string,
  quarantine: SafetyScoreV9AssetAdmissionQuarantine,
): AssetExtension {
  const record = isRecord(source) ? source : {};
  return sealAdmittedExtensionAsset(AssetExtensionSchema.parse({
    assetId,
    assetIssuerKey: salvage(CanonicalTextSchema.nullable(), record.assetIssuerKey, null),
    archetype: salvage(V9ResolvedMechanismArchetypeSchema, record.archetype, "unresolved"),
    variantKind: salvage(V9VariantKindSchema, record.variantKind, null) ?? null,
    launchedAtSec: null,
    mechanismRiskReview: null,
    dependencies: salvage(EffectiveDependenciesOverlaySchema.nullable(), record.dependencies, null),
    reserveApplicability: { state: "required" },
    reserveClassifications: [],
    routeReviews: [],
    retainedRoutes: [],
    controlReview: null,
    economicControlReview: null,
    accessReview: null,
    pegReference: salvage(PegReferenceSchema.nullable(), record.pegReference, null),
    supplyReview: null,
    admissionQuarantine: {
      code: quarantine.code,
      path: quarantine.path.trim().slice(0, 500).trim() || "asset",
      message:
        quarantine.message.trim().slice(0, 500).trim() || "Safety Score v9 asset extension could not be admitted",
    },
  }));
}

function admitExtensionAsset(
  source: unknown,
  assetId: string,
  compiledAtSec: number,
  hydrateCdpStressCoverage: (asset: unknown) => unknown,
): AssetExtension {
  let hydrated: unknown;
  try {
    hydrated = hydrateCdpStressCoverage(source);
  } catch (error) {
    return quarantinedSafetyScoreV9ExtensionAsset(source, assetId, {
      code: "fact-validation-failed",
      path: "cdpStressCoverage",
      message: toErrorMessage(error),
    });
  }
  const parsed = isAdmittedExtensionAsset(hydrated) ? { success: true as const, data: hydrated } : AssetExtensionSchema.safeParse(hydrated);
  const issues: readonly { path: readonly PropertyKey[]; message: string }[] = parsed.success
    ? assetExtensionClockIssues(parsed.data, compiledAtSec)
    : parsed.error.issues;
  const [first, ...rest] = issues;
  if (parsed.success && first === undefined) return sealAdmittedExtensionAsset(parsed.data);
  return quarantinedSafetyScoreV9ExtensionAsset(source, assetId, {
    code: "fact-validation-failed",
    path: first === undefined || first.path.length === 0 ? "asset" : first.path.map(String).join("."),
    message: `${first?.message ?? "Invalid asset extension"}${rest.length > 0 ? ` (+${rest.length} more issues)` : ""}`,
  });
}

/**
 * Parse an extension with the asset-local quarantine boundary (R8). The
 * envelope, each asset's identity, and the canonical asset-id set are
 * cohort-global and still throw. Everything inside one asset's overlay is
 * admitted per asset: a malformed, point-in-time-inadmissible, or unverifiable
 * replay-pinned overlay becomes a quarantined stub with its field path and
 * reason. For a fully valid extension the result equals
 * `SafetyScoreV9FactSetExtensionV2Schema.parse(value)`.
 */
export function admitSafetyScoreV9FactSetExtension(
  value: unknown,
  hydrateCdpStressCoverage: (asset: unknown) => unknown,
): SafetyScoreV9FactSetExtensionV2 {
  const envelope = ExtensionEnvelopeSchema.parse(value);
  const seen = new Set<string>();
  const assets = envelope.assets.map((source, index) => {
    const assetId = salvage(CanonicalTextSchema, isRecord(source) ? source.assetId : undefined, null);
    if (assetId === null) {
      throw new Error(`Safety Score v9 extension asset at index ${index} has no canonical assetId`);
    }
    if (seen.has(assetId)) {
      throw new Error(`Duplicate canonical key: ${assetId}`);
    }
    seen.add(assetId);
    return admitExtensionAsset(source, assetId, envelope.compiledAtSec, hydrateCdpStressCoverage);
  });
  assets.sort((left, right) => compareCodeUnits(left.assetId, right.assetId));
  return { ...envelope, assets };
}
