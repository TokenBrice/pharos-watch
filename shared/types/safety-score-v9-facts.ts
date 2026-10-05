import { z } from "zod";
import { RedemptionRouteSuspensionSchema } from "./redemption";
import { V9ReserveBoundedFactSchema } from "./reserve-bounded-facts";
import { ReserveScopedAdmissionSchema } from "./safety-score-v9-reserve-scope";
import { AdmittedProviderRowExclusionSchema } from "./safety-score-v9-supply-attribution";
import { V9AccessClaimGraphSchema, v9AccessClaimGraphStatuses } from "./safety-score-v9-access-lookthrough";
import { V9InProcessControlExecutionScopeSchema, V9ExactControlPolicySchema, V9WeightedQuorumSchema, V9SameChainSystemTransportSchema } from "./safety-score-v9-control-scope";
import { createV9ValueInterner, deepFreeze } from "./safety-score-v9-immutable";
import { DeploymentIdSchema } from "./stablecoin-meta-schemas";
import { ReserveIntermediarySchema } from "./reserves";
import {
  DependencyTypeSchema,
  V9DependencyEconomicRoleSchema,
} from "./dependency-types";
import { V9PathKindSchema, V9ReasonCodeSchema, V9ReasonOwnerDomainSchema } from "./safety-score-v9";
import { V9CdpStressCoverageFactSchema, V9MechanismRiskReviewSchema, type V9MechanismFactV1 } from "./safety-score-v9-backing";
import { V9OperationalResilienceFactSchema } from "./safety-score-v9-operational-resilience";
import { V9AllocationScopeFactSchema } from "./safety-score-v9-allocation";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
} from "./safety-score-v9-wrapper";
import {
  ExitRouteConfidenceSchema,
  ExitRouteEvidenceKindSchema,
  ExitRouteFamilySchema,
  ExitRouteObservationHistorySchema,
  PhysicalToUsdTraceSchema,
  ExitExecutionCertificateSchema,
  ExitRouteCapacityEvidenceTierSchema,
} from "./exit-route";
import { RedemptionCapacityScoringHorizonSchema } from "./redemption";
import { ReserveAssetClassSchema } from "./reserves";
import {
  V9EvidenceResponsibilitySchema,
  V9FactStatusV2Schema,
  V9ObservationStateSchema,
  canonicalArrayBy,
  canonicalV9ExecutionCostKey,
  type V9EvidenceResponsibility,
  type V9FactApplicability,
  type V9FactStatusV2,
  type V9FailureDomainRef,
  type V9ObservationState,
} from "./safety-score-v9-fact-primitives";
import { BRIDGE_ROUTE_RISK_TIER_VALUES, ORACLE_RISK_TIER_VALUES, VARIANT_KIND_VALUES } from "./core";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";
import {
  V9EvidenceCauseProofSchema, V9EvidenceCauseScopeSchema, V9EvidenceCauseBindingSchema,
  findV9EvidenceCauseProofIssues, v9EvidenceResponsibilityForCauseProof,
  V9CauseResolutionDiagnosticSchema,
} from "./safety-score-v9-causes";
import {
  V9ReserveFactorStatusesSchema, V9ExitFactorStatusesSchema, V9ControlFactorStatusesSchema,
  V9ReserveResidualFactSchema,
} from "./safety-score-v9-fact-primitives";
import {
  BaseInputGenerationIdSchema,
  CanonicalChainIdSchema,
  CanonicalFailureDomainsSchema,
  CanonicalStringArraySchema,
  CanonicalTextSchema,
  FractionSchema,
  NonNegativeUsdSchema,
  PositiveFractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
  V9ClaimImpairmentSchema,
  V9ControlCapSemanticsSchema,
  V9ControlCapabilitySchema,
  V9ControlKindSchema,
  V9ControlScopeSchema,
  V9EconomicLossScopeSchema,
  V9MechanismExitDispositionSchema,
  V9MechanismExitFactKeySchema,
  V9MechanismQualitySchema,
  V9RouteCoverageClassSchema,
  V9RouteExecutionCertaintySchema,
  V9RouteExecutionModelSchema,
  V9RouteHolderAccessSchema,
  V9RouteLaneSchema,
  V9RouteOutputKindSchema,
  V9RouteSettlementModelSchema,
  V9RouteValuationBasisSchema,
  V9RouteValuationConfidenceSchema,
} from "./safety-score-v9-fact-input-primitives";

export const V9ResolvedMechanismArchetypeSchema = z.union([
  z.enum(MECHANISM_ARCHETYPE_VALUES),
  z.literal("unresolved"),
]);

/** Product taxonomy for a tracked parent-linked asset. Wrapper ownership and
 * parent-cap form are compiled separately into `wrapperLocalFacts.form`.
 */
export const V9VariantKindSchema = z.enum(VARIANT_KIND_VALUES).nullable().optional();

export { V9FactStatusV2Schema };
export type { V9EvidenceResponsibility, V9FactApplicability, V9FactStatusV2, V9FailureDomainRef, V9ObservationState };


const V9EvidenceFreshnessSchema = z
  .object({
    state: z.enum(["current", "stale", "not-assessed"]),
    ageSec: z.number().int().nonnegative(),
    maxAgeSec: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((freshness, ctx) => {
    if (freshness.state === "not-assessed" && freshness.maxAgeSec !== null) {
      ctx.addIssue({ code: "custom", path: ["maxAgeSec"], message: "Unassessed freshness cannot set a maximum age" });
    }
    if (freshness.state !== "not-assessed" && freshness.maxAgeSec === null) {
      ctx.addIssue({ code: "custom", path: ["maxAgeSec"], message: "Assessed freshness requires a maximum age" });
    }
    if (freshness.state === "current" && freshness.maxAgeSec !== null && freshness.ageSec > freshness.maxAgeSec) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "Current evidence exceeds its maximum age" });
    }
    if (freshness.state === "stale" && freshness.maxAgeSec !== null && freshness.ageSec <= freshness.maxAgeSec) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "Stale evidence has not exceeded its maximum age" });
    }
  });

export const V9EvidenceReferenceV2Schema = z
  .object({
    evidenceId: CanonicalTextSchema,
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    disposition: z.enum(["observed", "published", "rejected"]),
    observedAtSec: UnixSecondsSchema,
    publishedAtSec: UnixSecondsSchema.nullable(),
    url: z.string().url().nullable(),
    contentSha256: Sha256Schema.nullable(),
    freshness: V9EvidenceFreshnessSchema,
    rejection: z
      .object({
        code: CanonicalTextSchema,
        reason: CanonicalTextSchema,
        rejectedAtSec: UnixSecondsSchema,
      })
      .strict()
      .nullable(),
    causeBinding: V9EvidenceCauseBindingSchema.optional(),
  })
  .strict()
  .superRefine((reference, ctx) => {
    if (reference.disposition === "observed" && reference.publishedAtSec !== null) {
      ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Observed evidence cannot claim publication" });
    }
    if (reference.disposition === "published" && reference.publishedAtSec === null) {
      ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Published evidence requires publishedAtSec" });
    }
    if (reference.disposition === "rejected" && reference.rejection === null) {
      ctx.addIssue({ code: "custom", path: ["rejection"], message: "Rejected evidence requires a rejection record" });
    }
    if (reference.disposition !== "rejected" && reference.rejection !== null) {
      ctx.addIssue({ code: "custom", path: ["rejection"], message: "Accepted evidence cannot carry a rejection" });
    }
    if (reference.publishedAtSec !== null && reference.publishedAtSec < reference.observedAtSec) {
      ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Publication cannot predate observation" });
    }
    if (reference.rejection && reference.rejection.rejectedAtSec < reference.observedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["rejection", "rejectedAtSec"],
        message: "Rejection cannot predate observation",
      });
    }
  });
export type V9EvidenceReferenceV2 = z.infer<typeof V9EvidenceReferenceV2Schema>;

export const V9TypedFactPathSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("serial-dependency"),
      upstreamAssetId: CanonicalTextSchema,
      dependencyType: z.enum(["wrapper", "mechanism"]),
    })
    .strict(),
  z.object({ kind: z.literal("collateral-exposure"), exposureKey: CanonicalTextSchema }).strict(),
  z
    .object({
      kind: z.literal("deployment-control"),
      deploymentKey: CanonicalTextSchema,
      controlKey: CanonicalTextSchema,
    })
    .strict(),
  z.object({ kind: z.literal("optional-exit"), routeKey: CanonicalTextSchema }).strict(),
  z.object({ kind: z.literal("local-component"), componentKey: CanonicalTextSchema }).strict(),
  z.object({ kind: z.literal("peg"), pegKey: CanonicalTextSchema }).strict(),
  z.object({ kind: z.literal("methodology"), componentKey: CanonicalTextSchema }).strict(),
]);
export type V9TypedFactPath = z.infer<typeof V9TypedFactPathSchema>;

const V9FactGapV2Fields = {
  gapId: CanonicalTextSchema,
  reasonCode: V9ReasonCodeSchema,
  ownerDomain: V9ReasonOwnerDomainSchema,
  policyRuleId: CanonicalTextSchema,
  observationState: V9ObservationStateSchema.exclude(["known"]),
  path: V9TypedFactPathSchema,
  message: CanonicalTextSchema,
  evidenceRefIds: CanonicalStringArraySchema,
};

function validateFactGapPath(gap: { path: V9TypedFactPath }, ctx: z.RefinementCtx): void {
  if (!V9PathKindSchema.safeParse(gap.path.kind).success) {
    ctx.addIssue({ code: "custom", path: ["path", "kind"], message: "Gap path kind is not registered by v9" });
  }
}

export const V9FactGapV2Schema = z
  .object(V9FactGapV2Fields)
  .strict()
  .superRefine(validateFactGapPath);
export type V9FactGapV2 = z.infer<typeof V9FactGapV2Schema>;

export const V9FactGapV3Schema = z
  .object({
    ...V9FactGapV2Fields,
    responsibility: V9EvidenceResponsibilitySchema,
    causeProof: V9EvidenceCauseProofSchema,
    causeScope: V9EvidenceCauseScopeSchema.optional(),
    evidenceHistory: z.object({
      publishedBy: z.enum(["issuer", "parent", "other", "unknown"]),
      evidenceRefIds: CanonicalStringArraySchema,
    }).strict().optional(),
  })
  .strict()
  .superRefine((gap, ctx) => {
    validateFactGapPath(gap, ctx);
    if (gap.responsibility !== v9EvidenceResponsibilityForCauseProof(gap.causeProof)) {
      ctx.addIssue({ code: "custom", path: ["responsibility"], message: "Responsibility must derive from the cause proof" });
    }
    if (gap.causeProof.evidenceRefIds.some((id) => !gap.evidenceRefIds.includes(id))) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "Gap must retain every proof evidence reference" });
    }
  });
export type V9FactGapV3 = z.infer<typeof V9FactGapV3Schema>;


const V9EffectiveDependencyEdgeBaseSchema = z.object({
  edgeKey: CanonicalTextSchema,
  upstreamAssetId: CanonicalTextSchema,
  dependencyType: DependencyTypeSchema,
  weight: PositiveFractionSchema,
  evidenceRefIds: CanonicalStringArraySchema,
  failureDomains: CanonicalFailureDomainsSchema,
  intermediary: ReserveIntermediarySchema.optional(),
});

const V9EffectiveDependencyEdgeV2Schema = V9EffectiveDependencyEdgeBaseSchema.extend({
  pathKind: z.enum(["serial-dependency", "collateral-exposure"]),
  economicRole: z.enum(["serial-claim", "basket-exposure"]),
})
  .strict()
  .superRefine((edge, ctx) => {
    const serial = edge.dependencyType === "wrapper" || edge.dependencyType === "mechanism";
    if (serial !== (edge.pathKind === "serial-dependency") || serial !== (edge.economicRole === "serial-claim")) {
      ctx.addIssue({ code: "custom", message: "Dependency type, path kind, and economic role disagree" });
    }
    if (serial && edge.weight !== 1) {
      ctx.addIssue({ code: "custom", path: ["weight"], message: "Serial dependencies must have weight 1" });
    }
  });

export const V9DependencyRejectionReasonsSchema = z.array(z.object({
  sliceIndex: z.number().int().min(-1),
  reason: z.enum(["no-match", "expired", "non-link", "coinId-without-depType", "manual-collateral-not-in-reserves", "reviewed-dependency-type-conflict", "reviewed-dependency-identity-conflict"]),
  manualDependencyIndex: z.number().int().nonnegative().optional(),
  upstreamAssetId: z.string().min(1).optional(),
  reviewedUpstreamAssetId: z.string().min(1).optional(),
  share: z.number().finite().min(0).max(1).optional(),
}).strict());

const V9EffectiveDependenciesBaseFields = {
  status: V9FactStatusV2Schema,
  sourceGenerationId: CanonicalTextSchema,
  source: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none", "variant"]),
  baseSource: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none"]),
  dependencyFromLive: z.boolean(),
  mappedLiveReserveWeight: FractionSchema.nullable(),
  fallbackReason: z
    .enum(["live-unmapped-to-curated-reserve", "live-unmapped-to-manual", "live-cycle-to-curated"])
    .nullable(),
  rejectionReasons: V9DependencyRejectionReasonsSchema.optional(),
  diagnostics: z
    .object({
      graphState: z.enum(["valid", "cycle", "invalid", "unresolved"]),
      issueCodes: CanonicalStringArraySchema,
      sccMemberAssetIds: CanonicalStringArraySchema,
    })
    .strict(),
};

function validateDependencyEnvelope(
  dependencies: Pick<
    V9EffectiveDependenciesV2 | V9EffectiveDependenciesV3,
    "source" | "fallbackReason" | "diagnostics" | "edges"
  >,
  ctx: z.RefinementCtx,
): void {
  if (dependencies.source === "none" && dependencies.edges.length > 0) {
    ctx.addIssue({ code: "custom", path: ["edges"], message: "A none dependency source cannot contain edges" });
  }
  if (dependencies.fallbackReason !== null && dependencies.source === "live-reserve") {
    ctx.addIssue({
      code: "custom",
      path: ["fallbackReason"],
      message: "Direct live dependencies cannot be a fallback",
    });
  }
  if (dependencies.diagnostics.graphState === "valid") {
    if (dependencies.diagnostics.issueCodes.length > 0 || dependencies.diagnostics.sccMemberAssetIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "A valid dependency graph cannot carry issues",
      });
    }
  }
  if (dependencies.diagnostics.graphState === "cycle" && dependencies.diagnostics.sccMemberAssetIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["diagnostics", "sccMemberAssetIds"],
      message: "A cycle requires SCC members",
    });
  }
  const collateralWeight = dependencies.edges
    .filter((edge) => edge.economicRole === "basket-exposure")
    .reduce((sum, edge) => sum + edge.weight, 0);
  if (collateralWeight > 1.000001) {
    ctx.addIssue({ code: "custom", path: ["edges"], message: "Collateral dependency weight cannot exceed 1" });
  }
}

const V9EffectiveDependenciesV2Schema = z
  .object({
    ...V9EffectiveDependenciesBaseFields,
    edges: canonicalArrayBy(V9EffectiveDependencyEdgeV2Schema, (edge) => edge.edgeKey),
  })
  .strict()
  .superRefine(validateDependencyEnvelope);
export type V9EffectiveDependenciesV2 = z.infer<typeof V9EffectiveDependenciesV2Schema>;

const V9EffectiveDependencyEdgeV3Schema = V9EffectiveDependencyEdgeBaseSchema.extend({
  pathKind: z.enum(["serial-dependency", "collateral-exposure", "local-component"]),
  economicRole: V9DependencyEconomicRoleSchema,
})
  .strict()
  .superRefine((edge, ctx) => {
    const expectedPathKind =
      edge.economicRole === "serial-claim"
        ? "serial-dependency"
        : edge.economicRole === "basket-exposure"
          ? "collateral-exposure"
          : "local-component";
    if (edge.pathKind !== expectedPathKind) {
      ctx.addIssue({
        code: "custom",
        path: ["pathKind"],
        message: `Dependency role ${edge.economicRole} requires ${expectedPathKind}`,
      });
    }
    if (edge.economicRole === "serial-claim") {
      if (edge.dependencyType === "collateral") {
        ctx.addIssue({ code: "custom", path: ["dependencyType"], message: "Serial claims cannot be collateral edges" });
      }
      if (edge.weight !== 1) {
        ctx.addIssue({ code: "custom", path: ["weight"], message: "Serial dependencies must have weight 1" });
      }
    } else if (edge.economicRole === "basket-exposure" && edge.dependencyType !== "collateral") {
      ctx.addIssue({
        code: "custom",
        path: ["dependencyType"],
        message: "Basket exposures must be collateral dependencies",
      });
    } else if (edge.economicRole !== "basket-exposure" && edge.dependencyType === "wrapper") {
      ctx.addIssue({ code: "custom", path: ["dependencyType"], message: "Wrapper edges must be serial claims" });
    }
    if (
      edge.economicRole !== "serial-claim" &&
      edge.economicRole !== "basket-exposure" &&
      edge.failureDomains.length === 0
    ) {
      ctx.addIssue({ code: "custom", path: ["failureDomains"], message: "Role dependencies require a failure domain" });
    }
    if (
      edge.economicRole !== "serial-claim" &&
      edge.economicRole !== "basket-exposure" &&
      edge.evidenceRefIds.length === 0
    ) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "Role dependencies require evidence" });
    }
  });

export const V9EffectiveDependenciesV3Schema = z
  .object({
    ...V9EffectiveDependenciesBaseFields,
    edges: canonicalArrayBy(V9EffectiveDependencyEdgeV3Schema, (edge) => edge.edgeKey),
  })
  .strict()
  .superRefine(validateDependencyEnvelope);
export type V9EffectiveDependenciesV3 = z.infer<typeof V9EffectiveDependenciesV3Schema>;

export const V9ReserveAssetClassSchema = ReserveAssetClassSchema;

const V9ReserveCompositionEvidenceClassSchema = z.enum(["independent", "issuer-attested", "static-validated"]);
const V9ReserveCompositionProvenanceSchema = z.enum(["live", "curated", "curated-fallback", "audited-fallback"]);

const V9ReserveExposureFactV2Schema = z
  .object({
    exposureKey: CanonicalTextSchema,
    classificationKey: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    provenance: V9ReserveCompositionProvenanceSchema,
    evidenceClass: V9ReserveCompositionEvidenceClassSchema.optional(),
    sourceKind: z.enum(["standing-structure", "portfolio-observation", "financial-report", "onchain-observation"]).optional(),
    scopeId: CanonicalTextSchema.optional(),
    status: V9FactStatusV2Schema,
    factorStatuses: V9ReserveFactorStatusesSchema.optional(),
    name: CanonicalTextSchema,
    weight: PositiveFractionSchema,
    trackedAssetId: CanonicalTextSchema.nullable(),
    assetClass: V9ReserveAssetClassSchema.nullable(),
    issuerOrObligorKey: CanonicalTextSchema.nullable(),
    riskFactors: CanonicalStringArraySchema,
    liquidityHorizon: z.enum(["immediate", "one-day", "seven-days", "over-seven-days", "unknown"]).nullable(),
    maturityDaysMax: z.number().int().nonnegative().nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((exposure, ctx) => {
    if (exposure.provenance === "live" && exposure.evidenceClass !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceClass"],
        message: "Live reserve exposure must not carry a static evidence class",
      });
    }
    if (exposure.provenance !== "live" && exposure.evidenceClass === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceClass"],
        message: "Curated reserve exposure requires an evidence class",
      });
    }
    if (exposure.status.observationState === "known" && exposure.status.applicability.state === "required") {
      if (exposure.assetClass === null && exposure.factorStatuses?.assetClass?.observationState === "known") {
        ctx.addIssue({ code: "custom", path: ["assetClass"], message: "Known asset-class factor requires asset class" });
      }
      const obligorStatus = exposure.factorStatuses?.obligorConcentration;
      const scopedUnknownObligor = exposure.assetClass !== null &&
        exposure.factorStatuses?.assetClass?.observationState === "known" &&
        exposure.issuerOrObligorKey === null && obligorStatus !== undefined &&
        obligorStatus.applicability.state === "required" &&
        obligorStatus.observationState !== "known" && obligorStatus.gapIds.length > 0;
      if (exposure.failureDomains.length === 0 && !scopedUnknownObligor) {
        ctx.addIssue({
          code: "custom",
          path: ["failureDomains"],
          message: "Known reserve exposure requires failure domains",
        });
      }
    }
  });
export type V9ReserveExposureFactV2 = z.infer<typeof V9ReserveExposureFactV2Schema>;

const V9RouteRequestV2Schema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    maxCostBps: z.number().finite().nonnegative(),
    settlementHorizonSec: z.number().int().positive(),
  })
  .strict();

const V9RouteCapacityPointV2Schema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    maxCostBps: z.number().finite().nonnegative(),
    executableUsd: NonNegativeUsdSchema,
    completionRatio: FractionSchema,
    executionCostBps: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .superRefine((point, ctx) => {
    if (point.executableUsd > point.requestedNotionalUsd + 0.01) {
      ctx.addIssue({ code: "custom", path: ["executableUsd"], message: "Executable value exceeds requested value" });
    }
    if (Math.abs(point.completionRatio - point.executableUsd / point.requestedNotionalUsd) > 0.00001) {
      ctx.addIssue({ code: "custom", path: ["completionRatio"], message: "Completion ratio is inconsistent" });
    }
    if (point.executableUsd > 0 && point.executionCostBps !== null && point.executionCostBps > point.maxCostBps) {
      ctx.addIssue({ code: "custom", path: ["executionCostBps"], message: "Execution cost exceeds the request limit" });
    }
  });

const CanonicalCapacityCurveSchema = canonicalArrayBy(
  V9RouteCapacityPointV2Schema,
  canonicalV9ExecutionCostKey,
);

const V9RouteOutputValuationV2Schema = z
  .object({
    basis: V9RouteValuationBasisSchema,
    referenceAssetKey: CanonicalTextSchema,
    unitValueUsd: z.number().finite().nonnegative(),
    expectedUnitValueUsd: z.number().finite().positive(),
    valueRetentionRatio: z.number().finite().nonnegative().max(2),
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    asOfSec: UnixSecondsSchema,
    confidence: V9RouteValuationConfidenceSchema,
    freshness: V9EvidenceFreshnessSchema,
    evidenceRefIds: CanonicalStringArraySchema,
  })
  .strict()
  .superRefine((valuation, ctx) => {
    if (valuation.unitValueUsd === 0 && valuation.basis !== "commodity-delivery") {
      ctx.addIssue({ code: "custom", path: ["unitValueUsd"], message: "Only physical delivery can have zero deliverable value" });
    }
    const expectedRatio = valuation.unitValueUsd / valuation.expectedUnitValueUsd;
    if (Math.abs(valuation.valueRetentionRatio - expectedRatio) > 0.000001) {
      ctx.addIssue({ code: "custom", path: ["valueRetentionRatio"], message: "Value retention is inconsistent" });
    }
  });

const V9RouteOutputV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    kind: z.union([V9RouteOutputKindSchema, z.literal("unknown")]),
    sameNotionalEligible: z.literal(false).optional(),
    unboundedDeliveryCap: z.number().finite().min(0).max(100).optional(),
    assetKeys: CanonicalStringArraySchema,
    basketWeights: canonicalArrayBy(
      z.object({ assetKey: CanonicalTextSchema, weight: PositiveFractionSchema }).strict(),
      (entry) => entry.assetKey,
    ),
    valuation: V9RouteOutputValuationV2Schema.nullable(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.kind === "physical-commodity-delivery" &&
        (output.sameNotionalEligible !== false || (output.valuation !== null && output.valuation.basis !== "commodity-delivery"))) {
      ctx.addIssue({ code: "custom", message: "Physical delivery is non-same-notional and requires commodity valuation" });
    }
    if (output.basketWeights.length > 0) {
      const total = output.basketWeights.reduce((sum, entry) => sum + entry.weight, 0);
      if (Math.abs(total - 1) > 0.000001) {
        ctx.addIssue({ code: "custom", path: ["basketWeights"], message: "Basket weights must sum to 1" });
      }
    }
    if (output.status.observationState === "known" || output.status.observationState === "stale") {
      if (output.kind === "unknown" || output.assetKeys.length === 0 || output.valuation === null) {
        ctx.addIssue({
          code: "custom",
          message: "Known or stale route output requires last-known identity and valuation",
        });
      }
    }
    if (
      output.status.observationState !== "known" &&
      output.status.observationState !== "stale" &&
      output.valuation !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["valuation"],
        message: "Unavailable output cannot carry active valuation",
      });
    }
  });

/**
 * Settlement-limit fragments shared by the compiled exit-route fact
 * (`V9ExitRouteFactV2`) and the producer-side route review
 * (`worker/src/lib/safety-score-v9/fact-set-schema.ts`), so the producer's
 * accepted/rejected set cannot drift from the published fact contract.
 */

/** Reviewed SLA bound on settlement completion; null encodes a reviewed "no SLA evidence". */
const V9RouteSettlementSlaSecSchema = z.number().int().nonnegative().nullable();

/** Reviewed USD settlement quantity; absent when unreviewed, null when reviewed as unavailable. */
const V9RouteSettlementUsdAmountSchema = NonNegativeUsdSchema.nullable().optional();

/**
 * Reviewed route facts shared by the compiled exit-route fact
 * (`V9ExitRouteFactV2`) and the producer-side route review
 * (`worker/src/lib/safety-score-v9/fact-set-schema.ts`), so the producer's
 * accepted/rejected set cannot drift from the published fact contract. The
 * producer extends this fragment and keeps its producer-only overlays local;
 * the compiled fact extends it with the compiled-only fields and checks below.
 */
export const V9ExitRouteFactBaseSchema = z
  .object({
    routeId: CanonicalTextSchema,
    lane: V9RouteLaneSchema,
    routeSuspension: RedemptionRouteSuspensionSchema.optional(),
    holderAccess: V9RouteHolderAccessSchema,
    executionModel: V9RouteExecutionModelSchema,
    executionCertainty: V9RouteExecutionCertaintySchema,
    // Retained schema-v2 facts and route reviews predate this field. Parse them
    // conservatively; current compilers still materialize the normalized value
    // in their output.
    modelConfidence: z.enum(["high", "medium", "low", "unknown"]).default("low"),
    /** Reviewed fee disclosure without a same-notional execution cost bound. */
    feeEvidence: z.enum(["undisclosed-reviewed", "disclosed-unquantified"]).optional(),
    coverageClass: V9RouteCoverageClassSchema,
    capacityScoringHorizon: RedemptionCapacityScoringHorizonSchema.optional(),
    settlementModel: V9RouteSettlementModelSchema,
    settlementSlaSec: V9RouteSettlementSlaSecSchema,
    queueDepthUsd: V9RouteSettlementUsdAmountSchema,
    dailyLimitUsd: V9RouteSettlementUsdAmountSchema,
    minRedeemUsd: V9RouteSettlementUsdAmountSchema,
    physicalResourceKeys: CanonicalStringArraySchema,
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();

const V9ExitRouteFactV2Schema = V9ExitRouteFactBaseSchema
  .extend({
    routeKey: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    routeFamily: ExitRouteFamilySchema,
    observationConfidence: ExitRouteConfidenceSchema,
    observationHistory: ExitRouteObservationHistorySchema.nullable().optional(),
    physicalToUsd: PhysicalToUsdTraceSchema.optional(),
    executionModelId: CanonicalTextSchema.optional(),
    executionCertificate: ExitExecutionCertificateSchema.optional(),
    evidenceKind: ExitRouteEvidenceKindSchema,
    /**
     * Carried from the route observation: the route is open but no evidence
     * bounds settlement completion, so capacity is a bounded evidence gap
     * rather than a measurement. Retained schema-v2 facts predate this field.
     */
    settlementBoundUnproven: z.boolean().optional(),
    settlementEvidenceRefIds: CanonicalStringArraySchema,
    status: V9FactStatusV2Schema,
    factorStatuses: V9ExitFactorStatusesSchema.optional(),
    capacityEvidenceTier: ExitRouteCapacityEvidenceTierSchema.optional(),
    scoreEligible: z.boolean(),
    request: V9RouteRequestV2Schema.nullable(),
    capacityCurve: CanonicalCapacityCurveSchema,
    output: V9RouteOutputV2Schema,
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.routeSuspension && (
      route.lane !== "redemption" || route.routeSuspension.routeId !== route.routeId ||
      route.scoreEligible || route.coverageClass !== "diagnostic" ||
      route.request !== null || route.capacityCurve.length !== 0
    )) {
      ctx.addIssue({ code: "custom", path: ["routeSuspension"], message: "A suspension is exact-route diagnostic evidence, never executable capacity" });
    }
    if (route.executionModelId && route.scoreEligible && !route.executionCertificate) {
      ctx.addIssue({ code: "custom", message: "Execution model lacks certificate" });
    }
    if (route.executionCertificate && route.scoreEligible) {
      const certificate = route.executionCertificate;
      if (certificate.modelId !== route.executionModelId ||
          certificate.settlement.maximumCompletionSec !== route.settlementSlaSec ||
          certificate.identity.outputAssetKeys.some((key) => !route.output.assetKeys.includes(key)) ||
          route.capacityCurve.some((point) => !certificate.points.some((proof) =>
            proof.requestedNotionalUsd === point.requestedNotionalUsd && proof.maxCostBps === point.maxCostBps &&
            proof.executableUsd === point.executableUsd && proof.executionCostBps === point.executionCostBps))) {
        ctx.addIssue({ code: "custom", message: "Compiled execution facts conflict with certificate" });
      }
    }
    const expectedKey = `${route.lane}:${route.sourceGenerationId}:${route.routeId}`;
    if (route.routeKey !== expectedKey) {
      ctx.addIssue({ code: "custom", path: ["routeKey"], message: `Canonical route key must be ${expectedKey}` });
    }
    const dexFamily = route.routeFamily === "dex-amm" || route.routeFamily === "dex-orderbook";
    if ((route.lane === "dex") !== dexFamily) {
      ctx.addIssue({ code: "custom", path: ["routeFamily"], message: "Route family does not match its lane" });
    }
    if (route.routeFamily === "eventual-redemption" && route.scoreEligible) {
      ctx.addIssue({ code: "custom", path: ["scoreEligible"], message: "Eventual redemption is diagnostic-only" });
    }
    const dexEvidence = new Set([
      "measured-executable-depth",
      "reserve-based-amm-simulation",
      "direct-orderbook-depth",
      "generic-tvl-proxy",
      "synthetic-or-fallback",
      "unobserved",
    ]);
    if ((route.lane === "dex") !== dexEvidence.has(route.evidenceKind)) {
      ctx.addIssue({ code: "custom", path: ["evidenceKind"], message: "Evidence kind does not match its lane" });
    }
    if (route.coverageClass === "diagnostic" && route.scoreEligible) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreEligible"],
        message: "Diagnostic coverage cannot be score eligible",
      });
    }
    if (route.status.observationState === "known" || route.status.observationState === "stale") {
      if (route.request === null || route.capacityCurve.length === 0) {
        ctx.addIssue({ code: "custom", message: "Observed routes require request and capacity facts" });
      }
    }
    if (route.status.observationState === "known" && route.failureDomains.length === 0) {
      ctx.addIssue({ code: "custom", path: ["failureDomains"], message: "Known route requires failure domains" });
    }
    if (route.status.observationState === "known" && route.scoreEligible) {
      if (
        route.physicalResourceKeys.length === 0 ||
        route.settlementEvidenceRefIds.length === 0 ||
        (route.settlementModel !== "atomic" && route.settlementSlaSec === null)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Score-eligible route lacks resource identity or settlement evidence",
        });
      }
    }
  });
export type V9ExitRouteFactV2 = z.infer<typeof V9ExitRouteFactV2Schema>;

/**
 * Authority and custody fragments shared by the compiled control fact
 * (`V9DeploymentControlFactV2`) and the producer-side control review overlay
 * (`worker/src/lib/safety-score-v9/fact-set-schema.ts`), so a new
 * authority-ladder rung cannot diverge between review validation and the
 * published fact contract.
 */
const V9ControlAuthoritySchema = z
  .object({
    authorityKey: CanonicalTextSchema,
    // AUTHORITY-LADDER 9.46: `validator-quorum` is an external
    // message-validation quorum (LayerZero DVN set, CCIP DON/RMN, Bantu AMTP
    // group, IBC light-client validator set). Known-but-weak: it grades at or
    // below `issuer-backend` and never above a named multisig.
    model: z.enum([
      "none",
      "eoa",
      "multisig",
      "governance",
      "contract",
      "issuer-backend",
      "validator-quorum",
      "chain-consensus",
      "unknown",
    ]),
    threshold: z
      .object({ required: z.number().int().positive(), total: z.number().int().positive() })
      .strict()
      .nullable(),
    weightedQuorum: V9WeightedQuorumSchema.optional(),
    sameChainSystemTransport: V9SameChainSystemTransportSchema.optional(),
  })
  .strict()
  .superRefine((authority, ctx) => {
    if (authority.weightedQuorum && (authority.model !== "multisig" || authority.threshold !== null || authority.authorityKey !== authority.weightedQuorum.deployment)) {
      ctx.addIssue({ code: "custom", message: "Weighted authority conflicts with uniform quorum or exact deployment" });
    }
    if ((authority.model === "chain-consensus") !== (authority.sameChainSystemTransport != null)) {
      ctx.addIssue({ code: "custom", message: "Chain consensus requires its exact same-chain system transport identity" });
    }
    if (authority.sameChainSystemTransport && (authority.threshold !== null || authority.weightedQuorum != null || authority.authorityKey !== "consensus:hyperliquid")) {
      ctx.addIssue({ code: "custom", message: "Same-chain transport cannot claim a signing quorum or independent authority" });
    }
  })
  .nullable();

/** Reviewed key-custody attestation for the authority holding this control. An
 * attested MPC/HSM key is an operationally different object from a bare
 * externally-owned key even though both present as one address on chain. */
const V9KeyCustodySchema = z.enum(["mpc", "hsm", "unknown"]).default("unknown");

/** Reviewed Safe module/guard surface. "none-detected" is positive evidence that
 * no side-door module bypasses the quorum; "present" is a reviewed extension
 * surface; "unknown" fails conservative. */
const V9ModulesOrGuardsSchema = z.enum(["present", "none-detected", "not-applicable", "unknown"]).default("unknown");

const V9IncidentStateSchema = z.enum(["none", "active", "resolved", "unknown"]);

const V1005ProcessReasonSchema = z.enum([
  "process-certificate-unavailable", "authority-census-incomplete", "execution-scope-unreviewed",
  "runtime-unmatched", "implementation-unmatched", "instance-state-unmatched", "authority-state-changed", "authority-state-mismatch",
  "execution-class-unmatched", "economic-reach-unclosed", "graph-reference-unresolved", "graph-cycle-unclosed",
  "governor-control-missing", "governor-not-governance", "governor-without-issuance-path", "governor-without-veto-path",
  "governor-carries-unbounded-path", "discretionary-root-independent", "delay-unproved", "delay-too-short",
  "voting-power-inadmissible", "issuance-not-enumerable", "operational-path-unclassified", "operational-cap-unproved",
  "operational-screen-failed", "operational-decision-rule-inadmissible", "formula-principal-unproved",
  "formula-time-unproved", "formula-beneficiary-unproved", "rate-units-unproved", "interest-aggregate-unproved",
  "keeper-activity-unproved", "aggregate-flow-unproved", "voting-control-unproved", "voting-affiliated-unilateral",
  "shared-book-unresolved", "shared-book-mismatch", "shared-book-stale",
  "voting-privilege-independent", "voting-census-unreconciled", "voting-provenance-unknown", "voting-other-holder-operator", "voting-origin-cycle-unclosed",
  "review-incomplete", "review-future", "review-expired", "scoped-question-open", "active-incident",
  "monetary-policy-path-unreviewed", "monetary-policy-path-inadmissible", "restructure-path-missing",
  "restructure-reachable", "restructure-dependent-path-invalid",
  "external-accounting-trust",
]);
const ProcessUint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ProcessCount = z.number().finite().int().nonnegative().safe();
export const V1005ProcessDiagnosticObjectSchema = z.object({
  code: V1005ProcessReasonSchema, gate: z.enum(["shared", "D29", "D30", "D32", "H0", "H1", "H2", "H3", "H4"]),
  controlRef: DeploymentIdSchema.nullable(), pathId: CanonicalTextSchema.nullable(),
  classId: CanonicalTextSchema.nullable(), memberRef: DeploymentIdSchema.nullable(),
  field: CanonicalTextSchema, evidenceRefIds: z.array(CanonicalTextSchema),
  /** Evaluator diagnostics reference the asset process's complete evidence table instead of copying it. */
  issuanceFactsRef: CanonicalTextSchema.optional(),
}).strict();
const V1005ProcessDiagnosticSchema = V1005ProcessDiagnosticObjectSchema.superRefine((row, ctx) => {
  if (row.issuanceFactsRef !== undefined && row.evidenceRefIds.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["evidenceRefIds"], message: "Referenced process diagnostics cannot duplicate inline evidence" });
  }
});
export const V1005CompiledVotingControlSchema = z.object({
  observationState: z.enum(["known", "unknown"]), qualified: z.boolean(),
  largestSingleControllerShareBps: z.number().int().min(0).max(10000).nullable(),
  affiliatedAggregateShareBps: z.number().int().min(0).max(10000).nullable(),
  affiliatedUnilateralRouteIds: z.array(CanonicalTextSchema),
  unknownAboveThresholdVoteOwnershipControllerIds: z.array(CanonicalTextSchema),
  otherHolderVoteOperatorControllerIds: z.array(CanonicalTextSchema),
  privilegedVoteCreation: z.enum(["none", "governor-only", "independent", "unknown"]),
  forcedDelegation: z.enum(["none", "governor-only", "independent", "unknown"]),
  censusReconciliations: z.array(z.object({
    routeId: CanonicalTextSchema, state: z.enum(["reconciled", "unreconciled"]),
    accountedPowerRaw: ProcessUint.nullable(), residualUpperRaw: ProcessUint.nullable(),
    totalVotingPowerRaw: ProcessUint.nullable(), pinnedVotingSupplyRaw: ProcessUint.nullable(),
    unresolvedResidualCanPassAlone: z.union([z.boolean(), z.literal("unknown")]),
    evidenceRefIds: z.array(CanonicalTextSchema),
  }).strict()).min(1), diagnostics: z.array(V1005ProcessDiagnosticSchema),
}).strict().superRefine((row, ctx) => {
  for (const [index, reconciliation] of row.censusReconciliations.entries()) {
    if (reconciliation.state === "reconciled" && (reconciliation.accountedPowerRaw === null || reconciliation.residualUpperRaw === null ||
        reconciliation.totalVotingPowerRaw === null || reconciliation.pinnedVotingSupplyRaw === null ||
        BigInt(reconciliation.accountedPowerRaw) + BigInt(reconciliation.residualUpperRaw) !== BigInt(reconciliation.totalVotingPowerRaw) ||
        reconciliation.totalVotingPowerRaw !== reconciliation.pinnedVotingSupplyRaw)) {
      ctx.addIssue({ code: "custom", path: ["censusReconciliations", index], message: "Reconciled voting census requires exact conserved pinned power" });
    }
  }
  if (row.observationState === "known" && row.censusReconciliations.some((entry) => entry.state !== "reconciled" || entry.pinnedVotingSupplyRaw === "0" || entry.unresolvedResidualCanPassAlone === "unknown")) {
    ctx.addIssue({ code: "custom", path: ["observationState"], message: "Known voting control requires complete reconciliations and residual thresholds" });
  }
  if (row.qualified && (row.observationState !== "known" || row.diagnostics.length !== 0 ||
      row.affiliatedUnilateralRouteIds.length !== 0 || row.unknownAboveThresholdVoteOwnershipControllerIds.length !== 0 ||
      row.otherHolderVoteOperatorControllerIds.length !== 0 || !["none", "governor-only"].includes(row.privilegedVoteCreation) ||
      !["none", "governor-only"].includes(row.forcedDelegation) || row.censusReconciliations.some((entry) => entry.unresolvedResidualCanPassAlone !== false))) {
    ctx.addIssue({ code: "custom", path: ["qualified"], message: "Qualified voting control cannot retain fatal or unresolved voting gates" });
  }
});
export const V1005IssuanceProcessObjectSchema = z.object({
  kind: z.literal("affirmative-operational-flow"), coverage: z.enum(["complete", "incomplete"]),
  authorityCoverage: z.enum(["complete", "incomplete"]), executionCoverage: z.enum(["complete", "incomplete"]),
  economicReachClosed: z.boolean(), inventoryComplete: z.boolean(),
  memberCount: ProcessCount, matchedMemberCount: ProcessCount, unknownMemberCount: ProcessCount,
  discretionaryPathCount: ProcessCount, operationalPathCount: ProcessCount, formulaPathCount: ProcessCount,
  keeperInitialPathCount: ProcessCount, keeperRecurringPathCount: ProcessCount, fundedKeeperRecurringPathCount: ProcessCount, otherOperationalPathCount: ProcessCount,
  envelopeTransitionPathCount: ProcessCount,
  nonGovernorDiscretionaryPathKeys: z.array(CanonicalTextSchema), unclassifiedExpansionPathKeys: z.array(CanonicalTextSchema),
  unknownRecipientPathKeys: z.array(CanonicalTextSchema),
  minDiscretionaryPublicDelaySec: ProcessCount.nullable(), minEnvelopeRaisePublicDelaySec: ProcessCount.nullable(),
  minOperationalExerciseDelaySec: ProcessCount.nullable(),
  formulaQualified: z.boolean(), keeperQualified: z.boolean(), otherClassesQualified: z.boolean(),
  maxAnnualInterestGrowthPpm: ProcessCount.nullable(), maxKeeperProportionalRewardPpm: ProcessCount.nullable(),
  maxKeeperFixedRewardSupplyPpm: z.number().finite().nonnegative().nullable(),
  minKeeperRecurringIntervalSec: ProcessCount.nullable(), maxKeeperRepeatRewardSupplyPpmPer86400Sec: ProcessCount.nullable(),
  keeperSupplyScreenBasis: z.object({
    nativeSupplyRaw: ProcessUint.nullable(), maxFixedRewardRaw: ProcessUint.nullable(),
    maxRepeatRewardRawPer86400Sec: ProcessUint.nullable(), nativeUnits: CanonicalTextSchema,
  }).strict().nullable(),
  votingControl: V1005CompiledVotingControlSchema, diagnostics: z.array(V1005ProcessDiagnosticSchema),
  evidenceRefIds: z.array(CanonicalTextSchema), sourceGenerationId: CanonicalTextSchema,
  freshnessBudgetSec: ProcessCount, observedAtSec: ProcessCount.nullable(), expiresAtSec: ProcessCount.nullable(),
}).strict();
export const V1005IssuanceProcessSchema = V1005IssuanceProcessObjectSchema.superRefine((row, ctx) => {
  if (row.matchedMemberCount + row.unknownMemberCount !== row.memberCount) ctx.addIssue({ code: "custom", path: ["memberCount"], message: "Process member counts must conserve the exact census" });
  if (row.formulaPathCount + row.keeperInitialPathCount + row.keeperRecurringPathCount + row.otherOperationalPathCount !== row.operationalPathCount) ctx.addIssue({ code: "custom", path: ["operationalPathCount"], message: "Operational category counts must conserve paths" });
  if (row.fundedKeeperRecurringPathCount > row.keeperRecurringPathCount) ctx.addIssue({ code: "custom", path: ["fundedKeeperRecurringPathCount"], message: "Funded recurrence is a subset of recurring paths" });
  if (row.fundedKeeperRecurringPathCount === 0 && row.minKeeperRecurringIntervalSec !== null) ctx.addIssue({ code: "custom", path: ["minKeeperRecurringIntervalSec"], message: "Absent funded recurrence has no reward clock" });
  if (row.envelopeTransitionPathCount === 0 && row.minEnvelopeRaisePublicDelaySec !== null) ctx.addIssue({ code: "custom", path: ["minEnvelopeRaisePublicDelaySec"], message: "Absent envelope transitions have no raise clock" });
  const basis = row.keeperSupplyScreenBasis;
  if (row.fundedKeeperRecurringPathCount === 0 && (basis?.maxRepeatRewardRawPer86400Sec != null && BigInt(basis.maxRepeatRewardRawPer86400Sec) > 0n ||
      row.maxKeeperRepeatRewardSupplyPpmPer86400Sec !== null && row.maxKeeperRepeatRewardSupplyPpmPer86400Sec > 0)) ctx.addIssue({ code: "custom", path: ["fundedKeeperRecurringPathCount"], message: "No funded recurrence cannot retain a positive repeated reward upper" });
  if (basis?.nativeSupplyRaw != null && BigInt(basis.nativeSupplyRaw) > 0n && basis.maxRepeatRewardRawPer86400Sec != null && row.maxKeeperRepeatRewardSupplyPpmPer86400Sec !== null) {
    const denominator = BigInt(basis.nativeSupplyRaw);
    const expected = (BigInt(basis.maxRepeatRewardRawPer86400Sec) * 1000000n + denominator - 1n) / denominator;
    if (BigInt(row.maxKeeperRepeatRewardSupplyPpmPer86400Sec) !== expected) ctx.addIssue({ code: "custom", path: ["maxKeeperRepeatRewardSupplyPpmPer86400Sec"], message: "Repeat ppm must equal the upward exact raw-unit ratio" });
  }
  if (row.coverage === "complete" && (row.authorityCoverage !== "complete" || row.executionCoverage !== "complete" ||
      !row.economicReachClosed || !row.inventoryComplete || row.unknownMemberCount !== 0 ||
      row.discretionaryPathCount === 0 || row.operationalPathCount === 0 ||
      row.nonGovernorDiscretionaryPathKeys.length !== 0 || row.unclassifiedExpansionPathKeys.length !== 0 ||
      row.unknownRecipientPathKeys.length !== 0 || !row.formulaQualified || !row.keeperQualified || !row.otherClassesQualified ||
      !row.votingControl.qualified || row.diagnostics.some((diagnostic) => diagnostic.code !== "external-accounting-trust") || row.minDiscretionaryPublicDelaySec === null ||
      (row.envelopeTransitionPathCount > 0 && row.minEnvelopeRaisePublicDelaySec === null) || row.minOperationalExerciseDelaySec === null ||
      (row.formulaPathCount > 0 && row.maxAnnualInterestGrowthPpm === null) ||
      (row.keeperInitialPathCount + row.keeperRecurringPathCount > 0 && (row.maxKeeperProportionalRewardPpm === null ||
        row.maxKeeperFixedRewardSupplyPpm === null || row.keeperSupplyScreenBasis?.nativeSupplyRaw == null)) ||
      (row.fundedKeeperRecurringPathCount > 0 && row.minKeeperRecurringIntervalSec === null) ||
      (row.keeperRecurringPathCount > 0 && row.maxKeeperRepeatRewardSupplyPpmPer86400Sec === null))) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "Complete process requires every structural proof and relevant measurement" });
  }
});
export type V1005ProcessDiagnostic = z.output<typeof V1005ProcessDiagnosticSchema>;
export type V1005CompiledVotingControl = z.output<typeof V1005CompiledVotingControlSchema>;
export type V1005IssuanceProcess = z.output<typeof V1005IssuanceProcessSchema>;

export const V9IssuanceGovernanceObjectSchema = z
  .object({
    coverage: z.enum(["complete", "incomplete"]),
    incompleteReasons: CanonicalStringArraySchema,
    governorAuthorityKey: CanonicalTextSchema,
    decisionRule: z.enum(["affirmative-vote", "minority-veto"]),
    minUnavoidableDelaySec: z.number().finite().int().nonnegative().nullable(),
    votingPower: z.enum(["holding-period-weighted", "lock-escrowed", "past-block-checkpoint", "live-balance", "unknown"]),
    vetoQuorumBps: z.number().int().min(1).max(10000).nullable(),
    vetoOverride: z.enum(["none", "symmetric-vote-destruction", "insolvency-gated-restructure", "unknown"]).nullable(),
    enumerable: z.boolean(),
    nonGovernorUnboundedPathKeys: CanonicalStringArraySchema,
    votingControl: V1005CompiledVotingControlSchema,
    diagnostics: z.array(V1005ProcessDiagnosticSchema),
  })
  .strict();
const V9IssuanceGovernanceSchema = V9IssuanceGovernanceObjectSchema.superRefine((governance, ctx) => {
    for (const field of ["vetoQuorumBps", "vetoOverride"] as const) {
      if ((governance.decisionRule === "affirmative-vote") !== (governance[field] === null)) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be null if and only if decisionRule is affirmative-vote`,
          path: [field],
        });
      }
    }
    if ((governance.coverage === "complete") !== (governance.incompleteReasons.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "Issuance governance incompleteReasons must be empty if and only if coverage is complete",
        path: ["incompleteReasons"],
      });
    }
  });

/** Asset-wide proof data is serialized once; native control rows bind its exact identity. */
const V1005AssetIssuanceFactsSchema = z.object({
  ref: CanonicalTextSchema,
  governance: V9IssuanceGovernanceSchema.optional(),
  process: V1005IssuanceProcessSchema.optional(),
  diagnostics: z.array(V1005ProcessDiagnosticSchema),
}).strict().superRefine((facts, ctx) => {
  if ((!facts.governance && !facts.process && facts.diagnostics.length === 0) ||
      (facts.process && facts.governance?.decisionRule !== "affirmative-vote")) {
    ctx.addIssue({ code: "custom", path: ["governance"], message: "Issuance facts need real governance or diagnostics; operational process requires affirmative governance" });
  }
});
export type V1005AssetIssuanceFacts = z.output<typeof V1005AssetIssuanceFactsSchema>;

const admittedIssuanceFacts = new WeakSet<object>();

function isAdmittedIssuanceFacts(value: unknown): value is V1005AssetIssuanceFacts {
  return value !== null && typeof value === "object" && Object.isFrozen(value) && admittedIssuanceFacts.has(value);
}

/** Keep the asset-wide proof graph shared across strict extension and compiled-asset admission. */
export const V1005InProcessAssetIssuanceFactsSchema = z.union([
  z.custom<V1005AssetIssuanceFacts>(isAdmittedIssuanceFacts),
  V1005AssetIssuanceFactsSchema.transform((facts) => {
    const admitted = createV9ValueInterner()(facts);
    deepFreeze(admitted);
    admittedIssuanceFacts.add(admitted);
    return admitted;
  }),
]);

/**
 * Reviewed control posture shared by the compiled control fact
 * (`V9DeploymentControlFactV2`) and the producer-side control review overlay
 * (`worker/src/lib/safety-score-v9/fact-set-schema.ts`): every compiled field
 * except the two the compiler adds (`sourceGenerationId`, `status`). The
 * producer extends this fragment instead of re-declaring the shape, and the
 * compiled fact extends it with the compiled-only fields and checks below.
 */
export const V9DeploymentControlFactBaseSchema = z
  .object({
    controlKey: CanonicalTextSchema,
    deploymentKey: CanonicalTextSchema,
    // Optional only for retained fact compatibility. Current compilers emit
    // the tracked native asset that owns a reused controller when reviewed.
    controllerAssetId: CanonicalTextSchema.nullable().optional(),
    controlKind: V9ControlKindSchema,
    scope: V9ControlScopeSchema,
    capabilities: canonicalArrayBy(V9ControlCapabilitySchema, (capability) => capability),
    capSemantics: V9ControlCapSemanticsSchema,
    claimImpairment: V9ClaimImpairmentSchema,
    economicLossScope: V9EconomicLossScopeSchema,
    authority: V9ControlAuthoritySchema,
    delaySec: z.number().int().nonnegative().nullable(),
    materialSupplyShare: FractionSchema.nullable(),
    // A reviewer authored a scoped open question naming this control, and that
    // review is fresh at compile time. Grants the bounded scoped-gap ceiling
    // instead of the control-unverified ceiling while the question stays open.
    scopedQuestionFresh: z.boolean().optional(),
    keyCustody: V9KeyCustodySchema,
    modulesOrGuards: V9ModulesOrGuardsSchema,
    executionScope: V9InProcessControlExecutionScopeSchema.optional(),
    /** Selected path on an execution-complete split fact; the full certificate still owns closure. */
    executionPathId: CanonicalTextSchema.optional(),
    executionScopeContributors: z.array(z.object({ authorityKey: CanonicalTextSchema, scope: V9InProcessControlExecutionScopeSchema.optional() }).strict()).min(1).optional(),
    executionScopeComplete: z.boolean().optional(),
    scopeDiagnostics: CanonicalStringArraySchema.optional(),
    moduleImpact: V9ExactControlPolicySchema.shape.moduleImpactStates.element.optional(),
    issuanceFactsRef: CanonicalTextSchema.optional(),
    issuanceGovernance: V9IssuanceGovernanceSchema.optional(),
    issuanceProcess: V1005IssuanceProcessSchema.optional(),
    processDiagnostics: z.array(V1005ProcessDiagnosticSchema).optional(),
    incidentState: V9IncidentStateSchema,
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();

const V9DeploymentControlFactV2Schema = V9DeploymentControlFactBaseSchema
  .extend({
    sourceGenerationId: CanonicalTextSchema,
    status: V9FactStatusV2Schema,
    factorStatuses: V9ControlFactorStatusesSchema.optional(),
  })
  .strict()
  .superRefine((control, ctx) => {
    if (control.issuanceFactsRef !== undefined &&
        (control.controlKind === "bridge" || control.issuanceGovernance !== undefined ||
          control.issuanceProcess !== undefined || control.processDiagnostics !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["issuanceFactsRef"], message: "Native issuance references cannot duplicate inline governance, process or diagnostics" });
    }
    if (control.authority?.model === "multisig") {
      if (!control.authority.weightedQuorum && (!control.authority.threshold || control.authority.threshold.required > control.authority.threshold.total)) {
        ctx.addIssue({ code: "custom", path: ["authority", "threshold"], message: "Multisig threshold is invalid" });
      }
    } else if (control.authority?.threshold !== null && control.authority !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["authority", "threshold"],
        message: "Only multisig controls use thresholds",
      });
    }
    if (control.status.observationState === "known" && control.status.applicability.state === "required") {
      if (control.authority === null || control.failureDomains.length === 0) {
        ctx.addIssue({ code: "custom", message: "Known required controls need authority and failure-domain identity" });
      }
      if (
        (control.capSemantics.kind === "unknown" && (control.factorStatuses?.capAuthority?.observationState ?? "known") === "known") ||
        (control.claimImpairment === "unknown" && (control.factorStatuses?.claimImpairment?.observationState ?? "known") === "known") ||
        (control.economicLossScope === "unknown" && (control.factorStatuses?.economicLossScope?.observationState ?? "known") === "known")
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Known required controls need reviewed cap and economic-loss semantics",
        });
      }
    }
    if (control.capSemantics.kind === "bounded" && control.capSemantics.bound === null) {
      ctx.addIssue({ code: "custom", path: ["capSemantics", "bound"], message: "Bounded control requires a bound" });
    }
    if (control.capSemantics.kind === "not-applicable" && control.capSemantics.bound !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["capSemantics", "bound"],
        message: "Not-applicable cap cannot carry a bound",
      });
    }
    if (control.capSemantics.bound?.unit === "supply-fraction" && control.capSemantics.bound.amount > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["capSemantics", "bound", "amount"],
        message: "Supply-fraction bound cannot exceed 1",
      });
    }
    if ((control.claimImpairment === "none") !== (control.economicLossScope === "access-only")) {
      ctx.addIssue({
        code: "custom",
        path: ["economicLossScope"],
        message: "Access-only scope must be explicitly non-claim-impairing",
      });
    }
    if (
      control.capabilities.length === 1 &&
      control.capabilities[0] === "freeze" &&
      (control.claimImpairment !== "none" || control.economicLossScope !== "access-only")
    ) {
      ctx.addIssue({ code: "custom", message: "Freeze-only posture cannot be classified as claim-impairing" });
    }
  });
export type V9DeploymentControlFactV2 = z.infer<typeof V9DeploymentControlFactV2Schema>;

const V9UpgradeControlReviewV2Schema = z
  .object({
    state: z.enum(["immutable", "not-applicable", "reviewed", "unknown"]),
    controlKey: CanonicalTextSchema.nullable(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if ((review.state === "reviewed") !== (review.controlKey !== null)) {
      ctx.addIssue({ code: "custom", path: ["controlKey"], message: "Reviewed upgrade posture requires a control" });
    }
  });

const V9MintMechanismReviewV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    factorStatuses: V9ControlFactorStatusesSchema.optional(),
    controlKey: CanonicalTextSchema.nullable(),
    // MINT-LADDER 9.32 (2026-08-21): `none` records a reviewer-confirmed
    // absence of any reconciliation regime, distinct from unverified `unknown`.
    reconciliation: z.enum(["continuous", "periodic", "internal-ledger", "none", "not-applicable", "unknown"]),
    // Prudential supervision is a reviewed fact, never inferred. Under R3 a
    // reconciled unbounded mint emits no centralized-mint cap only when a
    // per-coin review establishes a prudential supervisory regime; unknown
    // supervision remains on the fail-closed high rung.
    supervision: z.enum(["prudential", "attestation-only", "none", "unknown"]).default("unknown"),
    // Epoch second of the most recent *resolved* mint incident, or null when the
    // review records none. Active incidents keep their own critical path via the
    // control row's `incidentState`; this carries only the resolved history so a
    // resolved exploit can decay rather than disappear. Absolute (not an age) so
    // the fact stays byte-stable between compilation cycles; the evaluator
    // converts it to an age against the evaluation clock.
    latestResolvedIncidentAtSec: z.number().int().nonnegative().nullable().default(null),
    upgrade: V9UpgradeControlReviewV2Schema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.status.applicability.state === "not-applicable") {
      if (review.controlKey !== null || review.reconciliation !== "not-applicable") {
        ctx.addIssue({ code: "custom", message: "Not-applicable mint review cannot claim mint facts" });
      }
    }
  });

const V9OracleBranchKindV2Schema = z.enum([
  "feed",
  "collateral-parameter",
  "liquidation",
  "backstop",
  "shutdown-bad-debt",
]);

const V9OracleBranchReviewV2Schema = z
  .object({
    branch: V9OracleBranchKindV2Schema,
    status: V9FactStatusV2Schema,
    controlKey: CanonicalTextSchema.nullable(),
    mechanismKey: CanonicalTextSchema.nullable(),
    inheritedFromAssetId: CanonicalTextSchema.nullable(),
  })
  .strict();

const V9OracleControlReviewV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    factorStatuses: V9ControlFactorStatusesSchema.optional(),
    tier: z.enum(ORACLE_RISK_TIER_VALUES).nullable(),
    // Current verified topology of positively applicable paths, independent of
    // unresolved sibling inventory. It cannot describe an unreviewed sibling.
    knownPathTier: z.enum(ORACLE_RISK_TIER_VALUES).optional(),
    liquidationBranchesApplicable: z.boolean().optional(),
    branches: canonicalArrayBy(V9OracleBranchReviewV2Schema, (branch) => branch.branch),
    paths: canonicalArrayBy(
      z.object({
        id: CanonicalTextSchema,
        chain: CanonicalChainIdSchema,
        address: CanonicalTextSchema,
        branchId: CanonicalTextSchema.nullable(),
        applicability: V9FactStatusV2Schema.shape.applicability,
        observationState: V9ObservationStateSchema,
      }).strict(),
      (path) => path.id,
    ).optional(),
    // Worst severity band contributed by weak market branches whose measured
    // debt share is below the deployment-materiality threshold. These branches
    // do not drive the (material-only) top-level tier; the control lane surfaces
    // them as a single non-binding oracle diagnostic. Absent when the oracle
    // branch-materiality lever is inactive or no sub-material weak branch exists.
    subMaterialWeakBand: z.enum(["moderate", "low"]).optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.knownPathTier !== undefined && !review.paths?.some((path) =>
      path.applicability.state === "required" && path.observationState === "known",
    )) {
      ctx.addIssue({ code: "custom", path: ["knownPathTier"], message: "Known-path oracle tier requires a positively applicable reviewed path" });
    }
    if (
      review.status.applicability.state === "not-applicable" &&
      (review.tier !== null || review.branches.length > 0)
    ) {
      ctx.addIssue({ code: "custom", message: "Not-applicable oracle review cannot claim oracle facts" });
    }
    if (
      review.status.observationState === "known" &&
      review.status.applicability.state === "required" &&
      review.tier === null &&
      (review.factorStatuses?.tier?.observationState ?? "known") === "known"
    ) {
      ctx.addIssue({ code: "custom", path: ["tier"], message: "Known required oracle review needs a tier" });
    }
  });

const V9BridgeRouteControlReviewV2Schema = z
  .object({
    controlKey: CanonicalTextSchema,
    tier: z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES),
    factorStatuses: V9ControlFactorStatusesSchema.optional(),
  })
  .strict();

/**
 * ODR-D5a: a selected supply row the producer cannot show joined to one proven
 * bridge control. Only rows the evaluator's completeness proof can actually
 * fail on are recorded — the tolerated sub-threshold branches (RULED D-J pool,
 * sub-material unmatched dust) are omitted, so this stays empty for a clean
 * asset and names the residue for a carrier. Diagnostic only: nothing here
 * reaches a score, a reason, or a cap.
 */
const V9BridgeSupplyRouteJoinV1Schema = z
  .object({
    deploymentRouteKey: CanonicalTextSchema,
    reviewState: z.enum(["selected-reviewed", "selected-unresolved", "unmatched"]),
    reviewedRouteKind: z.enum(["native", "controlled"]).nullable(),
    supplyShare: FractionSchema,
    joinedControlKeys: CanonicalStringArraySchema,
    /** Null when the row joins no single control to describe. */
    joinedControlSemanticsResolved: z.boolean().nullable(),
    joinedControlSupplyShare: FractionSchema.nullable(),
  })
  .strict();
export type V9BridgeSupplyRouteJoinV1 = z.infer<typeof V9BridgeSupplyRouteJoinV1Schema>;

export const V9BridgeJoinDiagnosticsV1Schema = z
  .object({
    profileRouteCount: z.number().int().nonnegative(),
    canonicalSupplyRowCount: z.number().int().nonnegative(),
    unmatchedRowIdentities: CanonicalStringArraySchema,
    reviewedNativeCoverage: z
      .object({
        reviewedRowCount: z.number().int().nonnegative(),
        canonicalSupplyRowCount: z.number().int().nonnegative(),
        supplyShare: FractionSchema,
        complete: z.boolean(),
      })
      .strict(),
    bridgeClaimControls: CanonicalStringArraySchema,
    applicabilityBranch: z.enum(["native-only-not-applicable", "applicable"]),
    // Retained facts predate this field; an absent list is "not recorded",
    // which is why it defaults to empty rather than being required.
    unprovenRouteJoins: canonicalArrayBy(
      V9BridgeSupplyRouteJoinV1Schema,
      (row) => row.deploymentRouteKey,
    ).default([]),
  })
  .strict();
export type V9BridgeJoinDiagnosticsV1 = z.infer<typeof V9BridgeJoinDiagnosticsV1Schema>;

const V9BridgeControlReviewV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    factorStatuses: V9ControlFactorStatusesSchema.optional(),
    routes: canonicalArrayBy(V9BridgeRouteControlReviewV2Schema, (route) => route.controlKey),
    // Optional so retained V2 facts remain parseable. Current bridge review
    // producers emit this when a profile-backed applicability decision runs.
    diagnostics: V9BridgeJoinDiagnosticsV1Schema.optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.status.applicability.state === "not-applicable" && review.routes.length > 0) {
      ctx.addIssue({ code: "custom", path: ["routes"], message: "Not-applicable bridge review cannot claim routes" });
    }
  });

export const V9EconomicControlReviewV2Schema = z
  .object({
    mint: V9MintMechanismReviewV2Schema,
    oracle: V9OracleControlReviewV2Schema,
    bridge: V9BridgeControlReviewV2Schema,
  })
  .strict();
export type V9EconomicControlReviewV2 = z.infer<typeof V9EconomicControlReviewV2Schema>;

const V9TransferAccessReviewV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    posture: z.enum(["permissionless", "restrictable", "permissioned"]).nullable(),
    scopeBasis: z.literal("attributed").optional(),
    /**
     * Owner ruling 2026-08-10 (same shape as the freeze `structuralDisposition`
     * below): the reviewed-deployment scope machinery is contract-addressed, so
     * an asset that has no contract deployment by design cannot ever satisfy it.
     * `non-contract-native` = the reviewed surface lies entirely outside the
     * contract-addressable chain registry and no material supply sits on an
     * addressable chain, so the curated review IS the complete deployment scope.
     * The disposition records the applicability basis for a known transfer fact;
     * it never manufactures one where no current curated review exists.
     */
    structuralDisposition: z.enum(["non-contract-native"]).optional(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      review.status.observationState === "known" &&
      review.status.applicability.state === "required" &&
      review.posture === null
    ) {
      ctx.addIssue({ code: "custom", path: ["posture"], message: "Known transfer review requires a posture" });
    }
    if (review.status.applicability.state === "not-applicable" && review.posture !== null) {
      ctx.addIssue({ code: "custom", path: ["posture"], message: "Not-applicable transfer review has no posture" });
    }
    if (review.structuralDisposition !== undefined && review.status.observationState !== "known") {
      ctx.addIssue({
        code: "custom",
        path: ["structuralDisposition"],
        message: "Structural transfer disposition requires a known reviewed fact",
      });
    }
    if (review.scopeBasis === "attributed" && review.status.observationState !== "known") {
      ctx.addIssue({ code: "custom", path: ["scopeBasis"], message: "Attributed transfer scope requires a known fact" });
    }
  });

const V9FreezeAccessReviewV2Schema = z
  .object({
    reviewKey: CanonicalTextSchema,
    source: z.enum(["blacklist", "freeze", "pause", "upstream"]),
    status: V9FactStatusV2Schema,
    reach: z.enum(["none", "individual", "system-wide", "possible", "unknown"]),
    controlKey: CanonicalTextSchema.nullable(),
    upstreamAssetId: CanonicalTextSchema.nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if ((review.source === "upstream") !== (review.upstreamAssetId !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["upstreamAssetId"],
        message: "Only upstream freeze reviews identify an upstream asset",
      });
    }
    if (
      review.status.observationState === "known" &&
      review.status.applicability.state === "required" &&
      review.reach === "unknown"
    ) {
      ctx.addIssue({ code: "custom", path: ["reach"], message: "Known freeze review requires explicit reach" });
    }
    if (review.status.applicability.state === "not-applicable" && review.reach !== "none") {
      ctx.addIssue({ code: "custom", path: ["reach"], message: "Not-applicable freeze review must record no reach" });
    }
  });

export const V9AccessReviewV2Schema = z
  .object({
    transfer: V9TransferAccessReviewV2Schema,
    freeze: z
      .object({
        status: V9FactStatusV2Schema,
        reviews: canonicalArrayBy(V9FreezeAccessReviewV2Schema, (review) => review.reviewKey),
        claimGraph: V9AccessClaimGraphSchema.optional(),
        /**
         * Owner ruling 2026-07-27: a current, evidenced review whose honest
         * verdict is structural rather than boolean. `inherited-upstream` =
         * no direct freeze surface; exposure inherited from a named tracked
         * upstream asset. `inherited-untracked-upstream` (owner ruling
         * 2026-08-10) = the same evidenced inherited verdict where the upstream
         * is not a tracked asset, so no `upstreamAssetId` may be asserted; the
         * exposure is still measured rather than dropped. `reviewed-possible`
         * (owner ruling 2026-08-12) = a current review whose honest verdict is
         * `possible`: freeze reach exists as an unproven surface, not as an
         * unreviewed asset. `none-upgradeable` (reserved; no producer emits it
         * yet) = verified absence in the current implementation behind a named
         * upgrade authority. The freeze facts stay bounded-unknown for
         * scoring; the disposition only stops them from being reported as
         * missing data.
         */
        structuralDisposition: z
          .enum([
            "inherited-upstream",
            "inherited-untracked-upstream",
            "reviewed-possible",
            "none-upgradeable",
          ])
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      review.freeze.status.observationState === "known" &&
      review.freeze.status.applicability.state === "required" &&
      review.freeze.reviews.length === 0
    ) {
      ctx.addIssue({ code: "custom", path: ["freeze", "reviews"], message: "Known freeze posture needs a review" });
    }
  });
export type V9AccessReviewV2 = z.infer<typeof V9AccessReviewV2Schema>;

const V9PegFactV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    pegKey: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    referenceKind: z.enum(["fiat", "asset", "index", "nav", "other"]),
    referenceKey: CanonicalTextSchema,
    methodologyVersion: CanonicalTextSchema,
    pegScore: z.number().finite().min(0).max(100).nullable(),
    currentDeviationBps: z.number().finite().nonnegative().nullable(),
    activeDepeg: z.boolean().nullable(),
    activeDepegBps: z.number().finite().nonnegative().nullable(),
    trackingSpanDays: z.number().finite().nonnegative().nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((peg, ctx) => {
    if (peg.status.observationState === "known" && peg.status.applicability.state === "required") {
      if (peg.pegScore === null || peg.currentDeviationBps === null || peg.activeDepeg === null) {
        ctx.addIssue({ code: "custom", message: "Known applicable peg facts require score and depeg state" });
      }
    }
    if (peg.activeDepeg === true && peg.activeDepegBps === null) {
      ctx.addIssue({ code: "custom", path: ["activeDepegBps"], message: "Active depeg requires peak basis points" });
    }
  });

const V9BridgeSupplyRouteV2Schema = z
  .object({
    deploymentRouteKey: CanonicalTextSchema,
    supplyUsd: NonNegativeUsdSchema,
    supplyShare: FractionSchema,
    reviewState: z.enum(["selected-reviewed", "selected-unresolved", "unmatched"]),
    // Retained V2 facts predate this discriminator. Missing remains parseable
    // but cannot prove a reviewed route native during evaluation.
    reviewedRouteKind: z.enum(["native", "controlled"]).optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.reviewState !== "selected-reviewed" && route.reviewedRouteKind !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewedRouteKind"],
        message: "Only selected-reviewed supply rows carry a reviewed route kind",
      });
    }
  });

const V9ChainSupplyDistributionRowV2Schema = z
  .object({
    chainId: CanonicalChainIdSchema,
    supplyUsd: NonNegativeUsdSchema,
    supplyShare: FractionSchema,
  })
  .strict();

const V9ChainSupplyDistributionV2Schema = z
  .object({
    chains: canonicalArrayBy(V9ChainSupplyDistributionRowV2Schema, (row) => row.chainId),
    unattributedSupplyUsd: NonNegativeUsdSchema,
    unattributedSupplyShare: FractionSchema,
  })
  .strict();

const SUPPLY_USD_RECONCILIATION_TOLERANCE = 0.01;
const SUPPLY_SHARE_RECONCILIATION_TOLERANCE = 0.000000001;

function supplyUsdValuesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SUPPLY_USD_RECONCILIATION_TOLERANCE;
}

function supplyShareValuesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SUPPLY_SHARE_RECONCILIATION_TOLERANCE;
}

/**
 * Supply kinds whose `circulatingUsd` is already USD-denominated and therefore
 * usable as a canonical supply weight without any price multiplication. Both
 * chain-attributed and aggregate-only circulating qualify; they differ only in
 * whether a per-chain breakdown exists.
 */
export function isUsdDenominatedSupplyKind(sourceKind: string): boolean {
  return sourceKind === "usd-denominated-circulating" || sourceKind === "aggregate-circulating";
}

const V9SupplyFactV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    sourceGenerationId: CanonicalTextSchema,
    // `aggregate-circulating` is USD-denominated like `usd-denominated-circulating`
    // but carries no per-chain attribution: it comes from the top-level
    // circulating bucket for assets whose intake lane never populates a
    // per-chain breakdown. Kept distinct so consumers can tell aggregate-only
    // supply from chain-attributed supply.
    sourceKind: z.enum([
      "usd-denominated-circulating",
      "aggregate-circulating",
      "raw-supply-times-price",
      "reported-market-cap",
    ]),
    circulatingUnits: z.number().finite().nonnegative().nullable(),
    referencePriceUsd: z.number().finite().nonnegative().nullable(),
    circulatingUsd: NonNegativeUsdSchema.nullable(),
    // Retained V2 artifacts predate this additive field. Keep it optional
    // without a default so parsing them preserves their exact digest payload;
    // the current compiler always emits either a distribution or explicit null.
    chainDistribution: V9ChainSupplyDistributionV2Schema.nullable().optional(),
    selectedBridgeRoutes: canonicalArrayBy(V9BridgeSupplyRouteV2Schema, (route) => route.deploymentRouteKey),
    selectedRouteSupplyShare: FractionSchema.nullable(),
    unknownRouteSupplyShare: FractionSchema.nullable(),
    unreviewedRouteSupplyShare: FractionSchema.nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
    providerRowExclusions: z.array(AdmittedProviderRowExclusionSchema).optional(),
  })
  .strict()
  .superRefine((supply, ctx) => {
    if (supply.status.observationState === "known" && supply.circulatingUsd === null) {
      ctx.addIssue({ code: "custom", path: ["circulatingUsd"], message: "Known supply requires circulating USD" });
    }
    if (supply.sourceKind === "raw-supply-times-price" && supply.status.observationState === "known") {
      if (supply.circulatingUnits === null || supply.referencePriceUsd === null) {
        ctx.addIssue({ code: "custom", message: "Raw-supply valuation requires units and price" });
      }
    }
    if (isUsdDenominatedSupplyKind(supply.sourceKind) && supply.referencePriceUsd !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["referencePriceUsd"],
        message: "USD-denominated circulating supply must not be multiplied by price",
      });
    }
    if (supply.sourceKind === "aggregate-circulating" && supply.chainDistribution) {
      ctx.addIssue({
        code: "custom",
        path: ["chainDistribution"],
        message: "Aggregate-only circulating supply must not carry a chain distribution",
      });
    }
    if (supply.chainDistribution !== null && supply.chainDistribution !== undefined) {
      if (supply.circulatingUsd === null) {
        ctx.addIssue({
          code: "custom",
          path: ["chainDistribution"],
          message: "Chain supply distribution requires circulating USD",
        });
      } else {
        const distributedUsd =
          supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyUsd, 0) +
          supply.chainDistribution.unattributedSupplyUsd;
        const distributedShare =
          supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyShare, 0) +
          supply.chainDistribution.unattributedSupplyShare;
        if (!supplyUsdValuesReconcile(distributedUsd, supply.circulatingUsd)) {
          ctx.addIssue({
            code: "custom",
            path: ["chainDistribution"],
            message: "Chain supply USD must reconcile to circulating USD",
          });
        }
        const expectedShareTotal = supply.circulatingUsd > 0 ? 1 : 0;
        if (!supplyShareValuesReconcile(distributedShare, expectedShareTotal)) {
          ctx.addIssue({
            code: "custom",
            path: ["chainDistribution"],
            message: "Chain supply shares must reconcile to the circulating base",
          });
        }
        for (const [index, row] of supply.chainDistribution.chains.entries()) {
          const expectedShare = supply.circulatingUsd > 0 ? row.supplyUsd / supply.circulatingUsd : 0;
          if (!supplyShareValuesReconcile(row.supplyShare, expectedShare)) {
            ctx.addIssue({
              code: "custom",
              path: ["chainDistribution", index, "supplyShare"],
              message: "Chain supply share must match its USD share of circulating supply",
            });
          }
        }
        const expectedUnattributedShare =
          supply.circulatingUsd > 0 ? supply.chainDistribution.unattributedSupplyUsd / supply.circulatingUsd : 0;
        if (!supplyShareValuesReconcile(supply.chainDistribution.unattributedSupplyShare, expectedUnattributedShare)) {
          ctx.addIssue({
            code: "custom",
            path: ["chainDistribution", "unattributedSupplyShare"],
            message: "Unattributed chain supply share must match its USD share of circulating supply",
          });
        }
      }
    }
    const shares = [supply.selectedRouteSupplyShare, supply.unknownRouteSupplyShare, supply.unreviewedRouteSupplyShare];
    if (shares.every((share) => share !== null) && shares.reduce((sum, share) => sum + share!, 0) > 1.000001) {
      ctx.addIssue({ code: "custom", message: "Bridge supply shares cannot exceed 1" });
    }
  });

const V9ImplementationFactV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    launchedAtSec: UnixSecondsSchema.nullable(),
  })
  .strict()
  .superRefine((implementation, ctx) => {
    if (implementation.status.observationState === "known" && implementation.launchedAtSec === null) {
      ctx.addIssue({ code: "custom", path: ["launchedAtSec"], message: "Known implementation requires launch time" });
    }
  });

const V9MechanismRiskReviewFactV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    review: V9MechanismRiskReviewSchema.nullable(),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (
      fact.status.observationState === "known" &&
      fact.status.applicability.state === "required" &&
      fact.review === null
    ) {
      ctx.addIssue({ code: "custom", path: ["review"], message: "Known mechanism review requires reviewed facts" });
    }
    if (
      (fact.status.observationState === "missing" || fact.status.observationState === "unsupported") &&
      fact.review !== null
    ) {
      ctx.addIssue({ code: "custom", path: ["review"], message: "Unavailable mechanism review cannot carry facts" });
    }
  });
export type V9MechanismRiskReviewFactV2 = z.infer<typeof V9MechanismRiskReviewFactV2Schema>;

const V9MechanismExitFactV1Schema = z
  .object({
    factKey: V9MechanismExitFactKeySchema,
    disposition: V9MechanismExitDispositionSchema,
    quality: V9MechanismQualitySchema.nullable(),
    evidenceRefIds: CanonicalStringArraySchema,
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
    if (fact.disposition === "supported" && fact.evidenceRefIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceRefIds"],
        message: "Supported mechanism exit facts require evidence",
      });
    }
  });
export type V9MechanismExitFactV1 = z.infer<typeof V9MechanismExitFactV1Schema>;

const V9AssetFactsBaseFields = {
  assetId: CanonicalTextSchema,
  assetIssuerKey: CanonicalTextSchema.nullable().optional(),
  archetype: V9ResolvedMechanismArchetypeSchema,
  variantKind: V9VariantKindSchema,
  evidence: canonicalArrayBy(V9EvidenceReferenceV2Schema, (reference) => reference.evidenceId),
  implementation: V9ImplementationFactV2Schema,
  mechanismRiskReview: V9MechanismRiskReviewFactV2Schema,
  // Optional only so retained V2 bytes remain byte-stable. Current V3
  // producers always emit the complete reviewed mechanism-exit projection.
  mechanismExitFacts: canonicalArrayBy(
    V9MechanismExitFactV1Schema,
    (fact) => fact.factKey,
  ).optional(),
  cdpStressCoverage: V9CdpStressCoverageFactSchema.optional(),
  allocationScopeFacts: canonicalArrayBy(V9AllocationScopeFactSchema, (fact) => fact.claimKey).optional(),
  // Retained V2 facts carry only serial/basket dependency roles. V3 overrides
  // this field with the role-aware edge contract below.
  dependencies: V9EffectiveDependenciesV2Schema,
  reserveStatus: V9FactStatusV2Schema,
  reserveExposures: canonicalArrayBy(V9ReserveExposureFactV2Schema, (exposure) => exposure.exposureKey),
  reserveBoundFacts: canonicalArrayBy(V9ReserveBoundedFactSchema, (row) => row.fact.factKey).optional(),
  reserveScopeAdmissions: z.array(ReserveScopedAdmissionSchema).optional(),
  exitStatus: V9FactStatusV2Schema,
  exitRoutes: canonicalArrayBy(V9ExitRouteFactV2Schema, (route) => route.routeKey),
  controlStatus: V9FactStatusV2Schema,
  controls: canonicalArrayBy(V9DeploymentControlFactV2Schema, (control) => control.controlKey),
  issuanceFacts: V1005InProcessAssetIssuanceFactsSchema.optional(),
  economicControlReview: V9EconomicControlReviewV2Schema,
  accessReview: V9AccessReviewV2Schema,
  peg: V9PegFactV2Schema,
  supply: V9SupplyFactV2Schema,
  operationalResilience: V9OperationalResilienceFactSchema.nullable().optional(),
  operationalResilienceStatus: V9FactStatusV2Schema.optional(),
  causeResolutionDiagnostics: z.array(V9CauseResolutionDiagnosticSchema).optional(),
  // Optional only for retained V2 compatibility. V3 requires the complete,
  // policy-independent wrapper-local contract for every asset.
  wrapperLocalFacts: V9WrapperLocalFactsSchema.optional(),
};

/**
 * The asset-fact fields every fact-set version shares.
 *
 * The engine describes its current shape with this type rather than with
 * `V9AssetFactsV2`: V2 is the retained replay arm, not the contract the
 * evaluator is written against. V3 narrows `dependencies` and
 * `wrapperLocalFacts` and carries a V3 gap array; both remain structurally
 * assignable here.
 */
export type V9AssetFactsBase = Omit<
  z.infer<z.ZodObject<typeof V9AssetFactsBaseFields>>,
  "dependencies"
> & {
  // V3 widened the edge contract (role-aware `pathKind`/`economicRole`), so the
  // shared base admits either effective-dependency version.
  dependencies: V9EffectiveDependenciesV2 | V9EffectiveDependenciesV3;
};

const V9AssetFactsV2ObjectSchema = z
  .object({
    ...V9AssetFactsBaseFields,
    gaps: canonicalArrayBy(V9FactGapV2Schema, (gap) => gap.gapId),
  })
  .strict();
type V9AssetFactsV2Object = z.infer<typeof V9AssetFactsV2ObjectSchema>;
type V9AssetFactsValidationInput = Omit<V9AssetFactsV2Object, "dependencies"> & {
  dependencies: V9EffectiveDependenciesV2 | V9EffectiveDependenciesV3;
};

function validateAssetFacts(asset: V9AssetFactsValidationInput, ctx: z.RefinementCtx): void {
  for (const [index, control] of asset.controls.entries()) {
    if (asset.issuanceFacts && control.controlKind !== "bridge" && control.issuanceFactsRef !== asset.issuanceFacts.ref) {
      ctx.addIssue({ code: "custom", path: ["controls", index, "issuanceFactsRef"], message: "Every native control must bind the asset-wide issuance facts" });
    }
    if (control.issuanceFactsRef !== undefined &&
        (control.issuanceFactsRef !== asset.issuanceFacts?.ref || control.controlKind === "bridge" ||
          control.issuanceGovernance !== undefined || control.issuanceProcess !== undefined || control.processDiagnostics !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["controls", index, "issuanceFactsRef"], message: "Native issuance references require the exact asset facts and no duplicate inline process" });
    }
  }
  if (asset.mechanismRiskReview.review && asset.mechanismRiskReview.review.archetype !== asset.archetype) {
    ctx.addIssue({
      code: "custom",
      path: ["mechanismRiskReview", "review", "archetype"],
      message: "Mechanism review archetype does not match the asset archetype",
    });
  }
  if (asset.cdpStressCoverage !== undefined && asset.archetype !== "cdp") {
    ctx.addIssue({
      code: "custom",
      path: ["cdpStressCoverage"],
      message: "Only CDP assets may carry stress-coverage facts",
    });
  }
  const controlKeys = new Set(asset.controls.map((control) => control.controlKey));
  for (const [label, controlKey] of [
    ["mint", asset.economicControlReview.mint.controlKey],
    ["upgrade", asset.economicControlReview.mint.upgrade.controlKey],
    ...asset.economicControlReview.oracle.branches.map((branch) => [`oracle:${branch.branch}`, branch.controlKey]),
    ...asset.economicControlReview.bridge.routes.map((route) => [`bridge:${route.controlKey}`, route.controlKey]),
    ...asset.accessReview.freeze.reviews.map((review) => [`access:${review.reviewKey}`, review.controlKey]),
  ] as Array<[string, string | null]>) {
    if (controlKey !== null && !controlKeys.has(controlKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["economicControlReview"],
        message: `${label} review references unknown control ${controlKey}`,
      });
    }
  }
  for (const [index, fact] of (asset.allocationScopeFacts ?? []).entries()) {
    const target = fact.target;
    if (fact.admitted && fact.disposition === "inherited-parent" &&
      (target?.kind !== "parent-claim" || !asset.dependencies.edges.some((edge) =>
        edge.edgeKey === target.edgeKey && edge.upstreamAssetId === target.upstreamAssetId))) {
      ctx.addIssue({ code: "custom", path: ["allocationScopeFacts", index, "target"], message: "Parent scope must match a real economic dependency" });
    }
  }
  // exitRoutes is deliberately absent: a reviewed-complete empty exit
  // surface is representable KNOWN negative evidence (VER-006).
  for (const [field, status, count] of [
    ["reserveExposures", asset.reserveStatus, asset.reserveExposures.length],
    ["controls", asset.controlStatus, asset.controls.length],
  ] as const) {
    if (status.applicability.state === "required" && status.observationState === "known" && count === 0) {
      ctx.addIssue({ code: "custom", path: [field], message: `Known required ${field} cannot be empty` });
    }
  }
  const hasWrapperEdge = asset.dependencies.edges.some(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const explicitWrapperVariant =
    asset.variantKind === "pure-wrapper" ||
    asset.variantKind === "savings-passthrough" ||
    asset.variantKind === "strategy-vault" ||
    asset.variantKind === "risk-absorption";
  const wrapperApplicable = explicitWrapperVariant || hasWrapperEdge;
  if (asset.wrapperLocalFacts?.applicability === "wrapper" && !wrapperApplicable) {
    ctx.addIssue({
      code: "custom",
      path: ["wrapperLocalFacts", "applicability"],
      message: "Wrapper-local facts require an explicit wrapper variant or serial wrapper dependency",
    });
  }
  if (asset.wrapperLocalFacts?.applicability === "not-wrapper" && wrapperApplicable) {
    ctx.addIssue({
      code: "custom",
      path: ["wrapperLocalFacts", "applicability"],
      message: "Wrapper assets cannot declare wrapper-local facts not applicable",
    });
  }
  if (asset.wrapperLocalFacts?.applicability === "wrapper") {
    const allowedForms =
      asset.variantKind === "pure-wrapper"
        ? ["pure"]
        : asset.variantKind === "savings-passthrough"
          ? ["native-staked"]
          : asset.variantKind === "risk-absorption"
            ? ["native-staked", "strategy-vault"]
            : ["strategy-vault"];
    if (!allowedForms.includes(asset.wrapperLocalFacts.form)) {
      ctx.addIssue({
        code: "custom",
        path: ["wrapperLocalFacts", "form"],
        message: `Wrapper form must be one of ${allowedForms.join(", ")} for the compiled variant/dependency facts`,
      });
    }
  }
}

const V9AssetFactsV2Schema = V9AssetFactsV2ObjectSchema.superRefine(validateAssetFacts);
export type V9AssetFactsV2 = z.infer<typeof V9AssetFactsV2Schema>;

const V9AssetFactsV3ObjectSchema = z
  .object({
    ...V9AssetFactsBaseFields,
    dependencies: V9EffectiveDependenciesV3Schema,
    wrapperLocalFacts: V9WrapperLocalFactsSchema,
    reserveResiduals: canonicalArrayBy(V9ReserveResidualFactSchema, (residual) => residual.residualId),
    reserveCompositionEvidenceClass: V9ReserveCompositionEvidenceClassSchema.optional(),
    reserveCompositionProvenance: V9ReserveCompositionProvenanceSchema.optional(),
    exitRoutes: canonicalArrayBy(V9ExitRouteFactV2Schema.safeExtend({
      capacityEvidenceTier: ExitRouteCapacityEvidenceTierSchema,
      factorStatuses: V9ExitFactorStatusesSchema,
      modelConfidence: z.enum(["high", "medium", "low", "unknown"]),
    }), (route) => route.routeKey),
    gaps: canonicalArrayBy(V9FactGapV3Schema, (gap) => gap.gapId),
  })
  .strict();
export const V9AssetFactsV3Schema = V9AssetFactsV3ObjectSchema.superRefine((asset, ctx) => {
  validateAssetFacts(asset, ctx);
  if (asset.wrapperLocalFacts.applicability === "wrapper") {
    const wrapper = asset.wrapperLocalFacts;
    if (!["reviewed", "not-applicable"].includes(wrapper.formDisposition) && (!wrapper.formStatus || wrapper.formStatus.gapIds.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["wrapperLocalFacts", "formStatus"], message: "Unavailable wrapper form requires its own causal status" });
    }
    for (const [key, fact] of Object.entries(wrapper.facts)) {
      if (!["reviewed", "not-applicable"].includes(fact.disposition) && (!fact.status || fact.status.gapIds.length === 0)) {
        ctx.addIssue({ code: "custom", path: ["wrapperLocalFacts", "facts", key, "status"], message: "Unavailable wrapper facts require resolving causal gaps" });
      }
    }
    if (!["reviewed", "not-applicable"].includes(wrapper.riskTransfer.disposition) && (!wrapper.riskTransfer.status || wrapper.riskTransfer.status.gapIds.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["wrapperLocalFacts", "riskTransfer"], message: "Unavailable risk transfer requires cause status without positive credit" });
    }
  }
  const gapsById = new Map(asset.gaps.map((gap) => [gap.gapId, gap]));
  for (const { label, status } of factStatuses(asset)) {
    for (const id of status.gapIds) {
      if (!gapsById.has(id)) ctx.addIssue({ code: "custom", path: [label, "gapIds"], message: `Unknown cause-bearing gap ${id}` });
    }
  }
  for (const [index, exposure] of asset.reserveExposures.entries()) {
    for (const [key, missing] of [
      ["assetClass", exposure.assetClass === null],
      ["liquidity", exposure.liquidityHorizon === null || exposure.liquidityHorizon === "unknown"],
      ["maturity", exposure.maturityDaysMax === null],
      ["obligorConcentration", exposure.issuerOrObligorKey === null],
    ] as const) {
      const status = exposure.factorStatuses?.[key];
      const openEndedMaturity = key === "maturity" && asset.reserveBoundFacts?.some((row) =>
        row.fact.kind === "maturity-applicability" && row.fact.conclusion === "open-ended" && row.fact.allInScope &&
        row.fact.scope.kind === "exposure" && row.fact.scope.exposureKey === exposure.exposureKey &&
        row.status.observationState === "known" && row.rejectionReason === null &&
        row.status.evidenceRefIds.some(id => status?.evidenceRefIds.includes(id)));
      if (missing && !openEndedMaturity && (!status || (status.observationState === "known" && status.applicability.state !== "not-applicable"))) {
        ctx.addIssue({ code: "custom", path: ["reserveExposures", index, "factorStatuses", key], message: "Unknown reserve subfield requires its own cause-bearing status" });
      }
    }
  }
  for (const [index, route] of asset.exitRoutes.entries()) {
    if (route.status.observationState === "known" && route.scoreEligible) {
      for (const [unknown, factor] of [
        [route.holderAccess === "unknown", "access"],
        [route.executionModel === "unknown" || route.executionCertainty === "unknown" || route.modelConfidence === "unknown", "executionConfidence"],
        [route.observationConfidence === "unknown", "observationConfidence"],
        [route.settlementModel === "unknown", "settlement"],
        [route.capacityCurve.some((point) => point.executionCostBps === null), "cost"],
      ] as const) {
        const status = route.factorStatuses[factor];
        if (unknown && (!status || status.observationState === "known")) {
          ctx.addIssue({ code: "custom", path: ["exitRoutes", index, "factorStatuses", factor], message: "Unknown route subfields require their own cause-bearing status" });
        }
      }
    }
    if (route.capacityEvidenceTier === "unknown" && route.status.observationState === "known" &&
        (!route.factorStatuses.capacityEvidenceTier || route.factorStatuses.capacityEvidenceTier.observationState === "known")) {
      ctx.addIssue({ code: "custom", path: ["exitRoutes", index, "factorStatuses", "capacityEvidenceTier"], message: "Unknown capacity method requires a causal status" });
    }
  }
  for (const [index, control] of asset.controls.entries()) {
    if (control.status.observationState !== "known") continue;
    for (const [key, unknown] of [
      ["authority", control.authority === null || control.authority.model === "unknown"],
      ["capAuthority", control.capSemantics.kind === "unknown"],
      ["claimImpairment", control.claimImpairment === "unknown"],
      ["economicLossScope", control.economicLossScope === "unknown"],
      ["materialSupplyShare", control.scope === "deployment" && control.materialSupplyShare === null],
    ] as const) {
      const status = control.factorStatuses?.[key];
      if (unknown && (!status || status.observationState === "known")) {
        ctx.addIssue({ code: "custom", path: ["controls", index, "factorStatuses", key], message: "Unknown control subfields require their own cause-bearing status" });
      }
    }
  }
  const { mint, oracle, bridge } = asset.economicControlReview;
  if (asset.operationalResilience == null && asset.operationalResilienceStatus?.observationState === "known") {
    ctx.addIssue({ code: "custom", path: ["operationalResilienceStatus"], message: "Known operational resilience requires an admitted operational fact" });
  }
  if (mint.status.applicability.state === "required") {
    for (const [key, unknown] of [
      ["reconciliation", mint.reconciliation === "unknown"],
      ["supervision", mint.supervision === "unknown"],
      ["upgrade", mint.upgrade.state === "unknown"],
    ] as const) {
      const status = mint.factorStatuses?.[key];
      if (unknown && (!status || status.observationState === "known")) {
        ctx.addIssue({ code: "custom", path: ["economicControlReview", "mint", "factorStatuses", key], message: "Unknown mint factors require their own cause-bearing status" });
      }
    }
  }
  if (oracle.status.applicability.state === "required" && (oracle.tier === null || oracle.tier === "opaque-or-unknown") &&
      (!oracle.factorStatuses?.tier || oracle.factorStatuses.tier.observationState === "known")) {
    ctx.addIssue({ code: "custom", path: ["economicControlReview", "oracle", "factorStatuses", "tier"], message: "Unknown oracle tier requires its own cause-bearing status" });
  }
  if (bridge.status.applicability.state === "required" && bridge.routes.length === 0 &&
      (!bridge.factorStatuses?.tier || bridge.factorStatuses.tier.observationState === "known")) {
    ctx.addIssue({ code: "custom", path: ["economicControlReview", "bridge", "factorStatuses", "tier"], message: "Unresolved bridge tier requires its own cause-bearing status" });
  }
  for (const [index, route] of bridge.routes.entries()) {
    if (route.tier === "opaque-or-unknown" && (!route.factorStatuses?.tier || route.factorStatuses.tier.observationState === "known")) {
      ctx.addIssue({ code: "custom", path: ["economicControlReview", "bridge", "routes", index, "factorStatuses", "tier"], message: "Unknown bridge route tier requires its own cause-bearing status" });
    }
  }
  for (const [index, residual] of asset.reserveResiduals.entries()) {
    const gap = gapsById.get(residual.status.gapIds[0]!);
    if (!gap) ctx.addIssue({ code: "custom", path: ["reserveResiduals", index, "status", "gapIds"], message: "Remainder cause must resolve" });
    else if (gap.causeProof.cause === "D") {
      ctx.addIssue({ code: "custom", path: ["reserveResiduals", index, "status", "gapIds"], message: "Unidentified reserve remainders cannot represent measured adverse holdings" });
    }
  }
  const compositionClass = asset.reserveCompositionEvidenceClass;
  const compositionProvenance = asset.reserveCompositionProvenance;
  if (compositionClass !== undefined || compositionProvenance !== undefined) {
    if (compositionProvenance === "live" && compositionClass !== undefined) {
      ctx.addIssue({ code: "custom", path: ["reserveCompositionEvidenceClass"], message: "Live composition must not carry a static evidence class" });
    } else if (compositionProvenance !== undefined && compositionProvenance !== "live" && compositionClass === undefined) {
      ctx.addIssue({ code: "custom", path: ["reserveCompositionEvidenceClass"], message: "Curated composition requires its admitted evidence class" });
    }
    // Both lists are canonical: link the envelope without allocating another evidence index.
    let evidenceIndex = 0;
    let capturedComposition = false;
    for (const id of asset.reserveStatus.evidenceRefIds) {
      while (evidenceIndex < asset.evidence.length && asset.evidence[evidenceIndex]!.evidenceId < id) evidenceIndex++;
      const reference = asset.evidence[evidenceIndex];
      if (reference?.evidenceId === id && reference.disposition !== "rejected" &&
          reference.rejection === null && reference.freshness.state !== "stale") {
        capturedComposition = true;
        break;
      }
    }
    if (asset.reserveStatus.applicability.state !== "required" ||
        asset.reserveExposures.length + asset.reserveResiduals.length === 0 || !capturedComposition) {
      ctx.addIssue({ code: "custom", path: [compositionProvenance === undefined ? "reserveCompositionEvidenceClass" : "reserveCompositionProvenance"], message: "Composition strength metadata requires an admitted captured composition" });
    }
  }
  const total = asset.reserveExposures.reduce((sum, row) => sum + row.weight, 0) + asset.reserveResiduals.reduce((sum, row) => sum + row.weight, 0);
  if (total > 1 + 1e-9 || ((asset.reserveExposures.length > 0 || asset.reserveResiduals.length > 0) && Math.abs(total - 1) > 1e-9)) {
    ctx.addIssue({ code: "custom", path: ["reserveResiduals"], message: "Identified holdings and disjoint remainders must conserve the whole-asset denominator" });
  }
});
export type V9AssetFactsV3 = z.infer<typeof V9AssetFactsV3Schema>;

const V9FactSourceIdentityV2Schema = z
  .object({
    generationId: CanonicalTextSchema,
    payloadSha256: Sha256Schema,
    observedAtSec: UnixSecondsSchema,
  })
  .strict();

const V9FactSourceFingerprintsV2Schema = z
  .object({
    registry: V9FactSourceIdentityV2Schema,
    dex: V9FactSourceIdentityV2Schema,
    redemption: V9FactSourceIdentityV2Schema,
    liveReserves: V9FactSourceIdentityV2Schema,
    chainSupply: V9FactSourceIdentityV2Schema,
    peg: V9FactSourceIdentityV2Schema,
    researchOverlays: V9FactSourceIdentityV2Schema,
    shockCoverage: V9FactSourceIdentityV2Schema.optional(),
  })
  .strict();

const V9FactSetCoreBaseFields = {
  baseInputGenerationId: BaseInputGenerationIdSchema,
  asOfSec: UnixSecondsSchema,
  compiledAtSec: UnixSecondsSchema,
  sourceFingerprints: V9FactSourceFingerprintsV2Schema,
  activeAssetIds: CanonicalStringArraySchema.pipe(z.array(CanonicalTextSchema).min(1)),
};

const V9FactSetCoreV2Fields = {
  schemaVersion: z.literal(2),
  ...V9FactSetCoreBaseFields,
  assets: canonicalArrayBy(V9AssetFactsV2Schema, (asset) => asset.assetId),
};

const V9FactSetCoreV2ObjectSchema = z.object(V9FactSetCoreV2Fields).strict();
export type V9FactSetCoreV2 = z.infer<typeof V9FactSetCoreV2ObjectSchema>;

const V9FactSetCoreV3Fields = {
  schemaVersion: z.literal(4),
  ...V9FactSetCoreBaseFields,
  assets: canonicalArrayBy(V9AssetFactsV3Schema, (asset) => asset.assetId),
};

const V9FactSetCoreV3ObjectSchema = z.object(V9FactSetCoreV3Fields).strict();
export type V9FactSetCoreV3 = z.infer<typeof V9FactSetCoreV3ObjectSchema>;

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function factStatuses(asset: V9AssetFactsBase): Array<{ label: string; status: V9FactStatusV2 }> {
  const mechanismStatuses = asset.mechanismRiskReview.review
    ? Object.entries(asset.mechanismRiskReview.review).flatMap(([key, value]) =>
        value !== null && typeof value === "object" && "status" in value
          ? [{ label: `mechanism-review:${key}`, status: value.status as V9FactStatusV2 },
            ...((value as V9MechanismFactV1).scopedAssessments ?? []).map(fragment => ({
              label: `mechanism-review:${key}:scope:${fragment.scopeId}`, status: fragment.status,
            }))]
          : [],
      )
    : [];
  return [
    { label: "implementation", status: asset.implementation.status },
    { label: "mechanism-review", status: asset.mechanismRiskReview.status },
    ...mechanismStatuses,
    { label: "dependencies", status: asset.dependencies.status },
    { label: "reserve-envelope", status: asset.reserveStatus },
    ...asset.reserveExposures.map((fact) => ({ label: `reserve:${fact.exposureKey}`, status: fact.status })),
    ...asset.reserveExposures.flatMap((fact) => Object.entries(fact.factorStatuses ?? {}).map(([key, status]) => ({ label: `reserve:${fact.exposureKey}:${key}`, status }))),
    ...("reserveResiduals" in asset ? (asset.reserveResiduals as z.infer<typeof V9ReserveResidualFactSchema>[]).map((fact) => ({ label: `residual:${fact.residualId}`, status: fact.status })) : []),
    ...(asset.reserveBoundFacts ?? []).map((row) => ({ label: `reserve-bound:${row.fact.factKey}`, status: row.status })),
    { label: "exit-envelope", status: asset.exitStatus },
    ...asset.exitRoutes.flatMap((fact) => [
      { label: `route:${fact.routeKey}`, status: fact.status },
      { label: `route-output:${fact.routeKey}`, status: fact.output.status },
      ...Object.entries(fact.factorStatuses ?? {}).map(([key, status]) => ({ label: `route:${fact.routeKey}:${key}`, status })),
    ]),
    { label: "control-envelope", status: asset.controlStatus },
    ...(asset.operationalResilienceStatus ? [{ label: "operational-resilience", status: asset.operationalResilienceStatus }] : []),
    ...asset.controls.map((fact) => ({ label: `control:${fact.controlKey}`, status: fact.status })),
    ...asset.controls.flatMap((fact) => Object.entries(fact.factorStatuses ?? {}).map(([key, status]) => ({ label: `control:${fact.controlKey}:${key}`, status }))),
    ...(asset.wrapperLocalFacts?.applicability === "wrapper" ? [
      ...(asset.wrapperLocalFacts.formStatus ? [{ label: "wrapper:form", status: asset.wrapperLocalFacts.formStatus }] : []),
      ...Object.entries(asset.wrapperLocalFacts.facts).flatMap(([key, fact]) => fact.status ? [{ label: `wrapper:${key}`, status: fact.status }] : []),
      ...(asset.wrapperLocalFacts.riskTransfer.status ? [{ label: "wrapper:risk-transfer", status: asset.wrapperLocalFacts.riskTransfer.status }] : []),
    ] : []),
    { label: "economic-control:mint", status: asset.economicControlReview.mint.status },
    ...Object.entries(asset.economicControlReview.mint.factorStatuses ?? {}).map(([key, status]) => ({ label: `economic-control:mint:${key}`, status })),
    { label: "economic-control:oracle", status: asset.economicControlReview.oracle.status },
    ...Object.entries(asset.economicControlReview.oracle.factorStatuses ?? {}).map(([key, status]) => ({ label: `economic-control:oracle:${key}`, status })),
    ...asset.economicControlReview.oracle.branches.map((branch) => ({
      label: `economic-control:oracle:${branch.branch}`,
      status: branch.status,
    })),
    { label: "economic-control:bridge", status: asset.economicControlReview.bridge.status },
    ...Object.entries(asset.economicControlReview.bridge.factorStatuses ?? {}).map(([key, status]) => ({ label: `economic-control:bridge:${key}`, status })),
    ...asset.economicControlReview.bridge.routes.flatMap((route) =>
      Object.entries(route.factorStatuses ?? {}).map(([key, status]) => ({ label: `economic-control:bridge:${route.controlKey}:${key}`, status }))),
    { label: "access:transfer", status: asset.accessReview.transfer.status },
    { label: "access:freeze", status: asset.accessReview.freeze.status },
    ...asset.accessReview.freeze.reviews.map((review) => ({
      label: `access:freeze:${review.reviewKey}`,
      status: review.status,
    })),
    ...v9AccessClaimGraphStatuses(asset.accessReview.freeze.claimGraph),
    { label: "peg", status: asset.peg.status },
    { label: "supply", status: asset.supply.status },
  ];
}

function validateAssetReferences(
  // Reads `gaps`, which each schema version types differently, so it keeps the
  // explicit union rather than the shared base.
  asset: V9AssetFactsV2 | V9AssetFactsV3,
  activeAssetIds: ReadonlySet<string>,
  assetIndex: number,
  schemaVersion: 2 | 4,
  ctx: z.RefinementCtx,
): void {
  const evidenceById = new Map(asset.evidence.map((reference) => [reference.evidenceId, reference]));
  const evidenceIds = new Set(evidenceById.keys());
  const gapIds = new Set(asset.gaps.map((gap) => gap.gapId));
  const referencedEvidenceIds = new Set<string>();
  const referencedGapIds = new Set<string>();
  for (const scope of asset.reserveScopeAdmissions ?? []) {
    if (scope.admitted && scope.evidenceRefIds.length === 0) addIssue(ctx, ["assets", assetIndex, "reserveScopeAdmissions"], "Admitted reserve scopes require evidence");
    for (const id of scope.evidenceRefIds) {
      if (!evidenceIds.has(id)) addIssue(ctx, ["assets", assetIndex, "reserveScopeAdmissions"], "Reserve scope references missing evidence");
      referencedEvidenceIds.add(id);
    }
  }
  const claimGraph = asset.accessReview.freeze.claimGraph;
  if (claimGraph) {
    if (claimGraph.assetId !== asset.assetId || claimGraph.nodes.find((node) => node.nodeKey === claimGraph.rootNodeKey)?.assetId !== asset.assetId) {
      addIssue(ctx, ["assets", assetIndex, "accessReview", "freeze", "claimGraph"], "Access graph receiving identity mismatch");
    }
    for (const edge of claimGraph.edges) {
      if (edge.basis.kind === "reserve-position" && edge.weight !== null) {
        const exposureKey = edge.basis.exposureKey;
        if (!asset.reserveExposures.some((row) => row.exposureKey === exposureKey && row.status.observationState === "known")) {
          addIssue(ctx, ["assets", assetIndex, "accessReview", "freeze", "claimGraph", "edges"], "Quantified graph edge requires an admitted reserve exposure");
        }
      }
      if (edge.basis.kind === "serial-claim" && edge.basis.dependencyEdgeKey !== null && edge.weight !== null) {
        const dependencyKey = edge.basis.dependencyEdgeKey;
        if (!asset.dependencies.edges.some((row) => row.edgeKey === dependencyKey && row.economicRole === "serial-claim")) {
          addIssue(ctx, ["assets", assetIndex, "accessReview", "freeze", "claimGraph", "edges"], "Serial graph edge requires an admitted dependency");
        }
      }
    }
  }

  const captureRefs = (label: string, evidenceRefIds: readonly string[], statusGapIds: readonly string[]) => {
    for (const evidenceId of evidenceRefIds) {
      referencedEvidenceIds.add(evidenceId);
      if (!evidenceIds.has(evidenceId)) {
        addIssue(ctx, ["assets", assetIndex, label, "evidenceRefIds"], `Unknown evidence reference ${evidenceId}`);
      }
    }
    for (const gapId of statusGapIds) {
      referencedGapIds.add(gapId);
      if (!gapIds.has(gapId)) addIssue(ctx, ["assets", assetIndex, label, "gapIds"], `Unknown gap reference ${gapId}`);
    }
  };

  for (const { label, status } of factStatuses(asset)) {
    captureRefs(label, status.evidenceRefIds, status.gapIds);
    const references = status.evidenceRefIds.flatMap((evidenceId) => {
      const reference = evidenceById.get(evidenceId);
      return reference ? [reference] : [];
    });
    if (status.observationState === "known" && references.some((reference) => reference.disposition === "rejected")) {
      addIssue(ctx, ["assets", assetIndex, label, "evidenceRefIds"], "Known facts cannot rely on rejected evidence");
    }
    if (status.observationState === "stale" && !references.some((reference) => reference.freshness.state === "stale")) {
      addIssue(ctx, ["assets", assetIndex, label, "evidenceRefIds"], "Stale facts require stale last-known evidence");
    }
    if (
      status.observationState === "unsupported" &&
      references.length > 0 &&
      !references.some((reference) => reference.disposition === "rejected")
    ) {
      addIssue(
        ctx,
        ["assets", assetIndex, label, "evidenceRefIds"],
        "Unsupported facts require rejected evidence when evidence is retained",
      );
    }
  }
  const mechanismReview = asset.mechanismRiskReview.review;
  const metricApplicability =
    mechanismReview && "metricApplicability" in mechanismReview
      ? (mechanismReview.metricApplicability as
          | Record<string, { state: string; evidenceRefIds?: readonly string[] }>
          | undefined)
      : undefined;
  for (const [metricKey, applicability] of Object.entries(metricApplicability ?? {})) {
    if (applicability.state === "measured") continue;
    captureRefs(
      `mechanism-review:metric:${metricKey}`,
      applicability.evidenceRefIds ?? [],
      [],
    );
  }
  for (const edge of asset.dependencies.edges) captureRefs(`dependency:${edge.edgeKey}`, edge.evidenceRefIds, []);
  if (asset.cdpStressCoverage !== undefined) {
    captureRefs("cdp-stress-coverage", asset.cdpStressCoverage.evidenceRefIds, []);
    if (asset.cdpStressCoverage.complete && asset.cdpStressCoverage.evidenceRefIds.length === 0) {
      addIssue(
        ctx,
        ["assets", assetIndex, "cdpStressCoverage", "evidenceRefIds"],
        "Complete stress coverage requires compiled journal evidence",
      );
    }
    const source = asset.cdpStressCoverage.source;
    if (source !== null) {
      for (const evidenceId of asset.cdpStressCoverage.evidenceRefIds) {
        const reference = evidenceById.get(evidenceId);
        if (
          reference &&
          (reference.sourceId !== "safety-score-v9.cdp-shock-coverage-measurement" ||
            reference.sourceGenerationId !== `cdp-shock-coverage:v1:${source.journalSha256}` ||
            reference.contentSha256 !== source.journalSha256 ||
            reference.observedAtSec !== source.block.timestampUnix)
        ) {
          addIssue(
            ctx,
            ["assets", assetIndex, "cdpStressCoverage", "evidenceRefIds"],
            `Stress evidence ${evidenceId} does not match its journal provenance`,
          );
        }
      }
    }
  }
  for (const fact of asset.mechanismExitFacts ?? []) {
    captureRefs(`mechanism-exit:${fact.factKey}`, fact.evidenceRefIds, []);
  }
  for (const fact of asset.allocationScopeFacts ?? []) {
    captureRefs(`allocation-scope:${fact.claimKey}`, fact.evidenceRefIds, []);
    if (!fact.admitted) continue;
    for (const evidenceId of fact.evidenceRefIds) {
      const reference = evidenceById.get(evidenceId);
      if (reference && (reference.sourceId !== "safety-score-v9.scoped-allocation-review" ||
        reference.sourceGenerationId !== fact.sourceGenerationId || reference.observedAtSec !== fact.observedAtSec ||
        !fact.sources.some((source) => source.url === reference.url))) {
        addIssue(ctx, ["assets", assetIndex, "allocationScopeFacts", fact.claimKey, "evidenceRefIds"],
          `Allocation scope evidence ${evidenceId} does not match its source/clock/generation`);
      }
    }
  }
  const wrapperLocalFacts = asset.wrapperLocalFacts;
  if (wrapperLocalFacts?.applicability === "not-wrapper") {
    captureRefs("wrapper-local:not-wrapper", wrapperLocalFacts.evidenceRefIds, []);
  } else if (wrapperLocalFacts?.applicability === "wrapper") {
    captureRefs("wrapper-local:form", wrapperLocalFacts.formEvidenceRefIds, []);
    if (wrapperLocalFacts.parentBackingInheritance) {
      captureRefs("wrapper-local:parentBackingInheritance", wrapperLocalFacts.parentBackingInheritance.evidenceRefIds, []);
    }
    for (const [factKey, fact] of Object.entries(wrapperLocalFacts.facts) as Array<
      [keyof V9ApplicableWrapperLocalFacts["facts"], V9ApplicableWrapperLocalFacts["facts"][keyof V9ApplicableWrapperLocalFacts["facts"]]]
    >) {
      captureRefs(`wrapper-local:${factKey}`, fact.evidenceRefIds, []);
      for (const posture of fact.incidentPostures ?? []) {
        captureRefs(
          `wrapper-local:${factKey}:incident:${posture.incidentId}`,
          posture.evidenceRefIds,
          [],
        );
      }
    }
    captureRefs("wrapper-local:risk-transfer", wrapperLocalFacts.riskTransfer.evidenceRefIds, []);
  }
  for (const route of asset.exitRoutes) {
    captureRefs(`settlement:${route.routeKey}`, route.settlementEvidenceRefIds, []);
    if (route.output.valuation) captureRefs(`valuation:${route.routeKey}`, route.output.valuation.evidenceRefIds, []);
  }
  const operationalResilience = asset.operationalResilience;
  if (operationalResilience) {
    captureRefs(
      "operational-resilience:live-history",
      operationalResilience.liveHistoryEligibility.evidenceRefIds,
      [],
    );
    const cumulative = operationalResilience.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatio;
    if (cumulative) captureRefs("operational-resilience:cumulative-redemption", cumulative.evidenceRefIds, []);
    for (const window of operationalResilience.redemptionThroughput?.stressWindows ?? []) {
      captureRefs(`operational-resilience:redemption:${window.episodeKey}`, window.evidenceRefIds, []);
    }
    for (const episode of operationalResilience.stressEpisodes) {
      captureRefs(`operational-resilience:stress:${episode.episodeKey}`, episode.evidenceRefIds, []);
    }
    if (operationalResilience.reserveReconciliation) {
      captureRefs(
        "operational-resilience:reconciliation-history",
        operationalResilience.reserveReconciliation.reportHistory.evidenceRefIds,
        [],
      );
      captureRefs(
        "operational-resilience:latest-assurance",
        operationalResilience.reserveReconciliation.latestAssurance.evidenceRefIds,
        [],
      );
      captureRefs(
        "operational-resilience:reconciliation-procedures",
        operationalResilience.reserveReconciliation.latestReconciliationProcedures.evidenceRefIds,
        [],
      );
    }
    if (operationalResilience.incidentReview.state === "reviewed") {
      captureRefs(
        "operational-resilience:incident-review",
        operationalResilience.incidentReview.evidenceRefIds,
        [],
      );
      for (const incident of operationalResilience.incidentReview.incidents) {
        captureRefs(`operational-resilience:incident:${incident.incidentKey}`, incident.evidenceRefIds, []);
      }
    }
  }
  for (const gap of asset.gaps) {
    captureRefs(`gap:${gap.gapId}`, gap.evidenceRefIds, []);
    if ("causeProof" in gap && gap.evidenceHistory) {
      captureRefs(`gap-history:${gap.gapId}`, gap.evidenceHistory.evidenceRefIds, []);
    }
  }

  for (const evidenceId of evidenceIds) {
    if (!referencedEvidenceIds.has(evidenceId)) {
      addIssue(ctx, ["assets", assetIndex, "evidence"], `Unreferenced evidence ${evidenceId}`);
    }
  }
  for (const gapId of gapIds) {
    if (!referencedGapIds.has(gapId)) addIssue(ctx, ["assets", assetIndex, "gaps"], `Unreferenced gap ${gapId}`);
  }

  const edgeKeys = new Set<string>();
  for (const [edgeIndex, edge] of asset.dependencies.edges.entries()) {
    const expectedKey =
      schemaVersion === 2
        ? `${edge.dependencyType}:${edge.upstreamAssetId}`
        : `${edge.economicRole}:${edge.dependencyType}:${edge.upstreamAssetId}`;
    if (edge.edgeKey !== expectedKey) {
      addIssue(ctx, ["assets", assetIndex, "dependencies", "edges", edgeIndex, "edgeKey"], `Expected ${expectedKey}`);
    }
    const relationKey =
      schemaVersion === 2
        ? `${edge.upstreamAssetId}:${edge.dependencyType}`
        : `${edge.upstreamAssetId}:${edge.dependencyType}:${edge.economicRole}`;
    if (edgeKeys.has(relationKey)) {
      addIssue(ctx, ["assets", assetIndex, "dependencies", "edges", edgeIndex], `Duplicate dependency ${relationKey}`);
    }
    edgeKeys.add(relationKey);
    if (edge.upstreamAssetId === asset.assetId) {
      addIssue(ctx, ["assets", assetIndex, "dependencies", "edges", edgeIndex], "Self dependency is invalid");
    }
    if (!activeAssetIds.has(edge.upstreamAssetId)) {
      addIssue(ctx, ["assets", assetIndex, "dependencies", "edges", edgeIndex], "Dependency is outside active set");
    }
  }

  const exposures = new Set(asset.reserveExposures.map((exposure) => exposure.exposureKey));
  const routes = new Set(asset.exitRoutes.map((route) => route.routeKey));
  const controls = new Map(asset.controls.map((control) => [control.controlKey, control]));
  // Historic V2 treated all selected routes as one allocation. Current facts
  // retain overlapping alternatives; the portfolio solver enforces joint budgets.
  if (schemaVersion === 2) {
    const resourceOwners = new Map<string, string>();
    for (const route of asset.exitRoutes) {
      if (!route.scoreEligible) continue;
      if (route.status.observationState === "known" &&
          (route.holderAccess === "unknown" || route.executionModel === "unknown" ||
           route.executionCertainty === "unknown" || route.observationConfidence === "unknown" ||
           route.modelConfidence === "unknown" || route.settlementModel === "unknown" ||
           route.capacityCurve.some((point) => point.executionCostBps === null))) {
        addIssue(ctx, ["assets", assetIndex, "exitRoutes"], "Historic score-eligible routes require explicit access, execution, observation, settlement and cost facts");
      }
      for (const resourceKey of route.physicalResourceKeys) {
        const existingRoute = resourceOwners.get(resourceKey);
        if (existingRoute && existingRoute !== route.routeKey) {
          addIssue(
            ctx,
            ["assets", assetIndex, "exitRoutes"],
            `Physical resource ${resourceKey} is reused by score-bearing routes`,
          );
        }
        resourceOwners.set(resourceKey, route.routeKey);
      }
    }
  }
  for (const [gapIndex, gap] of asset.gaps.entries()) {
    const path = gap.path;
    if (path.kind === "serial-dependency") {
      if (
        !asset.dependencies.edges.some(
          (edge) =>
            edge.upstreamAssetId === path.upstreamAssetId &&
            edge.dependencyType === path.dependencyType &&
            edge.economicRole === "serial-claim",
        )
      ) {
        addIssue(ctx, ["assets", assetIndex, "gaps", gapIndex, "path"], "Serial path does not reference a dependency");
      }
    } else if (path.kind === "collateral-exposure" && !exposures.has(path.exposureKey)) {
      addIssue(ctx, ["assets", assetIndex, "gaps", gapIndex, "path"], "Collateral path does not reference an exposure");
    } else if (path.kind === "optional-exit" && !routes.has(path.routeKey)) {
      addIssue(ctx, ["assets", assetIndex, "gaps", gapIndex, "path"], "Exit path does not reference a route");
    } else if (path.kind === "deployment-control") {
      const control = controls.get(path.controlKey);
      if (!control || control.deploymentKey !== path.deploymentKey) {
        addIssue(
          ctx,
          ["assets", assetIndex, "gaps", gapIndex, "path"],
          "Control path does not reference a deployment control",
        );
      }
    }
  }
}

function validateFactSetCore(value: V9FactSetCoreV2 | V9FactSetCoreV3, ctx: z.RefinementCtx): void {
  if (value.compiledAtSec < value.asOfSec) {
    addIssue(ctx, ["compiledAtSec"], "compiledAtSec cannot predate asOfSec");
  }
  for (const [source, identity] of Object.entries(value.sourceFingerprints)) {
    if (identity.observedAtSec > value.asOfSec) {
      addIssue(ctx, ["sourceFingerprints", source, "observedAtSec"], "Source observation is later than asOfSec");
    }
  }

  const assetIds = value.assets.map((asset) => asset.assetId);
  if (JSON.stringify(assetIds) !== JSON.stringify(value.activeAssetIds)) {
    addIssue(ctx, ["assets"], "Assets must match the exact active asset set");
  }
  const activeAssetIds = new Set(value.activeAssetIds);
  const hasStressCoverage = value.assets.some((asset) => asset.cdpStressCoverage !== undefined);
  if (hasStressCoverage && value.sourceFingerprints.shockCoverage === undefined) {
    addIssue(ctx, ["sourceFingerprints", "shockCoverage"], "Stress coverage requires a source fingerprint");
  }
  for (const [assetIndex, asset] of value.assets.entries()) {
    const claimGraph = asset.accessReview.freeze.claimGraph;
    if (claimGraph && (claimGraph.clockSec !== value.asOfSec || claimGraph.generationId !== value.baseInputGenerationId)) {
      addIssue(ctx, ["assets", assetIndex, "accessReview", "freeze", "claimGraph"], "Access graph must match the admitted clock and input generation");
    }
    if (value.schemaVersion === 4 && "reserveResiduals" in asset) {
      const evidenceById = new Map<string, V9EvidenceReferenceV2>();
      for (const reference of asset.evidence) evidenceById.set(reference.evidenceId, reference);
      for (const [gapIndex, gap] of asset.gaps.entries()) {
        if (!("causeProof" in gap)) continue;
        for (const message of findV9EvidenceCauseProofIssues({
          proof: gap.causeProof, assetId: asset.assetId, scope: gap.causeScope ?? null,
          asOfSec: value.asOfSec, evidence: asset.evidence, researchMaxAgeSec: 365 * 86400,
          evidenceById,
        })) {
          addIssue(ctx, ["assets", assetIndex, "gaps", gapIndex, "causeProof"], message);
        }
      }
    }
    for (const [evidenceIndex, evidence] of asset.evidence.entries()) {
      if (evidence.observedAtSec > value.asOfSec) {
        addIssue(
          ctx,
          ["assets", assetIndex, "evidence", evidenceIndex, "observedAtSec"],
          "Evidence is later than asOfSec",
        );
      }
      if (evidence.publishedAtSec !== null && evidence.publishedAtSec > value.asOfSec) {
        addIssue(
          ctx,
          ["assets", assetIndex, "evidence", evidenceIndex, "publishedAtSec"],
          "Publication is later than asOfSec",
        );
      }
      if (evidence.rejection && evidence.rejection.rejectedAtSec > value.asOfSec) {
        addIssue(
          ctx,
          ["assets", assetIndex, "evidence", evidenceIndex, "rejection"],
          "Rejection is later than asOfSec",
        );
      }
      if (evidence.freshness.ageSec !== value.asOfSec - evidence.observedAtSec) {
        addIssue(
          ctx,
          ["assets", assetIndex, "evidence", evidenceIndex, "freshness", "ageSec"],
          "Evidence age is not clock-derived",
        );
      }
    }
    if (asset.implementation.launchedAtSec !== null && asset.implementation.launchedAtSec > value.asOfSec) {
      addIssue(
        ctx,
        ["assets", assetIndex, "implementation", "launchedAtSec"],
        "Implementation date is later than asOfSec",
      );
    }
    for (const [routeIndex, route] of asset.exitRoutes.entries()) {
      const expectedGeneration =
        route.lane === "dex"
          ? value.sourceFingerprints.dex.generationId
          : value.sourceFingerprints.redemption.generationId;
      if (route.sourceGenerationId !== expectedGeneration) {
        addIssue(
          ctx,
          ["assets", assetIndex, "exitRoutes", routeIndex, "sourceGenerationId"],
          "Route generation does not match its lane",
        );
      }
      const valuation = route.output.valuation;
      if (valuation) {
        if (valuation.asOfSec !== value.asOfSec || valuation.observedAtSec > value.asOfSec) {
          addIssue(
            ctx,
            ["assets", assetIndex, "exitRoutes", routeIndex, "output", "valuation"],
            "Valuation clock does not match fact-set clock",
          );
        }
        if (valuation.freshness.ageSec !== value.asOfSec - valuation.observedAtSec) {
          addIssue(
            ctx,
            ["assets", assetIndex, "exitRoutes", routeIndex, "output", "valuation", "freshness"],
            "Valuation age is not clock-derived",
          );
        }
      }
    }
    const expectedDependencyGeneration = asset.dependencies.dependencyFromLive
      ? value.sourceFingerprints.liveReserves.generationId
      : value.sourceFingerprints.researchOverlays.generationId;
    if (asset.dependencies.sourceGenerationId !== expectedDependencyGeneration) {
      addIssue(
        ctx,
        ["assets", assetIndex, "dependencies", "sourceGenerationId"],
        "Dependency provenance generation is inconsistent",
      );
    }
    for (const [exposureIndex, exposure] of asset.reserveExposures.entries()) {
      const expectedGeneration =
        exposure.provenance === "live"
          ? value.sourceFingerprints.liveReserves.generationId
          : value.sourceFingerprints.researchOverlays.generationId;
      if (exposure.sourceGenerationId !== expectedGeneration) {
        addIssue(
          ctx,
          ["assets", assetIndex, "reserveExposures", exposureIndex, "sourceGenerationId"],
          "Reserve provenance generation is inconsistent",
        );
      }
    }
    for (const [boundIndex, bound] of (asset.reserveBoundFacts ?? []).entries()) {
      const generation = bound.fact.provenance.kind === "producer-observation"
        ? value.sourceFingerprints.liveReserves.generationId
        : value.sourceFingerprints.researchOverlays.generationId;
      const references = asset.evidence.filter((reference) => bound.status.evidenceRefIds.includes(reference.evidenceId));
      if (bound.sourceGenerationId !== generation || references.some((reference) => reference.sourceGenerationId !== generation || reference.freshness.maxAgeSec !== bound.freshnessMaxAgeSec)) {
        addIssue(ctx, ["assets", assetIndex, "reserveBoundFacts", boundIndex], "Bounded reserve generation or freshness budget is inconsistent");
      }
      if (bound.status.observationState === "known" && (bound.fact.asOfSec > value.asOfSec || value.asOfSec - bound.fact.asOfSec > bound.freshnessMaxAgeSec || references.some((reference) => reference.observedAtSec !== bound.fact.asOfSec || reference.freshness.state !== "current"))) {
        addIssue(ctx, ["assets", assetIndex, "reserveBoundFacts", boundIndex], "Known bounded reserve facts require their own current snapshot");
      }
    }
    for (const [controlIndex, control] of asset.controls.entries()) {
      if (control.sourceGenerationId !== value.sourceFingerprints.researchOverlays.generationId) {
        addIssue(
          ctx,
          ["assets", assetIndex, "controls", controlIndex, "sourceGenerationId"],
          "Control provenance generation is inconsistent",
        );
      }
    }
    for (const [branchIndex, branch] of asset.economicControlReview.oracle.branches.entries()) {
      if (branch.inheritedFromAssetId !== null && !activeAssetIds.has(branch.inheritedFromAssetId)) {
        addIssue(
          ctx,
          ["assets", assetIndex, "economicControlReview", "oracle", "branches", branchIndex, "inheritedFromAssetId"],
          "Inherited oracle branch is outside the active set",
        );
      }
    }
    for (const [reviewIndex, review] of asset.accessReview.freeze.reviews.entries()) {
      if (review.upstreamAssetId !== null && !activeAssetIds.has(review.upstreamAssetId)) {
        addIssue(
          ctx,
          ["assets", assetIndex, "accessReview", "freeze", "reviews", reviewIndex, "upstreamAssetId"],
          "Upstream freeze review is outside the active set",
        );
      }
    }
    if (asset.peg.sourceGenerationId !== value.sourceFingerprints.peg.generationId) {
      addIssue(ctx, ["assets", assetIndex, "peg", "sourceGenerationId"], "Peg provenance generation is inconsistent");
    }
    if (asset.supply.sourceGenerationId !== value.sourceFingerprints.chainSupply.generationId) {
      addIssue(
        ctx,
        ["assets", assetIndex, "supply", "sourceGenerationId"],
        "Supply provenance generation is inconsistent",
      );
    }
    validateAssetReferences(asset, activeAssetIds, assetIndex, value.schemaVersion, ctx);
  }
}

export const V9FactSetCoreV2Schema = V9FactSetCoreV2ObjectSchema.superRefine((value, ctx) =>
  validateFactSetCore(value, ctx),
);

export const CompiledV9FactSetV2Schema = z
  .object({ ...V9FactSetCoreV2Fields, v9FactSetDigest: Sha256Schema })
  .strict()
  .superRefine((value, ctx) => validateFactSetCore(value, ctx));
export type CompiledV9FactSetV2 = z.infer<typeof CompiledV9FactSetV2Schema>;

export const V9FactSetCoreV3Schema = V9FactSetCoreV3ObjectSchema.superRefine((value, ctx) =>
  validateFactSetCore(value, ctx),
);

/** Keep cohort/reference validation when a compiler has already admitted each asset. */
export function createV9FactSetCoreV3Schema(assetSchema: z.ZodType<V9AssetFactsV3>) {
  return z.object({ ...V9FactSetCoreV3Fields, assets: canonicalArrayBy(assetSchema, (asset) => asset.assetId) })
    .strict()
    .superRefine((value, ctx) => validateFactSetCore(value, ctx));
}

export const CompiledV9FactSetV3Schema = z
  .object({ ...V9FactSetCoreV3Fields, v9FactSetDigest: Sha256Schema })
  .strict()
  .superRefine((value, ctx) => validateFactSetCore(value, ctx));
export type CompiledV9FactSetV3 = z.infer<typeof CompiledV9FactSetV3Schema>;
