import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isRecord } from "@shared/lib/type-guards";
import { canonicalV9DependencyEdgeKey } from "@shared/lib/safety-score-v9/facts";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  defaultV9DependencyEconomicRole,
  V9DependencyEconomicRoleSchema,
} from "@shared/types/dependency-types";
import {
  V9AccessReviewV2Schema,
  V9DependencyRejectionReasonsSchema,
  V9DeploymentControlFactBaseSchema,
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
import { SafetyScoreV9OperationalResilienceOverlaySchema } from "@shared/types/safety-score-v9-operational-resilience-overlays";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
} from "@shared/types/exit-route";
import { ReserveSliceSchema, ReserveIntermediarySchema } from "@shared/types/reserves";
import type { ReserveSlice } from "@shared/types/reserves";
import { CustodyModelSchema, WRAPPER_OPERATOR_VALUES } from "@shared/types/core";
import { ParentBackingInheritanceSchema } from "@shared/types/stablecoin-meta-schemas";
import { SafetyScoreV9WrapperAllocationReviewSchema, V9AllocationScopeIdentityReviewSchema } from "@shared/types/safety-score-v9-allocation";
import { canonicalArrayBy } from "@shared/types/safety-score-v9-fact-primitives";
import {
  CanonicalFailureDomainsSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
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

const ResearchEvidenceSchema = z
  .object({
    evidenceKey: CanonicalTextSchema,
    sourceId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    publishedAtSec: UnixSecondsSchema.nullable(),
    publishedBy: z.enum(["issuer", "parent", "other", "unknown"]).optional(),
    url: z.string().url().nullable(),
    contentSha256: Sha256Schema,
    confidence: z.enum(["verified", "probable", "manual-review", "limited", "unknown"]),
    maxAgeSec: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.publishedAtSec !== null && evidence.publishedAtSec < evidence.observedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedAtSec"],
        message: "Research evidence publication cannot predate observation",
      });
    }
  });

const ComponentEvidenceBindingSchema = z
  .object({
    componentKey: CanonicalTextSchema,
    evidenceKeys: canonicalArrayBy(CanonicalTextSchema, (value) => value).refine((values) => values.length > 0, {
      message: "Component evidence binding requires at least one evidence key",
    }),
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
  })
  .strict();

const DependencyEdgeOverlaySchema = z
  .object({
    upstreamAssetId: CanonicalTextSchema,
    dependencyType: z.enum(["wrapper", "mechanism", "collateral"]),
    weight: z.number().finite().positive().max(1),
    economicRole: V9DependencyEconomicRoleSchema.optional(),
    failureDomains: CanonicalFailureDomainsSchema,
    intermediary: ReserveIntermediarySchema.optional(),
  })
  .strict()
  .superRefine((edge, ctx) => {
    const role = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
    if (role === "serial-claim" && edge.weight !== 1) {
      ctx.addIssue({ code: "custom", path: ["weight"], message: "Serial dependencies must have weight 1" });
    }
    if (role === "serial-claim" && edge.dependencyType === "collateral") {
      ctx.addIssue({ code: "custom", path: ["dependencyType"], message: "Serial claims cannot be collateral edges" });
    }
    if (role === "basket-exposure" && edge.dependencyType !== "collateral") {
      ctx.addIssue({ code: "custom", path: ["dependencyType"], message: "Basket exposures must be collateral edges" });
    }
    if (role !== "serial-claim" && role !== "basket-exposure" && edge.dependencyType === "wrapper") {
      ctx.addIssue({ code: "custom", path: ["dependencyType"], message: "Wrapper edges must be serial claims" });
    }
    if (role !== "serial-claim" && role !== "basket-exposure" && edge.failureDomains.length === 0) {
      ctx.addIssue({ code: "custom", path: ["failureDomains"], message: "Role dependencies require a failure domain" });
    }
  });

const EffectiveDependenciesOverlaySchema = z
  .object({
    source: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none", "variant"]),
    baseSource: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none"]),
    dependencyFromLive: z.boolean(),
    mappedLiveReserveWeight: FractionSchema.nullable(),
    fallbackReason: z
      .enum(["live-unmapped-to-curated-reserve", "live-unmapped-to-manual", "live-cycle-to-curated"])
      .nullable(),
    rejectionReasons: V9DependencyRejectionReasonsSchema.optional(),
    edges: canonicalArrayBy(DependencyEdgeOverlaySchema, (edge) => {
      const role = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
      return canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId, role);
    }),
    diagnostics: z
      .object({
        graphState: z.enum(["valid", "cycle", "invalid", "unresolved"]),
        issueCodes: canonicalArrayBy(CanonicalTextSchema, (value) => value),
        sccMemberAssetIds: canonicalArrayBy(CanonicalTextSchema, (value) => value),
      })
      .strict(),
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
    referenceKind: z.enum(["fiat", "asset", "index", "nav", "other"]),
    referenceKey: CanonicalTextSchema,
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();

const SupplyReviewSchema = z
  .object({
    selectedBridgeRoutes: canonicalArrayBy(
      z
        .object({
          deploymentRouteKey: CanonicalTextSchema,
          supplyUsd: z.number().finite().nonnegative(),
          supplyShare: FractionSchema,
          reviewState: z.enum(["selected-reviewed", "selected-unresolved", "unmatched"]),
          // Optional only for retained V2 extension compatibility. Current
          // producers always distinguish reviewed native from controlled rows.
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
        }),
      (route) => route.deploymentRouteKey,
    ),
    selectedRouteSupplyShare: FractionSchema,
    unknownRouteSupplyShare: FractionSchema,
    unreviewedRouteSupplyShare: FractionSchema,
    failureDomains: CanonicalFailureDomainsSchema,
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
    reviewedStaticReserveRows: ReviewedStaticReserveRowsSchema.nullable().optional(),
    routeReviews: canonicalArrayBy(RouteReviewSchema, (row) => `${row.lane}:${row.routeId}`),
    retainedRoutes: canonicalArrayBy(
      RetainedRouteSchema,
      (row) => `${row.lane}:${row.observation.routeId}:${stableJsonStringifyV1(row.observation)}`,
    ),
    controlReview: ControlReviewSchema.nullable(),
    economicControlReview: V9EconomicControlReviewV2Schema.nullable(),
    accessReview: V9AccessReviewV2Schema.nullable(),
    pegReference: PegReferenceSchema.nullable(),
    supplyReview: SupplyReviewSchema.nullable(),
    operationalResilience: SafetyScoreV9OperationalResilienceOverlaySchema.nullable().optional(),
    // Optional only for retained extension-v2 compatibility. The current
    // baseline producer emits the reviewed registry projection when available.
    wrapperCustodyReview: WrapperCustodyReviewSchema.nullable().optional(),
    wrapperAllocationReview: SafetyScoreV9WrapperAllocationReviewSchema.nullable().optional(),
    allocationScopeIdentityReview: V9AllocationScopeIdentityReviewSchema.optional(),
    parentBackingInheritance: ParentBackingInheritanceSchema.optional(),
    researchEvidence: canonicalArrayBy(ResearchEvidenceSchema, (evidence) => evidence.evidenceKey).default([]),
    componentEvidence: canonicalArrayBy(ComponentEvidenceBindingSchema, (binding) => binding.componentKey).default([]),
    admissionQuarantine: AssetAdmissionQuarantineSchema.optional(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    for (const [field, review] of [
      ["wrapperAllocationReview", asset.wrapperAllocationReview],
      ["allocationScopeIdentityReview", asset.allocationScopeIdentityReview],
    ] as const) {
      if (review != null && review.assetId !== asset.assetId) {
        ctx.addIssue({ code: "custom", path: [field, "assetId"], message: "Allocation review must match extension asset" });
      }
    }
    if (
      asset.operationalResilience !== undefined &&
      asset.operationalResilience !== null &&
      asset.operationalResilience.assetId !== asset.assetId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["operationalResilience", "assetId"],
        message: "Operational-resilience overlay assetId must match its extension asset",
      });
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
  if (asset.operationalResilience !== undefined && asset.operationalResilience !== null) {
    const reviewedAtSec = Date.parse(asset.operationalResilience.reviewedAt) / 1_000;
    const expiresAtSec = Date.parse(asset.operationalResilience.expiresAt) / 1_000;
    if (!(reviewedAtSec <= compiledAtSec && compiledAtSec < expiresAtSec)) {
      issues.push({
        path: ["operationalResilience"],
        message: "Operational-resilience overlay is outside its exact review window",
      });
    }
  }
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
  schemaVersion: z.literal(2),
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
  return AssetExtensionSchema.parse({
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
  });
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
  const parsed = AssetExtensionSchema.safeParse(hydrated);
  const issues: readonly { path: readonly PropertyKey[]; message: string }[] = parsed.success
    ? assetExtensionClockIssues(parsed.data, compiledAtSec)
    : parsed.error.issues;
  const [first, ...rest] = issues;
  if (parsed.success && first === undefined) return parsed.data;
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
