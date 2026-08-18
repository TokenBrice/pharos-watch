import { z } from "zod";
import { canonicalV9DependencyEdgeKey } from "@shared/lib/safety-score-v9/facts";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  defaultV9DependencyEconomicRole,
  V9DependencyEconomicRoleSchema,
} from "@shared/types/dependency-types";
import {
  V9AccessReviewV2Schema,
  V9EconomicControlReviewV2Schema,
  V9ReserveAssetClassSchema,
  V9ResolvedMechanismArchetypeSchema,
  V9VariantKindSchema,
} from "@shared/types/safety-score-v9-facts";
import {
  V9CdpStressCoverageFactSchema,
  V9MechanismRiskReviewSchema,
} from "@shared/types/safety-score-v9-backing";
import { SafetyScoreV9OperationalResilienceOverlaySchema } from "./safety-score-v9-extension-operational-resilience";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
} from "@shared/types/exit-route";
import { ReserveSliceSchema } from "@shared/types/reserves";
import type { ReserveSlice } from "@shared/types/reserves";
import { WRAPPER_OPERATOR_VALUES } from "@shared/types/core";
import { canonicalArrayBy } from "@shared/types/safety-score-v9-fact-primitives";
import {
  CanonicalFailureDomainsSchema,
  CanonicalTextSchema,
  FractionSchema,
  Sha256Schema,
  UnixSecondsSchema,
  V9ClaimImpairmentSchema,
  V9ControlCapabilitySchema,
  V9ControlCapKindSchema,
  V9ControlCapUnitSchema,
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
    unitValueUsd: z.number().finite().positive(),
    expectedUnitValueUsd: z.number().finite().positive(),
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    maxAgeSec: z.number().int().nonnegative().nullable(),
    confidence: V9RouteValuationConfidenceSchema,
    url: z.string().url().nullable(),
    contentSha256: Sha256Schema.nullable(),
  })
  .strict();

export const RouteOutputReviewSchema = z
  .object({
    kind: V9RouteOutputKindSchema,
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

export const RouteReviewSchema = z
  .object({
    lane: V9RouteLaneSchema,
    routeId: CanonicalTextSchema,
    holderAccess: V9RouteHolderAccessSchema,
    executionModel: V9RouteExecutionModelSchema,
    executionCertainty: V9RouteExecutionCertaintySchema,
    // Retained schema-v2 route reviews predate this field. Normalize them to
    // the conservative modeled-confidence floor at the compiler boundary.
    modelConfidence: z.enum(["high", "medium", "low"]).default("low"),
    coverageClass: V9RouteCoverageClassSchema,
    capacityScoringHorizon: z.enum(["immediate", "daily", "queued", "eventual", "unknown"]).optional(),
    settlementModel: V9RouteSettlementModelSchema,
    settlementSlaSec: z.number().int().nonnegative().nullable(),
    settlementHorizonSec: z.number().int().nonnegative().optional(),
    queueDepthUsd: z.number().finite().nonnegative().nullable().optional(),
    dailyLimitUsd: z.number().finite().nonnegative().nullable().optional(),
    minRedeemUsd: z.number().finite().nonnegative().nullable().optional(),
    physicalResourceKeys: canonicalArrayBy(CanonicalTextSchema, (value) => value),
    executionCosts: canonicalArrayBy(
      RouteExecutionCostSchema,
      (point) => `${point.maxCostBps}:${point.requestedNotionalUsd}`,
    ),
    output: RouteOutputReviewSchema.nullable(),
    // Optional for retained extension-v2 compatibility. Current redemption
    // reviews distinguish a known-but-unpriceable external output from an
    // issuer-undisclosed settlement asset without making either scoreable.
    unresolvedOutputResponsibility: z
      .enum(["integration-missing", "issuer-undisclosed", "producer-failed"])
      .optional(),
    failureDomains: CanonicalFailureDomainsSchema,
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

const ControlOverlaySchema = z
  .object({
    controlKey: CanonicalTextSchema,
    deploymentKey: CanonicalTextSchema,
    controllerAssetId: CanonicalTextSchema.nullable().optional(),
    controlKind: V9ControlKindSchema,
    scope: V9ControlScopeSchema,
    capabilities: canonicalArrayBy(V9ControlCapabilitySchema, (value) => value),
    capSemantics: z
      .object({
        kind: V9ControlCapKindSchema,
        bound: z
          .object({
            amount: z.number().finite().nonnegative(),
            unit: V9ControlCapUnitSchema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    claimImpairment: V9ClaimImpairmentSchema,
    economicLossScope: V9EconomicLossScopeSchema,
    authority: z
      .object({
        authorityKey: CanonicalTextSchema,
        model: z.enum(["none", "eoa", "multisig", "governance", "contract", "issuer-backend", "unknown"]),
        threshold: z
          .object({ required: z.number().int().positive(), total: z.number().int().positive() })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    delaySec: z.number().int().nonnegative().nullable(),
    materialSupplyShare: FractionSchema.nullable(),
    // A reviewer authored a fresh scoped open question naming this control;
    // mirrors the compiled control fact (`V9DeploymentControlFactV2`).
    scopedQuestionFresh: z.boolean().optional(),
    // Reviewed key-custody attestation and Safe module/guard surface. Both
    // mirror the compiled control fact (`V9DeploymentControlFactV2`); see the
    // field comments there.
    keyCustody: z.enum(["mpc", "hsm", "unknown"]).default("unknown"),
    modulesOrGuards: z.enum(["present", "none-detected", "not-applicable", "unknown"]).default("unknown"),
    incidentState: z.enum(["none", "active", "resolved", "unknown"]),
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict();

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
    provenance: z.enum(["curated", "curated-fallback"]).default("curated"),
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
    researchEvidence: canonicalArrayBy(ResearchEvidenceSchema, (evidence) => evidence.evidenceKey).default([]),
    componentEvidence: canonicalArrayBy(ComponentEvidenceBindingSchema, (binding) => binding.componentKey).default([]),
  })
  .strict()
  .superRefine((asset, ctx) => {
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

export const SafetyScoreV9FactSetExtensionV2Schema = z
  .object({
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
    assets: canonicalArrayBy(AssetExtensionSchema, (asset) => asset.assetId).refine((assets) => assets.length > 0, {
      message: "Safety Score v9 extension requires at least one asset",
    }),
  })
  .strict()
  .superRefine((extension, ctx) => {
    for (let assetIndex = 0; assetIndex < extension.assets.length; assetIndex += 1) {
      const asset = extension.assets[assetIndex]!;
      if (asset.operationalResilience !== undefined && asset.operationalResilience !== null) {
        const reviewedAtSec = Date.parse(asset.operationalResilience.reviewedAt) / 1_000;
        const expiresAtSec = Date.parse(asset.operationalResilience.expiresAt) / 1_000;
        if (!(reviewedAtSec <= extension.compiledAtSec && extension.compiledAtSec < expiresAtSec)) {
          ctx.addIssue({
            code: "custom",
            path: ["assets", assetIndex, "operationalResilience"],
            message: "Operational-resilience overlay is outside its exact review window",
          });
        }
      }
      for (let evidenceIndex = 0; evidenceIndex < asset.researchEvidence.length; evidenceIndex += 1) {
        const evidence = asset.researchEvidence[evidenceIndex]!;
        if (evidence.observedAtSec > extension.compiledAtSec) {
          ctx.addIssue({
            code: "custom",
            path: ["assets", assetIndex, "researchEvidence", evidenceIndex, "observedAtSec"],
            message: "Research evidence observation cannot be later than the extension clock",
          });
        }
        if (evidence.publishedAtSec !== null && evidence.publishedAtSec > extension.compiledAtSec) {
          ctx.addIssue({
            code: "custom",
            path: ["assets", assetIndex, "researchEvidence", evidenceIndex, "publishedAtSec"],
            message: "Research evidence publication cannot be later than the extension clock",
          });
        }
      }
    }
  });

export type SafetyScoreV9FactSetExtensionV2 = z.infer<typeof SafetyScoreV9FactSetExtensionV2Schema>;
export type AssetExtension = SafetyScoreV9FactSetExtensionV2["assets"][number];
