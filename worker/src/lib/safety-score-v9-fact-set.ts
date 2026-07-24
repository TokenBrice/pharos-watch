import { z } from "zod";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { resolveChainId } from "@shared/lib/chains";
import { resolvedExitRouteOutputAssetKeys } from "@shared/lib/exit-route-output";
import { isDexExitRouteCoverageComplete } from "@shared/lib/p4-exit-route-capacity";
import {
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  isV9RepresentationGroupRoute,
} from "@shared/lib/safety-score-v9/facts";
import { deriveV9WindowedPegScore } from "@shared/lib/safety-score-v9/formula";
import {
  evaluateV9ExitAssetFacts,
  resolveV9ExitCapacityAtRequest,
  selectV9ExitStressRequest,
} from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import {
  collateralExposureV9Path,
  createV9FactGapV3,
  optionalExitV9Path,
} from "@shared/lib/safety-score-v9/reasons";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  defaultV9DependencyEconomicRole,
  V9DependencyEconomicRoleSchema,
  type V9DependencyEconomicRole,
} from "@shared/types/dependency-types";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "../cron/sync-stablecoins/shared";
import {
  V9AccessReviewV2Schema,
  V9EconomicControlReviewV2Schema,
  V9ReserveAssetClassSchema,
  V9ResolvedMechanismArchetypeSchema,
  V9VariantKindSchema,
  type CompiledV9FactSetV3,
  type V9AccessReviewV2,
  type V9AssetFactsV2,
  type V9AssetFactsV3,
  type V9DeploymentControlFactV2,
  type V9EconomicControlReviewV2,
  type V9EffectiveDependenciesV3,
  type V9EvidenceReferenceV2,
  type V9ExitRouteFactV2,
  type V9EvidenceResponsibility,
  type V9FactGapV3,
  type V9FactStatusV2,
  type V9FailureDomainRef,
  type V9MechanismRiskReviewFactV2,
  type V9MechanismExitFactV1,
  type V9ReserveExposureFactV2,
} from "@shared/types/safety-score-v9-facts";
import {
  V9CdpStressCoverageFactSchema,
  V9MechanismRiskReviewSchema,
  type V9CdpStressCoverageFact,
  type V9MechanismRiskReview,
} from "@shared/types/safety-score-v9-backing";
import {
  V9OperationalResilienceFactSchema,
  type V9OperationalResilienceClaimConfidence,
  type V9OperationalResilienceFact,
} from "@shared/types/safety-score-v9-operational-resilience";
import {
  V9WrapperLocalFactsSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperFactDisposition,
  type V9WrapperLocalDimensionFact,
  type V9WrapperLocalFacts,
  type V9WrapperRiskAssessment,
} from "@shared/types/safety-score-v9-wrapper";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
  type ExitRouteObservation,
} from "@shared/types/exit-route";
import { getDexMeasuredExecutionFreshnessMaxSec } from "@shared/types/measured-execution";
import { ReserveSliceSchema, type ReserveSlice } from "@shared/types/reserves";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import { assertSafetyScoreV9ExactExtensionAssets } from "./safety-score-v9-fact-set-boundary";
import {
  SafetyScoreV9OperationalResilienceOverlaySchema,
  type SafetyScoreV9OperationalResilienceOverlay,
} from "./safety-score-v9-extension-operational-resilience";
import { hydrateSafetyScoreV9ShockCoverageExtension } from "./safety-score-v9-extension-shock";
import {
  safetyScoreV9ChainRows,
  safetyScoreV9ChainSupplyObservedAtSec,
  safetyScoreV9ChainSupplySourcePayload,
} from "./safety-score-v9-supply-attribution";

const CanonicalTextSchema = z.string().trim().min(1);
const UnixSecondsSchema = z.number().int().nonnegative();
const FractionSchema = z.number().finite().min(0).max(1);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalArrayBy<T>(schema: z.ZodType<T>, keyOf: (value: T) => string) {
  return z
    .array(schema)
    .superRefine((values, ctx) => {
      const keys = values.map(keyOf);
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate !== undefined) ctx.addIssue({ code: "custom", message: `Duplicate canonical key: ${duplicate}` });
    })
    .transform((values) => [...values].sort((left, right) => compareText(keyOf(left), keyOf(right))));
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
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
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

const LocalFailureDomainSchema = z
  .object({
    kind: z.enum([
      "reserve-issuer",
      "reserve-custodian",
      "mint-control",
      "upgrade-control",
      "oracle-feed",
      "bridge-route",
      "redemption-rail",
      "output-asset",
      "chain",
      "dex-protocol",
    ]),
    key: CanonicalTextSchema,
  })
  .strict();

const FailureDomainsSchema = canonicalArrayBy(LocalFailureDomainSchema, (domain) => `${domain.kind}:${domain.key}`);

const LocalControlCapabilitySchema = z.enum([
  "mint",
  "burn",
  "upgrade",
  "freeze",
  "seize",
  "oracle-update",
  "bridge-mint",
  "custody-transfer",
  "parameter-change",
]);

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
    failureDomains: FailureDomainsSchema,
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
    failureDomains: FailureDomainsSchema,
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

const RouteValuationSchema = z
  .object({
    basis: z.enum(["price", "nav", "fx", "reviewed-par"]),
    referenceAssetKey: CanonicalTextSchema,
    unitValueUsd: z.number().finite().positive(),
    expectedUnitValueUsd: z.number().finite().positive(),
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    maxAgeSec: z.number().int().nonnegative().nullable(),
    confidence: z.enum(["high", "medium", "low", "unknown"]),
    url: z.string().url().nullable(),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

const RouteOutputReviewSchema = z
  .object({
    kind: z.enum(["tracked-stablecoin", "fiat", "collateral", "basket"]),
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

const RouteReviewSchema = z
  .object({
    lane: z.enum(["dex", "redemption"]),
    routeId: CanonicalTextSchema,
    holderAccess: z.enum([
      "permissionless",
      "retail-open",
      "institutional-eligible",
      "allowlisted",
      "issuer-only",
      "unknown",
    ]),
    executionModel: z.enum([
      "atomic",
      "deterministic",
      "queued",
      "discretionary",
      "eventual",
      "market-depth",
      "unknown",
    ]),
    executionCertainty: z.enum(["guaranteed", "bounded", "conditional", "discretionary", "unknown"]),
    // Retained schema-v2 route reviews predate this field. Normalize them to
    // the conservative modeled-confidence floor at the compiler boundary.
    modelConfidence: z.enum(["high", "medium", "low"]).default("low"),
    coverageClass: z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]),
    capacityScoringHorizon: z.enum(["immediate", "daily", "queued", "eventual", "unknown"]).optional(),
    settlementModel: z.enum(["atomic", "same-day", "bounded-delay", "queued", "eventual", "unknown"]),
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
    failureDomains: FailureDomainsSchema,
  })
  .strict();

const RejectionSchema = z
  .object({ code: CanonicalTextSchema, reason: CanonicalTextSchema, rejectedAtSec: UnixSecondsSchema })
  .strict();

const RetainedRouteSchema = z
  .object({
    lane: z.enum(["dex", "redemption"]),
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
    controlKind: z.enum(["mint", "upgrade", "custody", "oracle", "bridge", "freeze", "governance"]),
    scope: z.enum(["global", "deployment", "exposure", "route"]),
    capabilities: canonicalArrayBy(LocalControlCapabilitySchema, (value) => value),
    capSemantics: z
      .object({
        kind: z.enum(["bounded", "raiseable", "unbounded", "not-applicable", "unknown"]),
        bound: z
          .object({
            amount: z.number().finite().nonnegative(),
            unit: z.enum(["token-units", "usd-notional", "supply-fraction"]),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    claimImpairment: z.enum(["none", "bounded", "unbounded", "unknown"]),
    economicLossScope: z.enum(["access-only", "deployment", "reserve-claim", "global-claim", "unknown"]),
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
    incidentState: z.enum(["none", "active", "resolved", "unknown"]),
    failureDomains: FailureDomainsSchema,
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
    failureDomains: FailureDomainsSchema,
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
    failureDomains: FailureDomainsSchema,
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
    factKey: z.enum(["physical-redemption", "protocol-redemption"]),
    disposition: z.enum(["supported", "issuer-undisclosed", "integration-missing", "method-unsupported"]),
    quality: z.enum(["strong", "adequate", "limited", "weak", "failed"]).nullable(),
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
    launchedAtSec: UnixSecondsSchema.nullable(),
    mechanismRiskReview: V9MechanismRiskReviewSchema.nullable(),
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
    registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
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
type AssetExtension = SafetyScoreV9FactSetExtensionV2["assets"][number];
const materializedExtensions = new WeakSet<object>();
type ExtensionControlOverlay = Extract<
  NonNullable<AssetExtension["controlReview"]>,
  { state: "reviewed-controls" }
>["controls"][number];

export function materializeSafetyScoreV9FactSetExtension(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extensionValue: unknown,
): Readonly<SafetyScoreV9FactSetExtensionV2> {
  const extension = SafetyScoreV9FactSetExtensionV2Schema.parse(
    hydrateSafetyScoreV9ShockCoverageExtension(extensionValue, fixedInput.clockSec),
  );
  materializedExtensions.add(extension);
  return extension;
}

interface AssetBuildContext {
  readonly fixedInput: ReportCardsFixedInput;
  readonly extension: SafetyScoreV9FactSetExtensionV2;
  readonly asset: AssetExtension;
  readonly researchPayloadSha256: string;
  readonly evidence: Map<string, V9EvidenceReferenceV2>;
  readonly gaps: Map<string, V9FactGapV3>;
}

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

function projectResearchOverlayPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectResearchOverlayPayload);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("applicability" in record && "observationState" in record && "evidenceRefIds" in record && "gapIds" in record) {
    const applicability = record.applicability as Record<string, unknown>;
    return {
      applicability: {
        state: applicability.state,
        policyRuleId: applicability.policyRuleId,
        rationale: applicability.rationale,
      },
      observationState: record.observationState,
    };
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "cdpStressCoverage")
      .map(([key, entry]) => [key, projectResearchOverlayPayload(entry)]),
  );
}

function stableFailureDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  const normalized = domains.map((domain): V9FailureDomainRef => {
    if (domain.kind !== "chain") return domain;
    return { kind: "chain", key: resolveChainId(domain.key) ?? domain.key.toLowerCase() };
  });
  return [...new Map(normalized.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
    (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
}

function normalizeCompiledFailureDomains<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => normalizeCompiledFailureDomains(entry)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "failureDomains" && Array.isArray(entry)
        ? stableFailureDomains(entry as V9FailureDomainRef[])
        : normalizeCompiledFailureDomains(entry),
    ]),
  ) as T;
}

function addEvidence(context: AssetBuildContext, evidence: V9EvidenceReferenceV2): string {
  const existing = context.evidence.get(evidence.evidenceId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(evidence)) {
    throw new Error(`Conflicting Safety Score v9 evidence identity ${evidence.evidenceId}`);
  }
  context.evidence.set(evidence.evidenceId, evidence);
  return evidence.evidenceId;
}

function addGap(context: AssetBuildContext, gap: V9FactGapV3): string {
  const existing = context.gaps.get(gap.gapId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(gap)) {
    throw new Error(`Conflicting Safety Score v9 gap identity ${gap.gapId}`);
  }
  context.gaps.set(gap.gapId, gap);
  return gap.gapId;
}

function fallbackResearchEvidence(context: AssetBuildContext): string {
  const source = context.extension.sources.researchOverlays;
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:research-overlay`,
        sourceId: "safety-score-v9-research-overlay",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: source.observedAtSec,
        contentSha256: context.researchPayloadSha256,
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function componentResearchEvidence(context: AssetBuildContext, componentKey: string): string[] {
  const binding = context.asset.componentEvidence.find((candidate) => candidate.componentKey === componentKey);
  if (!binding) return [fallbackResearchEvidence(context)];
  const evidenceByKey = new Map(context.asset.researchEvidence.map((evidence) => [evidence.evidenceKey, evidence]));
  return binding.evidenceKeys.map((evidenceKey) => {
    const evidence = evidenceByKey.get(evidenceKey);
    if (!evidence) {
      throw new Error(
        `Safety Score v9 component ${context.asset.assetId}:${componentKey} has unknown evidence ${evidenceKey}`,
      );
    }
    return addEvidence(
      context,
      createV9EvidenceReference(
        {
          evidenceId: `${context.asset.assetId}:research:${evidence.evidenceKey}`,
          sourceId: evidence.sourceId,
          sourceGenerationId: context.extension.sources.researchOverlays.generationId,
          disposition: evidence.publishedAtSec === null ? "observed" : "published",
          observedAtSec: evidence.observedAtSec,
          publishedAtSec: evidence.publishedAtSec,
          url: evidence.url,
          contentSha256: evidence.contentSha256,
          maxAgeSec: evidence.maxAgeSec,
        },
        context.fixedInput.clockSec,
      ),
    );
  });
}

function assertKnownComponentEvidenceCurrent(
  context: AssetBuildContext,
  componentKey: string,
  evidenceIds: readonly string[],
): void {
  const stale = evidenceIds.find((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale");
  if (stale) {
    throw new Error(
      `Safety Score v9 component ${context.asset.assetId}:${componentKey} cannot be known with stale evidence ${stale}`,
    );
  }
}

function researchEvidence(context: AssetBuildContext, componentKey?: string): string {
  return componentKey ? componentResearchEvidence(context, componentKey)[0]! : fallbackResearchEvidence(context);
}

function isoDateStartSec(value: string, label: string, asOfSec: number): number {
  const timestampMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid date`);
  const timestampSec = Math.floor(timestampMs / 1_000);
  if (timestampSec > asOfSec) throw new Error(`Safety Score v9 ${label} is later than the scoring clock`);
  return timestampSec;
}

function timestampSec(value: string, label: string, asOfSec: number): number {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) throw new Error(`Safety Score v9 ${label} has an invalid timestamp`);
  const timestamp = Math.floor(timestampMs / 1_000);
  if (timestamp > asOfSec) throw new Error(`Safety Score v9 ${label} is later than the scoring clock`);
  return timestamp;
}

function operationalResilienceConfidence(
  overlay: SafetyScoreV9OperationalResilienceOverlay,
  sourceIds: readonly string[],
): V9OperationalResilienceClaimConfidence {
  const confidenceRank: Record<Exclude<V9OperationalResilienceClaimConfidence, "unknown">, number> = {
    "issuer-reported": 0,
    "independent-assurance": 1,
    audited: 2,
  };
  const sourceById = new Map(overlay.sources.map((source) => [source.sourceId, source]));
  const confidences = sourceIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Unknown operational-resilience source ${overlay.assetId}:${sourceId}`);
    return source.confidence;
  });
  if (confidences.length === 0) {
    throw new Error(`Operational-resilience claim ${overlay.assetId} has no evidence sources`);
  }
  return confidences.reduce((lowest, confidence) =>
    confidenceRank[confidence] < confidenceRank[lowest] ? confidence : lowest,
  );
}

function buildOperationalResilienceFact(context: AssetBuildContext): V9OperationalResilienceFact | null {
  const overlay = context.asset.operationalResilience ?? null;
  if (overlay === null) return null;
  const sourceGenerationId = context.extension.sources.researchOverlays.generationId;
  const evidenceIdBySourceId = new Map(
    overlay.sources.map((source) => {
      const publishedAtSec = isoDateStartSec(
        source.publishedAt,
        `${overlay.assetId}:${source.sourceId} publication`,
        context.fixedInput.clockSec,
      );
      const evidenceId = addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${overlay.assetId}:operational-resilience:${source.sourceId}`,
            sourceId: source.sourceId,
            sourceGenerationId,
            disposition: "published",
            observedAtSec: publishedAtSec,
            publishedAtSec,
            url: source.url,
            contentSha256: digest("safety-score-v9.operational-resilience-source.v1", {
              assetId: overlay.assetId,
              source,
            }),
            maxAgeSec: null,
          },
          context.fixedInput.clockSec,
        ),
      );
      return [source.sourceId, evidenceId] as const;
    }),
  );
  const evidenceRefIds = (sourceIds: readonly string[]): string[] =>
    sourceIds.map((sourceId) => {
      const evidenceId = evidenceIdBySourceId.get(sourceId);
      if (!evidenceId) throw new Error(`Unknown operational-resilience source ${overlay.assetId}:${sourceId}`);
      return evidenceId;
    });
  const claimEvidence = (sourceIds: readonly string[]) => ({
    evidenceRefIds: evidenceRefIds(sourceIds),
    confidence: operationalResilienceConfidence(overlay, sourceIds),
  });

  const cumulativeRatio = overlay.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatio ?? null;
  const cumulativeSourceIds =
    overlay.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatioSourceIds ?? null;
  if ((cumulativeRatio === null) !== (cumulativeSourceIds === null)) {
    throw new Error(`Operational-resilience cumulative redemption claim ${overlay.assetId} lacks exact evidence`);
  }
  const reconciliation = overlay.reserveReconciliation;
  const incidentReview = overlay.incidentReview;
  return V9OperationalResilienceFactSchema.parse({
    schemaVersion: 1,
    reviewedAtSec: timestampSec(
      overlay.reviewedAt,
      `${overlay.assetId} operational-resilience review`,
      context.fixedInput.clockSec,
    ),
    expiresAtSec: Math.floor(Date.parse(overlay.expiresAt) / 1_000),
    liveHistoryEligibility: {
      minimumLiveHistoryMonths: overlay.eligibility.liveHistory.minimumLiveHistoryMonths,
      observedAtSec: isoDateStartSec(
        overlay.eligibility.liveHistory.observedAt,
        `${overlay.assetId} live-history observation`,
        context.fixedInput.clockSec,
      ),
      treatment: "eligibility-only",
      ...claimEvidence(overlay.eligibility.liveHistory.sourceIds),
    },
    redemptionThroughput:
      overlay.redemptionThroughput === null
        ? null
        : {
            cumulativeLifetimeRedeemedSupplyRatio:
              cumulativeRatio === null || cumulativeSourceIds === null
                ? null
                : {
                    value: cumulativeRatio,
                    ...claimEvidence(cumulativeSourceIds),
                  },
            stressWindows: overlay.redemptionThroughput.stressWindows.map((window) => ({
              episodeKey: window.episodeKey,
              observedAtSec: isoDateStartSec(
                window.observedAt,
                `${overlay.assetId}:${window.episodeKey} redemption observation`,
                context.fixedInput.clockSec,
              ),
              maximumWindowDays: window.maximumWindowDays,
              redeemedUsdLowerBound: window.redeemedUsdLowerBound,
              redeemedSupplyRatioLowerBound: window.redeemedSupplyRatioLowerBound,
              settlement: window.settlement,
              ...claimEvidence(window.sourceIds),
            })),
          },
    stressEpisodes: overlay.stressEpisodes.map((episode) => ({
      episodeKey: episode.episodeKey,
      name: episode.name,
      observedMonth: episode.observedMonth,
      redemptionContinued: episode.redemptionContinued,
      recoveredWithinSec: episode.recoveredWithinSec,
      ...claimEvidence(episode.sourceIds),
    })),
    reserveReconciliation:
      reconciliation === null
        ? null
        : {
            reportHistory: {
              firstReportPeriodEnd: reconciliation.firstReportPeriodEnd,
              latestReportPeriodEnd: reconciliation.latestReportPeriodEnd,
              observedReportHistoryMonths: reconciliation.observedReportHistoryMonths,
              reportedCadence: reconciliation.reportedCadence,
              continuityEvidence: reconciliation.continuityEvidence,
              missedMaterialPeriods: reconciliation.missedMaterialPeriods,
              ...claimEvidence(reconciliation.historySourceIds),
              ...(reconciliation.continuityEvidence === "unknown" ? { confidence: "unknown" as const } : {}),
            },
            latestAssurance: {
              level: reconciliation.latestAssurance.level,
              standard: reconciliation.latestAssurance.standard,
              periodEnd: reconciliation.latestAssurance.periodEnd,
              ...claimEvidence(reconciliation.latestAssurance.sourceIds),
            },
            latestReconciliationProcedures: {
              bankAndDepositaryBalances:
                reconciliation.latestReconciliationProcedures.bankAndDepositaryBalances,
              blockchainAssetsAndLiabilities:
                reconciliation.latestReconciliationProcedures.blockchainAssetsAndLiabilities,
              ...claimEvidence(reconciliation.latestReconciliationProcedures.sourceIds),
            },
          },
    incidentReview:
      incidentReview.state === "not-reviewed"
        ? { state: "not-reviewed" }
        : {
            state: "reviewed",
            windowStart: incidentReview.windowStart,
            windowEnd: incidentReview.windowEnd,
            incidents: incidentReview.incidents.map((incident) => ({
              incidentKey: incident.incidentKey,
              name: incident.name,
              category: incident.category,
              state: incident.state,
              occurredAt: incident.occurredAt,
              resolvedAt: incident.resolvedAt,
              ...claimEvidence(incident.sourceIds),
            })),
            ...claimEvidence(incidentReview.sourceIds),
          },
  });
}

function reviewedGapResponsibility(
  observationState: Exclude<V9FactStatusV2["observationState"], "known">,
): V9EvidenceResponsibility {
  if (observationState === "stale") return "producer-failed";
  if (observationState === "unsupported") return "method-unsupported";
  if (observationState === "bounded-unknown") return "issuer-undisclosed";
  return "integration-missing";
}

function missingLocalFact(
  context: AssetBuildContext,
  args: {
    componentKey: string;
    reasonCode: V9FactGapV3["reasonCode"];
    ownerDomain: V9FactGapV3["ownerDomain"];
    responsibility: V9EvidenceResponsibility;
    policyRuleId: string;
    message: string;
    observationState?: Exclude<V9FactStatusV2["observationState"], "known">;
    evidenceRefIds?: readonly string[];
  },
): { gapId: string; status: V9FactStatusV2 } {
  const observationState = args.observationState ?? "missing";
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:${args.componentKey}`,
      reasonCode: args.reasonCode,
      ownerDomain: args.ownerDomain,
      policyRuleId: args.policyRuleId,
      observationState,
      responsibility: args.responsibility,
      path: { kind: "local-component", componentKey: args.componentKey },
      message: args.message,
      evidenceRefIds: args.evidenceRefIds,
    }),
  );
  return {
    gapId,
    status: createV9FactStatus({
      applicability: requiredV9Applicability(args.policyRuleId),
      observationState,
      evidenceRefIds: args.evidenceRefIds,
      gapIds: [gapId],
    }),
  };
}

function buildImplementation(context: AssetBuildContext): V9AssetFactsV2["implementation"] {
  if (context.asset.launchedAtSec === null) {
    return {
      status: missingLocalFact(context, {
        componentKey: "implementation-date",
        reasonCode: "missing-implementation-date",
        ownerDomain: "evidence",
        responsibility: "integration-missing",
        policyRuleId: "v9.implementation.launch-date",
        message: "No reviewed implementation launch date is present in the v9 research overlay.",
      }).status,
      launchedAtSec: null,
    };
  }
  return {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("v9.implementation.launch-date"),
      observationState: "known",
      evidenceRefIds: [researchEvidence(context)],
    }),
    launchedAtSec: context.asset.launchedAtSec,
  };
}

function normalizeMechanismReview(
  context: AssetBuildContext,
  review: V9MechanismRiskReview,
): V9MechanismRiskReviewFactV2 {
  const evidenceIds = componentResearchEvidence(context, "mechanism-risk-review");
  const evidence = context.evidence.get(evidenceIds[0]!)!;
  const normalized = structuredClone(review) as V9MechanismRiskReview;
  const componentGapIds: string[] = [];
  const componentEvidenceIds = new Set<string>();
  let hasStale = false;
  let hasIncomplete = false;

  if (normalized.archetype === "cdp") {
    for (const applicability of Object.values(normalized.metricApplicability)) {
      if (applicability.state !== "not-applicable") continue;
      applicability.evidenceRefIds = evidenceIds;
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
    }
  }

  for (const [componentKey, value] of Object.entries(normalized)) {
    if (value === null || typeof value !== "object" || !("status" in value)) continue;
    const fact = value as { status: V9FactStatusV2 };
    const original = fact.status;
    if (original.observationState === "known") {
      fact.status = createV9FactStatus({
        applicability: original.applicability,
        observationState: "known",
        evidenceRefIds: evidenceIds,
      });
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
      continue;
    }
    // A missing non-serial component is bounded like a stale or
    // bounded-unknown one: it scores at the bounded-unknown quality and the
    // serial-component rule in the evaluator still fails closed when a
    // required serial claim is absent. Only an unsupported design stays a
    // critical evidence failure.
    const gapId = addGap(
      context,
      createV9FactGapV3({
        gapId: `${context.asset.assetId}:gap:mechanism-review:${componentKey}`,
        reasonCode:
          original.observationState === "unsupported" ? "missing-pillar-evidence" : "bounded-mechanism-review",
        ownerDomain: "backing",
        policyRuleId: original.applicability.policyRuleId,
        observationState: original.observationState,
        responsibility: reviewedGapResponsibility(original.observationState),
        path: { kind: "local-component", componentKey: `mechanism-review:${componentKey}` },
        message: `The ${componentKey} mechanism review is not a current known fact.`,
        evidenceRefIds:
          original.observationState === "stale" || original.observationState === "bounded-unknown" ? evidenceIds : [],
      }),
    );
    const applicability =
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability;
    fact.status = createV9FactStatus({
      applicability,
      observationState: original.observationState,
      evidenceRefIds:
        original.observationState === "stale" || original.observationState === "bounded-unknown" ? evidenceIds : [],
      gapIds: [gapId],
    });
    if (original.observationState === "stale") {
      hasStale = true;
      if (evidence.freshness.state !== "stale") {
        throw new Error(`Mechanism review ${context.asset.assetId}:${componentKey} is stale but its source is current`);
      }
    } else {
      hasIncomplete = true;
    }
    componentGapIds.push(gapId);
    if (fact.status.evidenceRefIds.length > 0) {
      for (const evidenceId of evidenceIds) componentEvidenceIds.add(evidenceId);
    }
  }

  const observationState = hasIncomplete ? "bounded-unknown" : hasStale ? "stale" : "known";
  return {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.mechanism-review"),
      observationState,
      evidenceRefIds: [...componentEvidenceIds],
      gapIds: componentGapIds,
    }),
    review: normalized,
  };
}

function buildMechanismReview(context: AssetBuildContext): V9MechanismRiskReviewFactV2 {
  if (context.asset.mechanismRiskReview === null) {
    const unresolvedArchetype = context.asset.archetype === "unresolved";
    if (unresolvedArchetype) {
      // A missing archetype is a METHODOLOGY classification failure, not a
      // backing evidence gap: the policy binds missing-archetype to the
      // methodology owner and path (queue-contract reconciliation).
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:mechanism-risk-review`,
          reasonCode: "missing-archetype",
          ownerDomain: "methodology",
          policyRuleId: "v9.backing.mechanism-review",
          observationState: "missing",
          responsibility: "method-unsupported",
          path: { kind: "methodology", componentKey: "mechanism-risk-review" },
          message: "The asset does not yet have a resolved Safety Score v9 mechanism archetype.",
        }),
      );
      return {
        status: createV9FactStatus({
          applicability: requiredV9Applicability("v9.backing.mechanism-review"),
          observationState: "missing",
          gapIds: [gapId],
        }),
        review: null,
      };
    }
    return {
      status: missingLocalFact(context, {
        componentKey: "mechanism-risk-review",
        // An absent review with a resolved archetype is bounded under the
        // candidate policy: the backing pillar scores at the bounded-unknown
        // quality instead of reason-coding NR.
        reasonCode: "bounded-mechanism-review",
        ownerDomain: "backing",
        responsibility: "integration-missing",
        policyRuleId: "v9.backing.mechanism-review",
        message: "No policy-independent archetype mechanism review is present in the v9 overlay.",
      }).status,
      review: null,
    };
  }
  if (context.asset.mechanismRiskReview.archetype !== context.asset.archetype) {
    throw new Error(`Mechanism review archetype mismatch for ${context.asset.assetId}`);
  }
  return normalizeMechanismReview(context, context.asset.mechanismRiskReview);
}

function buildMechanismExitFacts(context: AssetBuildContext): V9MechanismExitFactV1[] {
  if ((context.asset.mechanismExitFacts?.length ?? 0) === 0) return [];
  const evidenceRefIds = componentResearchEvidence(context, "mechanism-risk-review");
  return context.asset.mechanismExitFacts!.map((fact) => ({
    ...fact,
    evidenceRefIds,
  }));
}

function buildCdpStressCoverage(context: AssetBuildContext): V9CdpStressCoverageFact | undefined {
  if (context.asset.archetype !== "cdp") return undefined;
  const selected = context.asset.cdpStressCoverage;
  if (selected === undefined) return undefined;
  const fact = structuredClone(selected);
  if (fact.source !== null) {
    fact.evidenceRefIds = [
      addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${context.asset.assetId}:cdp-shock-coverage:${fact.source.journalSha256.slice(0, 16)}`,
            sourceId: "safety-score-v9.cdp-shock-coverage-measurement",
            sourceGenerationId: `cdp-shock-coverage:v1:${fact.source.journalSha256}`,
            disposition: "observed",
            observedAtSec: fact.source.block.timestampUnix,
            url: fact.source.sourcePin.repository,
            contentSha256: fact.source.journalSha256,
            // D12: the owner-ratified 72h stress-measurement freshness bound
            // already gates selection in the CDP shock adapter; the evidence
            // ref now carries the same window.
            maxAgeSec:
              V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.stressMeasurementFreshness.maxAgeSec,
          },
          context.fixedInput.clockSec,
        ),
      ),
    ];
  }
  return V9CdpStressCoverageFactSchema.parse(fact);
}

function dependencyPathKind(
  role: V9DependencyEconomicRole,
): "serial-dependency" | "collateral-exposure" | "local-component" {
  if (role === "serial-claim") return "serial-dependency";
  return role === "basket-exposure" ? "collateral-exposure" : "local-component";
}

function buildDependencies(context: AssetBuildContext): V9EffectiveDependenciesV3 {
  const overlay = context.asset.dependencies;
  if (overlay === null) {
    return {
      status: missingLocalFact(context, {
        componentKey: "effective-dependencies",
        reasonCode: "unreviewed-dependency-relationships",
        ownerDomain: "dependency",
        responsibility: "integration-missing",
        policyRuleId: "v9.dependencies.effective-set",
        message: "The exact effective dependency set has not been reviewed for v9.",
      }).status,
      sourceGenerationId: context.extension.sources.researchOverlays.generationId,
      source: "none",
      baseSource: "none",
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [],
      diagnostics: { graphState: "unresolved", issueCodes: ["missing-v9-review"], sccMemberAssetIds: [] },
    };
  }

  const source = overlay.dependencyFromLive
    ? context.extension.sources.liveReserves
    : context.extension.sources.researchOverlays;
  const evidenceIds = overlay.dependencyFromLive
    ? [
        addEvidence(
          context,
          createV9EvidenceReference(
            {
              evidenceId: `${context.asset.assetId}:effective-dependencies`,
              sourceId: "report-cards-live-reserves",
              sourceGenerationId: source.generationId,
              disposition: "observed",
              observedAtSec: source.observedAtSec,
              contentSha256: digest("safety-score-v9.effective-dependencies.v1", overlay),
              maxAgeSec: source.maxAgeSec,
            },
            context.fixedInput.clockSec,
          ),
        ),
      ]
    : componentResearchEvidence(context, "dependencies");
  let status: V9FactStatusV2;
  if (overlay.diagnostics.graphState === "valid") {
    assertKnownComponentEvidenceCurrent(context, "dependencies", evidenceIds);
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.dependencies.effective-set"),
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  } else {
    status = missingLocalFact(context, {
      componentKey: "effective-dependencies",
      reasonCode: "unreviewed-dependency-relationships",
      ownerDomain: "dependency",
      responsibility: "method-unsupported",
      policyRuleId: "v9.dependencies.effective-set",
      message: `The effective dependency graph is ${overlay.diagnostics.graphState}.`,
      observationState: "bounded-unknown",
      evidenceRefIds: evidenceIds,
    }).status;
  }
  return {
    status,
    sourceGenerationId: source.generationId,
    source: overlay.source,
    baseSource: overlay.baseSource,
    dependencyFromLive: overlay.dependencyFromLive,
    mappedLiveReserveWeight: overlay.mappedLiveReserveWeight,
    fallbackReason: overlay.fallbackReason,
    edges: overlay.edges.map((edge) => {
      const economicRole = edge.economicRole ?? defaultV9DependencyEconomicRole(edge.dependencyType);
      return {
        edgeKey: canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId, economicRole),
        upstreamAssetId: edge.upstreamAssetId,
        dependencyType: edge.dependencyType,
        pathKind: dependencyPathKind(economicRole),
        weight: edge.weight,
        economicRole,
        evidenceRefIds: evidenceIds,
        failureDomains: edge.failureDomains,
      };
    }),
    diagnostics: overlay.diagnostics,
  };
}

export function computeSafetyScoreV9ReserveExposureKey(slice: ReserveSlice): string {
  return `reserve:${digest("safety-score-v9.reserve-exposure-key.v1", {
    name: slice.name.trim(),
    coinId: slice.coinId ?? null,
    dependencyType: slice.depType ?? null,
  }).slice(0, 24)}`;
}

function reserveSourceEvidence(
  context: AssetBuildContext,
  exposureKey: string,
  slices: readonly ReserveSlice[],
): string {
  const source = context.extension.sources.liveReserves;
  const provenance = context.fixedInput.liveReserveProvenanceMap[context.asset.assetId];
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:reserve:${exposureKey}`,
        sourceId: provenance?.source ?? "report-cards-live-reserves",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: provenance?.fetchedAt ?? source.observedAtSec,
        contentSha256: digest("safety-score-v9.reserve-exposure.v1", slices),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function assertCompatibleReserveClassification(
  assetId: string,
  raw: ReserveSlice,
  classification: z.infer<typeof ReserveClassificationSchema> | undefined,
): void {
  if (!classification) return;
  for (const [rawField, overlayField] of [
    [raw.assetClass, classification.assetClass],
    [raw.issuerOrObligor, classification.issuerOrObligorKey],
    [raw.liquidityHorizon, classification.liquidityHorizon],
    [raw.maturityDaysMax, classification.maturityDaysMax],
  ] as const) {
    if (rawField !== undefined && overlayField !== null && rawField !== overlayField) {
      throw new Error(`Reserve classification overlay conflicts with exact base facts for ${assetId}`);
    }
  }
}

function buildReserves(context: AssetBuildContext): {
  reserveStatus: V9FactStatusV2;
  reserveExposures: V9ReserveExposureFactV2[];
} {
  if (context.asset.reserveApplicability.state === "not-applicable") {
    if (
      (context.fixedInput.liveReserveMap[context.asset.assetId] ?? []).length > 0 ||
      context.asset.reviewedStaticReserveRows != null
    ) {
      throw new Error(`Reserve applicability for ${context.asset.assetId} conflicts with captured reserve rows`);
    }
    return {
      reserveStatus: createV9FactStatus({
        applicability: notApplicableV9Fact(
          "v9.backing.reserve-composition",
          context.asset.reserveApplicability.rationale,
        ),
        observationState: "known",
        evidenceRefIds: [researchEvidence(context)],
      }),
      reserveExposures: [],
    };
  }

  const liveSlices = context.fixedInput.liveReserveMap[context.asset.assetId] ?? [];
  const reviewedStatic = liveSlices.length === 0 ? (context.asset.reviewedStaticReserveRows ?? null) : null;
  const slices = reviewedStatic?.rows ?? liveSlices;
  if (slices.length === 0) {
    return {
      reserveStatus: missingLocalFact(context, {
        componentKey: "reserve-composition",
        reasonCode: "missing-reserve-composition",
        ownerDomain: "backing",
        responsibility: "issuer-undisclosed",
        policyRuleId: "v9.backing.reserve-composition",
        message: "No reserve composition is present in the exact fixed input.",
      }).status,
      reserveExposures: [],
    };
  }

  const grouped = new Map<string, ReserveSlice[]>();
  for (const slice of slices) {
    if (!slice.name.trim()) throw new Error(`Reserve slice for ${context.asset.assetId} has no stable identity`);
    const key = computeSafetyScoreV9ReserveExposureKey(slice);
    grouped.set(key, [...(grouped.get(key) ?? []), slice]);
  }
  const classificationByKey = new Map(
    context.asset.reserveClassifications.map((classification) => [classification.exposureKey, classification]),
  );
  const consumedClassifications = new Set<string>();
  const exposures: V9ReserveExposureFactV2[] = [];
  const envelopeGapIds: string[] = [];
  const envelopeEvidenceIds: string[] = [];
  if (
    reviewedStatic &&
    !context.asset.componentEvidence.some((binding) => binding.componentKey === "reviewed-static-reserves")
  ) {
    throw new Error(`Reviewed static reserve admission has no bound evidence for ${context.asset.assetId}`);
  }
  const reviewedStaticEvidenceIds = reviewedStatic
    ? componentResearchEvidence(context, "reviewed-static-reserves")
    : [];

  for (const [exposureKey, groupedSlices] of [...grouped].sort(([left], [right]) => compareText(left, right))) {
    const raw = groupedSlices[0]!;
    if (
      groupedSlices.some(
        (slice) =>
          stableJsonStringifyV1({ ...slice, pct: undefined }) !== stableJsonStringifyV1({ ...raw, pct: undefined }),
      )
    ) {
      throw new Error(`Reserve exposure identity ${exposureKey} is ambiguous for ${context.asset.assetId}`);
    }
    const weight = groupedSlices.reduce((sum, slice) => sum + slice.pct / 100, 0);
    if (weight > 1.000001) throw new Error(`Reserve exposure ${exposureKey} exceeds full notional weight`);
    const classification = classificationByKey.get(exposureKey);
    if (classification) consumedClassifications.add(exposureKey);
    assertCompatibleReserveClassification(context.asset.assetId, raw, classification);
    const evidenceIds = reviewedStatic
      ? reviewedStaticEvidenceIds
      : [reserveSourceEvidence(context, exposureKey, groupedSlices)];
    const reviewedNonLink = classification?.trackedAssetDisposition === "reviewed-non-link";
    const trackedAssetId = reviewedNonLink
      ? null
      : (raw.coinId ?? classification?.trackedAssetId ?? null);
    const issuerOrObligorKey = classification?.issuerOrObligorKey ?? raw.issuerOrObligor ?? null;
    const assetClass = classification?.assetClass ?? raw.assetClass ?? (trackedAssetId ? ("stablecoin" as const) : null);
    const failureDomains = stableFailureDomains([
      ...(classification?.failureDomains ?? []),
      ...(issuerOrObligorKey ? [{ kind: "reserve-issuer" as const, key: issuerOrObligorKey }] : []),
      ...(trackedAssetId ? [{ kind: "reserve-issuer" as const, key: `asset:${trackedAssetId}` }] : []),
    ]);
    const classificationKnown = assetClass !== null && failureDomains.length > 0;
    let status: V9FactStatusV2;
    if (!classificationKnown) {
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}`,
          reasonCode: "material-reserve-slice-unstructured",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-classification",
          observationState: "bounded-unknown",
          responsibility: "integration-missing",
          path: collateralExposureV9Path(exposureKey),
          message: "The captured reserve slice lacks a complete v9 classification or failure-domain identity.",
          evidenceRefIds: evidenceIds,
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "bounded-unknown",
        evidenceRefIds: evidenceIds,
        gapIds: [gapId],
      });
    } else if (evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")) {
      const gapId = addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}:stale`,
          reasonCode: "partial-reserve-review",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-freshness",
          observationState: "stale",
          responsibility: "producer-failed",
          path: collateralExposureV9Path(exposureKey),
          message: "The last-known reserve exposure is older than the v9 freshness bound.",
          evidenceRefIds: evidenceIds,
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "stale",
        evidenceRefIds: evidenceIds,
        gapIds: [gapId],
      });
    } else {
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "known",
        evidenceRefIds: evidenceIds,
      });
    }
    envelopeEvidenceIds.push(...evidenceIds);
    exposures.push({
      exposureKey,
      classificationKey: classification?.classificationKey ?? `base:${exposureKey}`,
      sourceGenerationId: reviewedStatic
        ? context.extension.sources.researchOverlays.generationId
        : context.extension.sources.liveReserves.generationId,
      provenance: reviewedStatic ? reviewedStatic.provenance : "live",
      ...(reviewedStatic
        ? {
            evidenceClass: reviewedStatic.evidenceClass,
          }
        : {}),
      status,
      name: raw.name.trim(),
      weight,
      trackedAssetId,
      assetClass,
      issuerOrObligorKey,
      riskFactors: classification?.riskFactors ?? raw.riskFactors ?? [],
      liquidityHorizon: classification?.liquidityHorizon ?? raw.liquidityHorizon ?? null,
      maturityDaysMax: classification?.maturityDaysMax ?? raw.maturityDaysMax ?? null,
      failureDomains,
    });
  }
  const unconsumed = [...classificationByKey.keys()].filter((key) => !consumedClassifications.has(key));
  if (unconsumed.length > 0) {
    throw new Error(
      `Reserve classifications do not match captured exposures for ${context.asset.assetId}: ${unconsumed}`,
    );
  }
  return {
    reserveStatus: createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.reserve-composition"),
      observationState: envelopeGapIds.length > 0 ? "bounded-unknown" : "known",
      evidenceRefIds: [...new Set(envelopeEvidenceIds)],
      gapIds: envelopeGapIds,
    }),
    reserveExposures: exposures,
  };
}

function reconcileCollateralDependencyMappings(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV3,
  reserveExposures: readonly V9ReserveExposureFactV2[],
): V9EffectiveDependenciesV3 {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const exposure of reserveExposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  const mappingIssues = dependencies.edges.flatMap((edge) => {
    if (edge.economicRole !== "basket-exposure") return [];
    const mappedWeight = mappedWeightByUpstream.get(edge.upstreamAssetId);
    if (mappedWeight === undefined) return [`collateral-edge-exposure-unmapped:${edge.upstreamAssetId}`];
    if (Math.abs(mappedWeight - edge.weight) > 0.000001) {
      return [`collateral-edge-exposure-weight-mismatch:${edge.upstreamAssetId}`];
    }
    return [];
  });
  if (mappingIssues.length === 0) return dependencies;

  const evidenceRefIds = [
    ...new Set([
      ...dependencies.status.evidenceRefIds,
      ...reserveExposures.flatMap((exposure) => exposure.status.evidenceRefIds),
    ]),
  ].sort(compareText);
  const status =
    dependencies.status.observationState === "known"
      ? missingLocalFact(context, {
          componentKey: "effective-dependencies",
          reasonCode: "unreviewed-dependency-relationships",
          ownerDomain: "dependency",
          responsibility: "integration-missing",
          policyRuleId: "v9.dependencies.edge-exposure-mapping",
          message: "A collateral dependency edge lacks an exact mapping to the captured reserve exposures.",
          observationState: "bounded-unknown",
          evidenceRefIds,
        }).status
      : dependencies.status;
  return {
    ...dependencies,
    status,
    diagnostics: {
      graphState: dependencies.diagnostics.graphState === "valid" ? "unresolved" : dependencies.diagnostics.graphState,
      issueCodes: [...new Set([...dependencies.diagnostics.issueCodes, ...mappingIssues])].sort(compareText),
      sccMemberAssetIds: dependencies.diagnostics.sccMemberAssetIds,
    },
  };
}

function scopeFailureDomains(
  observation: ExitRouteObservation,
  lane: "dex" | "redemption",
): V9FailureDomainRef[] {
  const scope = observation.scope;
  if (scope.kind === "chain-contract") {
    return [
      { kind: "chain", key: scope.chain },
      {
        kind: lane === "dex" ? "dex-protocol" : "redemption-rail",
        key: scope.protocol,
      },
    ];
  }
  if (scope.kind === "venue") return [{ kind: "dex-protocol", key: scope.protocol }];
  if (scope.kind === "issuer") return [{ kind: "redemption-rail", key: scope.issuerId }];
  return [
    { kind: "redemption-rail", key: scope.protocol },
    ...(scope.chain ? [{ kind: "chain" as const, key: scope.chain }] : []),
  ];
}

function routeEvidence(
  context: AssetBuildContext,
  lane: "dex" | "redemption",
  observation: ExitRouteObservation,
  disposition: "observed" | "rejected",
  rejection: z.infer<typeof RejectionSchema> | null,
  retained: boolean,
): string {
  const generationId = lane === "dex" ? context.fixedInput.dexGenerationId : context.fixedInput.redemptionGenerationId;
  // Documented-terms evidence lives on the review cadence the policy states
  // (semantic.exit.documentedTermsMaxAgeSec), not the producer cron cadence.
  const maxAgeSec =
    lane === "dex"
      ? observation.evidenceKind === "measured-executable-depth"
        ? Math.max(
            context.extension.routeFreshness.dexMaxAgeSec,
            getDexMeasuredExecutionFreshnessMaxSec(observation.adapterProfileId ?? ""),
          )
        : context.extension.routeFreshness.dexMaxAgeSec
      : observation.evidenceKind === "documented-terms"
        ? context.extension.routeFreshness.documentedTermsMaxAgeSec
        : context.extension.routeFreshness.redemptionMaxAgeSec;
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:route:${lane}:${observation.routeId}:${retained ? "retained" : "base"}`,
        sourceId: retained ? "safety-score-v9-retained-route-overlay" : `report-cards-${lane}-route-observation`,
        sourceGenerationId: retained ? context.extension.sources.researchOverlays.generationId : generationId,
        disposition,
        observedAtSec: observation.observedAt,
        contentSha256: digest("safety-score-v9.route-observation.v1", observation),
        maxAgeSec,
        rejection,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function executionCostKey(point: { requestedNotionalUsd: number; maxCostBps: number }): string {
  return `${point.maxCostBps}:${point.requestedNotionalUsd}`;
}

function outputValuationEvidence(
  context: AssetBuildContext,
  routeKey: string,
  valuation: z.infer<typeof RouteValuationSchema>,
): string {
  return addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:route-valuation:${routeKey}`,
        sourceId: valuation.sourceId,
        sourceGenerationId: valuation.sourceGenerationId,
        disposition: "observed",
        observedAtSec: valuation.observedAtSec,
        url: valuation.url,
        contentSha256: valuation.contentSha256,
        maxAgeSec: valuation.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
}

function resolvedBaseRouteOutput(observation: ExitRouteObservation): {
  kind: "tracked-stablecoin" | "fiat" | "collateral";
  assetKeys: string[];
} | null {
  const output = observation.output;
  if (output.kind !== "tracked-stablecoin" && output.kind !== "fiat" && output.kind !== "collateral") return null;
  const assetKeys = resolvedExitRouteOutputAssetKeys(output);
  return assetKeys ? { kind: output.kind, assetKeys } : null;
}

function assertRouteOutputReviewMatchesBase(
  assetId: string,
  routeKey: string,
  observation: ExitRouteObservation,
  review: z.infer<typeof RouteOutputReviewSchema> | null,
): void {
  const base = resolvedBaseRouteOutput(observation);
  if (!base || !review) return;
  if (base.kind !== review.kind || stableJsonStringifyV1(base.assetKeys) !== stableJsonStringifyV1(review.assetKeys)) {
    throw new Error(`Route output review conflicts with exact base facts for ${assetId}:${routeKey}`);
  }
}

function routeGap(
  context: AssetBuildContext,
  routeKey: string,
  suffix: string,
  observationState: Exclude<V9FactStatusV2["observationState"], "known">,
  reasonCode: V9FactGapV3["reasonCode"],
  responsibility: V9EvidenceResponsibility,
  message: string,
  evidenceRefIds: readonly string[],
): string {
  return addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:route:${routeKey}:${suffix}`,
      reasonCode,
      ownerDomain: "exit",
      policyRuleId: suffix === "output" ? "v9.exit.output-valuation" : "v9.exit.same-notional-route",
      observationState,
      responsibility,
      path: optionalExitV9Path(routeKey),
      message,
      evidenceRefIds,
    }),
  );
}

function buildRoute(
  context: AssetBuildContext,
  args: {
    lane: "dex" | "redemption";
    observation: ExitRouteObservation;
    review: z.infer<typeof RouteReviewSchema> | undefined;
    disposition: "observed" | "rejected";
    rejection: z.infer<typeof RejectionSchema> | null;
    retained: boolean;
  },
): V9ExitRouteFactV2 {
  const generationId =
    args.lane === "dex" ? context.fixedInput.dexGenerationId : context.fixedInput.redemptionGenerationId;
  const routeKey = canonicalV9RouteKey(args.lane, generationId, args.observation.routeId);
  const evidenceId = routeEvidence(
    context,
    args.lane,
    args.observation,
    args.disposition,
    args.rejection,
    args.retained,
  );
  const evidence = context.evidence.get(evidenceId)!;
  const baseDomains = scopeFailureDomains(args.observation, args.lane);

  if (!args.review) {
    const gapId = routeGap(
      context,
      routeKey,
      "semantics",
      args.disposition === "rejected" ? "unsupported" : "bounded-unknown",
      "unsupported-same-notional-route",
      args.disposition === "rejected" ? "method-unsupported" : "integration-missing",
      "The base observation lacks reviewed v9 access, execution-cost, settlement, resource, and output semantics.",
      [evidenceId],
    );
    const status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.exit.same-notional-route"),
      observationState: args.disposition === "rejected" ? "unsupported" : "bounded-unknown",
      evidenceRefIds: [evidenceId],
      gapIds: [gapId],
    });
    return {
      routeKey,
      routeId: args.observation.routeId,
      lane: args.lane,
      sourceGenerationId: generationId,
      routeFamily: args.observation.routeFamily,
      holderAccess: "unknown",
      executionModel: "unknown",
      executionCertainty: "unknown",
      modelConfidence: "low",
      observationConfidence: args.observation.confidence,
      observationHistory: args.observation.observationHistory ?? null,
      evidenceKind: args.observation.evidenceKind,
      ...(args.observation.feeEvidence ? { feeEvidence: args.observation.feeEvidence } : {}),
      coverageClass: "diagnostic",
      capacityScoringHorizon: "unknown",
      settlementModel: "unknown",
      settlementSlaSec: null,
      queueDepthUsd: null,
      dailyLimitUsd: null,
      minRedeemUsd: null,
      settlementEvidenceRefIds: [],
      physicalResourceKeys: [],
      status,
      scoreEligible: false,
      request: null,
      capacityCurve: [],
      output: {
        status,
        kind: "unknown",
        assetKeys: [],
        basketWeights: [],
        valuation: null,
      },
      failureDomains: baseDomains,
    };
  }

  const costByKey = new Map(args.review.executionCosts.map((point) => [executionCostKey(point), point]));
  const rawCurve = args.observation.capacityCurve ?? [
    {
      requestedNotionalUsd: args.observation.requestedNotionalUsd,
      maxCostBps: args.observation.maxCostBps,
      executableUsd: args.observation.executableUsd,
      completionRatio: args.observation.completionRatio,
    },
  ];
  const capacityCurve = rawCurve.map((point) => {
    const cost = costByKey.get(executionCostKey(point));
    if (!cost) throw new Error(`Missing execution cost for ${context.asset.assetId}:${routeKey}`);
    costByKey.delete(executionCostKey(point));
    return { ...point, executionCostBps: cost.executionCostBps };
  });
  if (costByKey.size > 0) throw new Error(`Unmatched execution costs for ${context.asset.assetId}:${routeKey}`);

  let routeState: V9FactStatusV2["observationState"] = "known";
  if (args.disposition === "rejected") routeState = "unsupported";
  else if (evidence.freshness.state === "stale") routeState = "stale";
  const routeGapId =
    routeState === "known"
      ? null
      : routeGap(
          context,
          routeKey,
          routeState === "stale" ? "stale" : "rejected",
          routeState,
          routeState === "stale" ? "missing-runtime-route-evidence" : "unsupported-same-notional-route",
          routeState === "stale" ? "producer-failed" : "method-unsupported",
          routeState === "stale"
            ? "The retained route observation is older than the lane freshness bound."
            : "The retained route observation was rejected by its producer or review process.",
          [evidenceId],
        );
  const routeStatus = createV9FactStatus({
    applicability: requiredV9Applicability("v9.exit.same-notional-route"),
    observationState: routeState,
    evidenceRefIds: [evidenceId],
    gapIds: routeGapId ? [routeGapId] : [],
  });

  assertRouteOutputReviewMatchesBase(context.asset.assetId, routeKey, args.observation, args.review.output);

  let output: V9ExitRouteFactV2["output"];
  if (args.disposition === "rejected") {
    output = {
      status: routeStatus,
      kind: "unknown",
      assetKeys: [],
      basketWeights: [],
      valuation: null,
    };
  } else if (!args.review.output?.valuation) {
    const gapId = routeGap(
      context,
      routeKey,
      "output",
      "missing",
      "unresolved-exit-output",
      "integration-missing",
      "The route output does not have an explicit same-notional USD valuation.",
      [evidenceId],
    );
    output = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.exit.output-valuation"),
        observationState: "missing",
        evidenceRefIds: [],
        gapIds: [gapId],
      }),
      kind: args.review.output?.kind ?? "unknown",
      assetKeys: args.review.output?.assetKeys ?? [],
      basketWeights: args.review.output?.basketWeights ?? [],
      valuation: null,
    };
  } else {
    const reviewOutput = args.review.output;
    const valuationInput = reviewOutput.valuation!;
    const valuationEvidenceId = outputValuationEvidence(context, routeKey, valuationInput);
    const valuationEvidence = context.evidence.get(valuationEvidenceId)!;
    const outputState = valuationEvidence.freshness.state === "stale" ? "stale" : "known";
    const outputGapId =
      outputState === "stale"
        ? routeGap(
            context,
            routeKey,
            "output",
            "stale",
            "unresolved-exit-output",
            "producer-failed",
            "The last-known route output valuation is older than its freshness bound.",
            [valuationEvidenceId],
          )
        : null;
    output = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.exit.output-valuation"),
        observationState: outputState,
        evidenceRefIds: [valuationEvidenceId],
        gapIds: outputGapId ? [outputGapId] : [],
      }),
      kind: reviewOutput.kind,
      assetKeys: reviewOutput.assetKeys,
      basketWeights: reviewOutput.basketWeights,
      valuation: {
        basis: valuationInput.basis,
        referenceAssetKey: valuationInput.referenceAssetKey,
        unitValueUsd: valuationInput.unitValueUsd,
        expectedUnitValueUsd: valuationInput.expectedUnitValueUsd,
        valueRetentionRatio: valuationInput.unitValueUsd / valuationInput.expectedUnitValueUsd,
        sourceId: valuationInput.sourceId,
        sourceGenerationId: valuationInput.sourceGenerationId,
        observedAtSec: valuationInput.observedAtSec,
        asOfSec: context.fixedInput.clockSec,
        confidence: valuationInput.confidence,
        freshness: valuationEvidence.freshness,
        evidenceRefIds: [valuationEvidenceId],
      },
    };
  }

  const scoreEligible =
    args.observation.scoreEligible &&
    routeState === "known" &&
    output.status.observationState === "known" &&
    args.review.coverageClass !== "diagnostic";
  return {
    routeKey,
    routeId: args.observation.routeId,
    lane: args.lane,
    sourceGenerationId: generationId,
    routeFamily: args.observation.routeFamily,
    holderAccess: args.review.holderAccess,
    executionModel: args.review.executionModel,
    executionCertainty: args.review.executionCertainty,
    modelConfidence: args.review.modelConfidence,
    observationConfidence: args.observation.confidence,
    observationHistory: args.observation.observationHistory ?? null,
    evidenceKind: args.observation.evidenceKind,
    ...(args.observation.feeEvidence ? { feeEvidence: args.observation.feeEvidence } : {}),
    coverageClass: args.review.coverageClass,
    capacityScoringHorizon: args.review.capacityScoringHorizon ?? "unknown",
    settlementModel: args.review.settlementModel,
    settlementSlaSec: args.review.settlementSlaSec,
    queueDepthUsd: args.review.queueDepthUsd ?? null,
    dailyLimitUsd: args.review.dailyLimitUsd ?? null,
    minRedeemUsd: args.review.minRedeemUsd ?? null,
    settlementEvidenceRefIds: [evidenceId],
    physicalResourceKeys: args.review.physicalResourceKeys,
    status: routeStatus,
    scoreEligible,
    request: {
      requestedNotionalUsd: args.observation.requestedNotionalUsd,
      maxCostBps: args.observation.maxCostBps,
      settlementHorizonSec: Math.max(
        args.observation.settlementHorizonSec,
        args.review.settlementHorizonSec ?? 0,
      ),
    },
    capacityCurve,
    output,
    failureDomains: stableFailureDomains([...baseDomains, ...args.review.failureDomains]),
  };
}

function buildRoutes(context: AssetBuildContext): {
  exitStatus: V9FactStatusV2;
  exitRoutes: V9ExitRouteFactV2[];
} {
  const reviewByKey = new Map(context.asset.routeReviews.map((review) => [`${review.lane}:${review.routeId}`, review]));
  const consumedReviews = new Set<string>();
  const observations: Array<{
    lane: "dex" | "redemption";
    observation: ExitRouteObservation;
    disposition: "observed" | "rejected";
    rejection: z.infer<typeof RejectionSchema> | null;
    retained: boolean;
  }> = [];
  const dexRows = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservations ?? [];
  observations.push(
    ...dexRows.map((observation) => ({
      lane: "dex" as const,
      observation,
      disposition: "observed" as const,
      rejection: null,
      retained: false,
    })),
  );
  const redemptionRows =
    context.fixedInput.redemptionBackstopMap[context.asset.assetId]?.capacityProfile?.exitRouteObservations ?? [];
  observations.push(
    ...redemptionRows.map((observation) => ({
      lane: "redemption" as const,
      observation,
      disposition: "observed" as const,
      rejection: null,
      retained: false,
    })),
  );
  observations.push(
    ...context.asset.retainedRoutes.map((row) => ({
      lane: row.lane,
      observation: row.observation,
      disposition: row.disposition,
      rejection: row.rejection,
      retained: true,
    })),
  );
  observations.sort(
    (left, right) =>
      compareText(left.lane, right.lane) ||
      compareText(left.observation.routeId, right.observation.routeId) ||
      Number(left.retained) - Number(right.retained),
  );
  const routeKeys = observations.map((row) => `${row.lane}:${row.observation.routeId}`);
  const duplicate = routeKeys.find((key, index) => routeKeys.indexOf(key) !== index);
  if (duplicate) throw new Error(`Duplicate base or retained v9 route for ${context.asset.assetId}:${duplicate}`);

  const routes = observations.map((row) => {
    const reviewKey = `${row.lane}:${row.observation.routeId}`;
    const review = reviewByKey.get(reviewKey);
    if (review) consumedReviews.add(reviewKey);
    return buildRoute(context, { ...row, review });
  });
  const unconsumedReviews = [...reviewByKey.keys()].filter((key) => !consumedReviews.has(key));
  if (unconsumedReviews.length > 0) {
    throw new Error(
      `Route reviews do not match captured observations for ${context.asset.assetId}: ${unconsumedReviews}`,
    );
  }
  if (routes.length === 0) {
    // A reviewed-complete DEX surface with zero retained pools and no
    // redemption row is KNOWN negative evidence (score-defined zero exit),
    // not missing evidence; missing is reserved for incomplete coverage
    // (VER-006).
    const emptyCoverage = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservationCoverage;
    const emptySurfaceComplete =
      emptyCoverage != null &&
      emptyCoverage.status === "populated" &&
      emptyCoverage.retainedPoolCount === 0 &&
      emptyCoverage.unsupportedPoolCount === 0;
    if (emptySurfaceComplete) {
      // Known-empty negative evidence must carry the DEX producer's observation
      // time, not the scoring clock: a stale empty surface is not a current
      // "known" zero-exit fact but a bounded-unknown/stale one (VER2-007). Fresh
      // populated 0/0 coverage remains known negative evidence (exit 0).
      const coverageEvidenceId = addEvidence(
        context,
        createV9EvidenceReference(
          {
            evidenceId: `${context.asset.assetId}:exit-route-observation-coverage`,
            sourceId: "report-cards-dex-route-observation",
            sourceGenerationId: context.fixedInput.dexGenerationId,
            disposition: "observed",
            observedAtSec: context.fixedInput.dexLiqMap[context.asset.assetId]!.updatedAt,
            contentSha256: digest("safety-score-v9.exit-route-observation-coverage.v1", emptyCoverage),
            maxAgeSec: context.extension.routeFreshness.dexMaxAgeSec,
          },
          context.fixedInput.clockSec,
        ),
      );
      const coverageStale = context.evidence.get(coverageEvidenceId)!.freshness.state === "stale";
      const staleGapId = coverageStale
        ? addGap(
            context,
            createV9FactGapV3({
              gapId: `${context.asset.assetId}:gap:exit-route-observation-coverage:stale`,
              reasonCode: "missing-runtime-route-evidence",
              ownerDomain: "exit",
              policyRuleId: "v9.exit.same-notional-route",
              observationState: "stale",
              responsibility: "producer-failed",
              path: { kind: "local-component", componentKey: "exit-routes" },
              message: "The known-empty DEX exit-route coverage observation is older than the lane freshness bound.",
              evidenceRefIds: [coverageEvidenceId],
            }),
          )
        : null;
      return {
        exitStatus: createV9FactStatus({
          applicability: requiredV9Applicability("v9.exit.same-notional-route"),
          observationState: coverageStale ? "stale" : "known",
          evidenceRefIds: [coverageEvidenceId],
          gapIds: staleGapId ? [staleGapId] : [],
        }),
        exitRoutes: [],
      };
    }
    return {
      exitStatus: missingLocalFact(context, {
        componentKey: "exit-routes",
        reasonCode: "missing-runtime-route-evidence",
        ownerDomain: "exit",
        responsibility: "producer-failed",
        policyRuleId: "v9.exit.same-notional-route",
        message: "No exact DEX, redemption, or retained route observation is available.",
      }).status,
      exitRoutes: [],
    };
  }
  const statuses = routes.flatMap((route) => [route.status, route.output.status]);
  const gapIds = [...new Set(statuses.flatMap((status) => status.gapIds))];
  const evidenceRefIds = [...new Set(statuses.flatMap((status) => status.evidenceRefIds))];
  // "known" asserts the whole exit surface is observed (it upgrades evidence
  // level and arms the reviewed-complete zero-score path), so it additionally
  // requires every reviewed score-eligible DEX capability pool to carry an
  // observation. Structurally non-executable shaped rows remain diagnostics.
  // A portfolio holding only diagnostic routes over an incompletely observed
  // DEX surface stays bounded-unknown. A missing redemption row does not
  // demote the state: absent redemption evidence can only understate the
  // score, and the zero-score path still requires an observed portfolio.
  const coverage = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservationCoverage;
  // "known" upgrades the exit surface and arms the reviewed-complete zero-score
  // path, so it requires populated DEX coverage. An `unknown`/`unsupported`
  // surface stays bounded-unknown even when its retained-pool count is zero: a
  // score-ineligible diagnostic route must never certify unobserved coverage
  // nor let evidence arrival drop the score below the bounded-unknown floor
  // (VER2-006).
  const dexSurfaceComplete =
    coverage != null &&
    coverage.status === "populated" &&
    (coverage.retainedPoolCount === 0 || isDexExitRouteCoverageComplete(coverage));
  const portfolioGapIds = [...gapIds];
  if (!dexSurfaceComplete) {
    portfolioGapIds.push(
      addGap(
        context,
        createV9FactGapV3({
          gapId: `${context.asset.assetId}:gap:exit-portfolio-coverage`,
          reasonCode: "incomplete-dex-route-coverage",
          ownerDomain: "exit",
          policyRuleId: "v9.exit.same-notional-route",
          observationState: "bounded-unknown",
          responsibility: "producer-failed",
          path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
          message: "Reviewed DEX execution-capability pools do not all carry score-eligible exact route observations.",
          evidenceRefIds,
        }),
      ),
    );
  }
  return {
    exitStatus: createV9FactStatus({
      applicability: requiredV9Applicability("v9.exit.same-notional-route"),
      observationState: portfolioGapIds.length > 0 ? "bounded-unknown" : "known",
      evidenceRefIds,
      gapIds: portfolioGapIds,
    }),
    exitRoutes: routes,
  };
}

function buildControls(context: AssetBuildContext): {
  controlStatus: V9FactStatusV2;
  controls: V9DeploymentControlFactV2[];
} {
  const review = context.asset.controlReview;
  if (review === null) {
    return {
      controlStatus: missingLocalFact(context, {
        componentKey: "deployment-controls",
        reasonCode: "missing-upgradeability-review",
        ownerDomain: "control",
        responsibility: "integration-missing",
        policyRuleId: "v9.control.review",
        message: "No reviewed deployment-control posture is present in the v9 overlay.",
      }).status,
      controls: [],
    };
  }
  const evidenceIds = componentResearchEvidence(context, "control");
  if (review.state === "no-privileged-controls") {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
    return {
      controlStatus: createV9FactStatus({
        applicability: notApplicableV9Fact("v9.control.review", review.rationale),
        observationState: "known",
        evidenceRefIds: evidenceIds,
      }),
      controls: [],
    };
  }
  const status =
    review.state === "reviewed-controls"
      ? createV9FactStatus({
          applicability: requiredV9Applicability("v9.control.review"),
          observationState: "known",
          evidenceRefIds: evidenceIds,
        })
      : missingLocalFact(context, {
          componentKey: "deployment-controls",
          reasonCode: "unresolved-control-identity",
          ownerDomain: "control",
          responsibility: "issuer-undisclosed",
          policyRuleId: "v9.control.review",
          message: review.rationale,
          observationState: "bounded-unknown",
          evidenceRefIds: evidenceIds,
        }).status;
  const hasKnownControl = review.controls.some(controlCanCarryKnownStatus);
  if (review.state === "reviewed-controls" || hasKnownControl) {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
  }
  return {
    controlStatus: status,
    controls: review.controls.map((control) => {
      const controlStatus = controlCanCarryKnownStatus(control)
        ? createV9FactStatus({
            applicability: requiredV9Applicability("v9.control.review"),
            observationState: "known",
            evidenceRefIds: evidenceIds,
          })
        : boundedControlSemanticsStatus(context, control, evidenceIds);
      return {
        ...control,
        sourceGenerationId: context.extension.sources.researchOverlays.generationId,
        status: controlStatus,
      };
    }),
  };
}

function controlCanCarryKnownStatus(control: ExtensionControlOverlay): boolean {
  return (
    control.authority !== null &&
    control.authority.model !== "unknown" &&
    control.failureDomains.length > 0 &&
    control.capSemantics.kind !== "unknown" &&
    control.claimImpairment !== "unknown" &&
    control.economicLossScope !== "unknown" &&
    control.incidentState !== "unknown"
  );
}

function boundedControlSemanticsStatus(
  context: AssetBuildContext,
  control: ExtensionControlOverlay,
  evidenceRefIds: readonly string[],
): V9FactStatusV2 {
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:deployment-control:${control.controlKey}`,
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "v9.control.review",
      observationState: "bounded-unknown",
      responsibility: "issuer-undisclosed",
      path:
        control.scope === "deployment"
          ? { kind: "deployment-control", deploymentKey: control.deploymentKey, controlKey: control.controlKey }
          : { kind: "local-component", componentKey: `control:${control.controlKey}` },
      message: "The control inventory is known, but this control's authority or economic semantics remain unresolved.",
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability: requiredV9Applicability("v9.control.review"),
    observationState: "bounded-unknown",
    evidenceRefIds,
    gapIds: [gapId],
  });
}

function normalizeEconomicControlStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
  reasonCode: V9FactGapV3["reasonCode"],
): V9FactStatusV2 {
  const bindingKey = `economic-control:${componentKey}`;
  const evidenceIds =
    original.observationState === "known" ||
    original.observationState === "stale" ||
    original.observationState === "bounded-unknown"
      ? componentResearchEvidence(context, bindingKey)
      : [];
  if (original.observationState === "known") {
    assertKnownComponentEvidenceCurrent(context, bindingKey, evidenceIds);
    return createV9FactStatus({
      applicability: original.applicability,
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  }
  const keepEvidence = original.observationState === "stale" || original.observationState === "bounded-unknown";
  if (
    original.observationState === "stale" &&
    !evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")
  ) {
    throw new Error(
      `Economic-control review ${context.asset.assetId}:${componentKey} is stale but its source is current`,
    );
  }
  const evidenceRefIds = keepEvidence ? evidenceIds : [];
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:economic-control:${componentKey}`,
      reasonCode,
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: reviewedGapResponsibility(original.observationState),
      path: { kind: "local-component", componentKey: `economic-control:${componentKey}` },
      message: `The ${componentKey} economic-control review is not a current known fact.`,
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability:
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability,
    observationState: original.observationState,
    evidenceRefIds,
    gapIds: [gapId],
  });
}

function buildEconomicControlReview(context: AssetBuildContext): V9EconomicControlReviewV2 {
  const review = context.asset.economicControlReview;
  if (review === null) {
    return {
      mint: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:mint",
          reasonCode: "missing-mint-authority",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.mint-review",
          message: "Mint reconciliation and upgrade linkage have not been reviewed.",
        }).status,
        controlKey: null,
        reconciliation: "unknown",
        supervision: "unknown",
        upgrade: { state: "unknown", controlKey: null },
      },
      oracle: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:oracle",
          reasonCode: "missing-oracle-profile",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.oracle-review",
          message: "Oracle tier and branch applicability have not been reviewed.",
        }).status,
        tier: null,
        branches: [],
      },
      bridge: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:bridge",
          reasonCode: "missing-bridge-routes",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.control.bridge-review",
          message: "Bridge-route control tiers have not been reviewed.",
        }).status,
        routes: [],
      },
    };
  }
  const normalized = structuredClone(review);
  normalized.mint.status = normalizeEconomicControlStatus(
    context,
    normalized.mint.status,
    "mint",
    "missing-mint-authority",
  );
  normalized.oracle.status = normalizeEconomicControlStatus(
    context,
    normalized.oracle.status,
    "oracle",
    "missing-oracle-profile",
  );
  normalized.oracle.branches = normalized.oracle.branches.map((branch) => ({
    ...branch,
    status: normalizeEconomicControlStatus(
      context,
      branch.status,
      `oracle:${branch.branch}`,
      "incomplete-oracle-liquidation-branch",
    ),
  }));
  normalized.bridge.status = normalizeEconomicControlStatus(
    context,
    normalized.bridge.status,
    "bridge",
    "missing-bridge-routes",
  );
  return normalized;
}

function normalizeAccessStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
): V9FactStatusV2 {
  const bindingKey = `access:${componentKey}`;
  const evidenceIds =
    original.observationState === "known" ||
    original.observationState === "stale" ||
    original.observationState === "bounded-unknown"
      ? componentResearchEvidence(context, bindingKey)
      : [];
  if (original.observationState === "known") {
    assertKnownComponentEvidenceCurrent(context, bindingKey, evidenceIds);
    return createV9FactStatus({
      applicability: original.applicability,
      observationState: "known",
      evidenceRefIds: evidenceIds,
    });
  }
  const keepEvidence = original.observationState === "stale" || original.observationState === "bounded-unknown";
  if (
    original.observationState === "stale" &&
    !evidenceIds.some((evidenceId) => context.evidence.get(evidenceId)?.freshness.state === "stale")
  ) {
    throw new Error(`Access review ${context.asset.assetId}:${componentKey} is stale but its source is current`);
  }
  const evidenceRefIds = keepEvidence ? evidenceIds : [];
  const gapId = addGap(
    context,
    createV9FactGapV3({
      gapId: `${context.asset.assetId}:gap:access:${componentKey}`,
      reasonCode: "missing-access-review",
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
      responsibility: reviewedGapResponsibility(original.observationState),
      path: { kind: "local-component", componentKey: `access:${componentKey}` },
      message: `The ${componentKey} access/censorship review is not a current known fact.`,
      evidenceRefIds,
    }),
  );
  return createV9FactStatus({
    applicability:
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability,
    observationState: original.observationState,
    evidenceRefIds,
    gapIds: [gapId],
  });
}

function buildAccessReview(context: AssetBuildContext): V9AccessReviewV2 {
  const review = context.asset.accessReview;
  if (review === null) {
    return {
      transfer: {
        status: missingLocalFact(context, {
          componentKey: "access:transfer",
          reasonCode: "missing-access-review",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.access.transfer-review",
          message: "Transfer permissioning posture has not been reviewed.",
        }).status,
        posture: null,
      },
      freeze: {
        status: missingLocalFact(context, {
          componentKey: "access:freeze",
          reasonCode: "missing-access-review",
          ownerDomain: "control",
          responsibility: "integration-missing",
          policyRuleId: "v9.access.freeze-review",
          message: "Direct and upstream freeze reach have not been reviewed.",
        }).status,
        reviews: [],
      },
    };
  }
  const normalized = structuredClone(review);
  normalized.transfer.status = normalizeAccessStatus(context, normalized.transfer.status, "transfer");
  normalized.freeze.status = normalizeAccessStatus(context, normalized.freeze.status, "freeze");
  normalized.freeze.reviews = normalized.freeze.reviews.map((freezeReview) => ({
    ...freezeReview,
    status: normalizeAccessStatus(context, freezeReview.status, `freeze:${freezeReview.reviewKey}`),
  }));
  return normalized;
}

export function deriveSafetyScoreV9PegScore(
  peg: { pegScore: number | null; activeDepeg: boolean; lastEventAt: number | null },
  clockSec: number,
): number | null {
  return deriveV9WindowedPegScore({
    pegScore: peg.pegScore,
    activeDepeg: peg.activeDepeg,
    lastEventAt: peg.lastEventAt,
    clockSec,
    windowSec: V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegHistoryWindowSec,
    quietHistoryFloor: V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegQuietHistoryFloor,
  });
}

function buildPeg(context: AssetBuildContext): V9AssetFactsV2["peg"] {
  const peg = context.fixedInput.pegDataById[context.asset.assetId];
  const reference = context.asset.pegReference;
  const source = context.extension.sources.peg;
  const pegKey = reference
    ? `peg:${reference.referenceKind}:${reference.referenceKey}`
    : `peg:unresolved:${context.asset.assetId}`;
  if (reference?.referenceKind === "nav") {
    // Pure NAV tokens have no fixed peg by design (v8 pure NAV carve-over):
    // the peg fact is a known not-applicable review, and the formula skips
    // the peg multiplier for pegApplicable=false assets.
    return {
      status: createV9FactStatus({
        applicability: notApplicableV9Fact(
          "v9.peg.current",
          "Pure NAV token: the unit tracks fund NAV by design, so no fixed peg reference exists to deviate from.",
        ),
        observationState: "known",
        evidenceRefIds: [researchEvidence(context)],
      }),
      pegKey,
      sourceGenerationId: source.generationId,
      referenceKind: reference.referenceKind,
      referenceKey: reference.referenceKey,
      methodologyVersion: context.fixedInput.methodologyVersion,
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
      trackingSpanDays: null,
      failureDomains: reference.failureDomains,
    };
  }
  if (!peg) {
    return {
      status: missingLocalFact(context, {
        componentKey: "peg",
        reasonCode: "missing-peg-input",
        ownerDomain: "peg",
        responsibility: "producer-failed",
        policyRuleId: "v9.peg.current",
        message: "No peg fact exists for the asset in the exact fixed input.",
      }).status,
      pegKey,
      sourceGenerationId: source.generationId,
      referenceKind: reference?.referenceKind ?? "other",
      referenceKey: reference?.referenceKey ?? `unresolved:${context.asset.assetId}`,
      methodologyVersion: context.fixedInput.methodologyVersion,
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
      trackingSpanDays: null,
      failureDomains: reference?.failureDomains ?? [],
    };
  }
  const observedAtSec = peg.priceObservedAt ?? source.observedAtSec;
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:peg`,
        sourceId: peg.priceSource ?? "report-cards-peg-summary",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec,
        contentSha256: digest("safety-score-v9.peg-fact.v1", peg),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const activeDepegBps = context.fixedInput.activeDepegPeakBpsById[context.asset.assetId] ?? null;
  const pegScore = deriveSafetyScoreV9PegScore(peg, context.fixedInput.clockSec);
  const complete =
    reference !== null &&
    pegScore !== null &&
    peg.currentDeviationBps !== null &&
    (!peg.activeDepeg || activeDepegBps !== null);
  const hasPartialActiveDepegEvidence =
    reference !== null && pegScore !== null && peg.activeDepeg === true && activeDepegBps !== null;
  let status: V9FactStatusV2;
  if (!complete) {
    status = missingLocalFact(context, {
      componentKey: "peg",
      reasonCode: reference === null ? "missing-applicable-peg" : "missing-peg-input",
      ownerDomain: "peg",
      responsibility: reference === null ? "integration-missing" : "producer-failed",
      policyRuleId: "v9.peg.current",
      message: "The peg row lacks an explicit reference, score, deviation, or active-depeg peak.",
      observationState: "bounded-unknown",
      evidenceRefIds: [evidenceId],
    }).status;
  } else if (evidence.freshness.state === "stale") {
    status = missingLocalFact(context, {
      componentKey: "peg",
      reasonCode: "missing-peg-input",
      ownerDomain: "peg",
      responsibility: "producer-failed",
      policyRuleId: "v9.peg.current",
      message: "The last-known peg observation is stale.",
      observationState: "stale",
      evidenceRefIds: [evidenceId],
    }).status;
  } else {
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.peg.current"),
      observationState: "known",
      evidenceRefIds: [evidenceId],
    });
  }
  return {
    status,
    pegKey,
    sourceGenerationId: source.generationId,
    referenceKind: reference?.referenceKind ?? "other",
    referenceKey: reference?.referenceKey ?? `unresolved:${context.asset.assetId}`,
    methodologyVersion: peg.methodologyVersion,
    pegScore: complete || hasPartialActiveDepegEvidence ? pegScore : null,
    // The v8 peg summary reports signed deviation; the v9 peg fact carries the
    // magnitude per its nonnegative schema contract.
    currentDeviationBps: complete && peg.currentDeviationBps !== null ? Math.abs(peg.currentDeviationBps) : null,
    activeDepeg: complete ? peg.activeDepeg : hasPartialActiveDepegEvidence ? true : null,
    activeDepegBps: (complete && peg.activeDepeg) || hasPartialActiveDepegEvidence ? activeDepegBps : null,
    trackingSpanDays: peg.trackingSpanDays,
    failureDomains: reference?.failureDomains ?? [],
  };
}

/**
 * Supply fact for assets that carry no usable per-chain circulating breakdown.
 * The supplemental/fallback intake lanes (coingecko-fallback,
 * onchain-total-supply, zephyr-scanner) populate only the top-level circulating
 * bucket, so reading the per-chain map alone discards a real, already
 * USD-denominated figure.
 *
 * Per-chain attribution genuinely does not exist for these assets, so
 * `chainDistribution`, `failureDomains` and the bridge-route shares stay empty
 * rather than being synthesized: chain-concentration gates must remain honestly
 * blocked instead of silently reading a single-chain distribution.
 */
function buildAggregateSupply(context: AssetBuildContext): V9AssetFactsV2["supply"] {
  const source = context.extension.sources.chainSupply;
  const aggregate = context.fixedInput.aggregateCirculatingById[context.asset.assetId];
  // DefiLlama list circulating values are already USD-denominated across all peg
  // types, so this is a plain sum — never a price multiplication.
  const circulatingUsd = aggregate ? getCirculatingRaw(aggregate) : 0;
  if (circulatingUsd <= 0) {
    return {
      status: missingLocalFact(context, {
        componentKey: "chain-supply",
        reasonCode: "missing-pillar-evidence",
        ownerDomain: "evidence",
        responsibility: "producer-failed",
        policyRuleId: "v9.supply.current",
        message: "No USD-denominated chain circulating rows are present in the exact fixed input.",
      }).status,
      sourceGenerationId: source.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: null,
      chainDistribution: null,
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: null,
      unknownRouteSupplyShare: null,
      unreviewedRouteSupplyShare: null,
      failureDomains: [],
    };
  }
  // Supplemental supply is carried forward run-over-run and preserves its
  // original observation time, so it ages independently of the chain-supply
  // lane. It therefore takes the intake lane's own 7-day carry-forward ceiling
  // rather than the per-chain lane's ~30-minute cron freshness, which would
  // stale out every legitimately carried-forward asset. Where the intake lane
  // records no observation time there is nothing to age against, so the fact
  // falls back to the capture's own observation time.
  const observedAtSec = aggregate?.observedAtSec ?? source.observedAtSec;
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:aggregate-supply`,
        sourceId: "report-cards-aggregate-circulating",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec,
        contentSha256: digest("safety-score-v9.aggregate-supply.v1", aggregate),
        maxAgeSec: SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const status =
    evidence.freshness.state === "stale"
      ? missingLocalFact(context, {
          componentKey: "chain-supply",
          reasonCode: "missing-pillar-evidence",
          ownerDomain: "evidence",
          responsibility: "producer-failed",
          policyRuleId: "v9.supply.current",
          message: "The aggregate circulating observation is past the supplemental carry-forward ceiling.",
          observationState: "stale",
          evidenceRefIds: [evidenceId],
        }).status
      : createV9FactStatus({
          applicability: requiredV9Applicability("v9.supply.current"),
          observationState: "known",
          evidenceRefIds: [evidenceId],
        });
  return {
    status,
    sourceGenerationId: source.generationId,
    sourceKind: "aggregate-circulating",
    circulatingUnits: null,
    referencePriceUsd: null,
    circulatingUsd,
    chainDistribution: null,
    selectedBridgeRoutes: [],
    selectedRouteSupplyShare: null,
    unknownRouteSupplyShare: null,
    unreviewedRouteSupplyShare: null,
    failureDomains: [],
  };
}

function buildSupply(context: AssetBuildContext): V9AssetFactsV2["supply"] {
  const source = context.extension.sources.chainSupply;
  const v9Attribution =
    context.fixedInput.safetyScoreV9SupplyAttributionById[context.asset.assetId];
  const chainRows = safetyScoreV9ChainRows(context.fixedInput, context.asset.assetId);
  const chains = Object.keys(chainRows).sort(compareText);
  const circulatingUsd = chains.reduce((sum, chain) => sum + chainRows[chain]!.current, 0);
  // A per-chain map that is present but sums to zero carries no more supply
  // information than an absent one, and the aggregate bucket may still hold a
  // real figure. Both cases route to the aggregate fallback; a zero-summing map
  // would otherwise produce a zero-denominator distribution and leave assets
  // like a7a5-old-vector unobserved despite a published circulating supply.
  if (chains.length === 0 || circulatingUsd <= 0) {
    return buildAggregateSupply(context);
  }
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:chain-supply`,
        sourceId:
          v9Attribution === undefined
            ? "report-cards-chain-circulating"
            : v9Attribution.model === "canonical-lock-mint-partition-v1" ||
                v9Attribution.model ===
                  "canonical-lock-mint-group-partition-v2"
              ? "safety-score-v9-lock-mint-attribution"
              : "safety-score-v9-reviewed-deployment-attribution",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: safetyScoreV9ChainSupplyObservedAtSec(
          context.fixedInput,
          context.asset.assetId,
          source.observedAtSec,
        ),
        contentSha256: digest("safety-score-v9.chain-supply.v1", chainRows),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const review = context.asset.supplyReview;
  const supplyByChainId = new Map<string, number>();
  let unattributedSupplyUsd = 0;
  for (const chain of chains) {
    const supplyUsd = chainRows[chain]!.current;
    const chainId = resolveChainId(chain);
    if (chainId === null) {
      unattributedSupplyUsd += supplyUsd;
      continue;
    }
    supplyByChainId.set(chainId, (supplyByChainId.get(chainId) ?? 0) + supplyUsd);
  }
  const chainDistribution = {
    chains: [...supplyByChainId.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([chainId, supplyUsd]) => ({
        chainId,
        supplyUsd,
        supplyShare: circulatingUsd > 0 ? supplyUsd / circulatingUsd : 0,
      })),
    unattributedSupplyUsd,
    unattributedSupplyShare: circulatingUsd > 0 ? unattributedSupplyUsd / circulatingUsd : 0,
  };
  let status: V9FactStatusV2;
  if (evidence.freshness.state === "stale") {
    status = missingLocalFact(context, {
      componentKey: "chain-supply",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "evidence",
      responsibility: "producer-failed",
      policyRuleId: "v9.supply.current",
      message: "The chain supply observation is stale.",
      observationState: "stale",
      evidenceRefIds: [evidenceId],
    }).status;
  } else if (review === null) {
    status = missingLocalFact(context, {
      componentKey: "bridge-materiality",
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "control",
      responsibility: "integration-missing",
      policyRuleId: "v9.supply.bridge-materiality",
      message: "Circulating USD is known, but bridge-route materiality has not been reviewed.",
      observationState: "bounded-unknown",
      evidenceRefIds: [evidenceId],
    }).status;
  } else {
    // A known supply fact asserts the route-review accounting covers the whole
    // circulating base: reviewed-selected + selected-unresolved + unknown must
    // conserve to 1, and the selected rows must reconcile to those shares.
    // Accepting under-accounted shares silently suppresses the
    // material-bridge-supply-unmatched control reason (VER-007).
    const shareSum =
      (review.selectedRouteSupplyShare ?? 0) +
      (review.unreviewedRouteSupplyShare ?? 0) +
      (review.unknownRouteSupplyShare ?? 0);
    const rowShareSum = review.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyShare, 0);
    const reviewedRowShare = review.selectedBridgeRoutes.reduce(
      (sum, route) => sum + (route.reviewState === "selected-reviewed" ? route.supplyShare : 0),
      0,
    );
    const unresolvedRowShare = review.selectedBridgeRoutes.reduce(
      (sum, route) => sum + (route.reviewState === "selected-unresolved" ? route.supplyShare : 0),
      0,
    );
    const unmatchedRowShare = review.selectedBridgeRoutes.reduce(
      (sum, route) => sum + (route.reviewState === "unmatched" ? route.supplyShare : 0),
      0,
    );
    const carriesExplicitUnmatchedRows = review.selectedBridgeRoutes.some((route) => route.reviewState === "unmatched");
    if (circulatingUsd > 0 && Math.abs(shareSum - 1) > 0.000001) {
      throw new Error(
        `Bridge supply shares do not reconcile for ${context.asset.assetId}: ` +
          `selected+unreviewed+unknown=${shareSum} must conserve to 1 over positive circulating supply`,
      );
    }
    const expectedRowShare = carriesExplicitUnmatchedRows
      ? shareSum
      : (review.selectedRouteSupplyShare ?? 0) + (review.unreviewedRouteSupplyShare ?? 0);
    if (circulatingUsd > 0 && Math.abs(rowShareSum - expectedRowShare) > 0.000001) {
      throw new Error(
        `Bridge supply rows do not reconcile for ${context.asset.assetId}: ` +
          `route rows sum to ${rowShareSum} but the represented aggregate claims ${expectedRowShare}`,
      );
    }
    const categoryClaims: Array<readonly [string, number, number]> = [
      ["reviewed", reviewedRowShare, review.selectedRouteSupplyShare ?? 0],
      ["unresolved", unresolvedRowShare, review.unreviewedRouteSupplyShare ?? 0],
    ];
    if (carriesExplicitUnmatchedRows) {
      categoryClaims.push(["unmatched", unmatchedRowShare, review.unknownRouteSupplyShare ?? 0]);
    }
    for (const [label, rowShare, claimedShare] of categoryClaims) {
      if (circulatingUsd > 0 && Math.abs(rowShare - claimedShare) > 0.000001) {
        throw new Error(
          `Bridge supply ${label} rows do not reconcile for ${context.asset.assetId}: ` +
            `rows sum to ${rowShare} but the aggregate claims ${claimedShare}`,
        );
      }
    }
    status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.supply.current"),
      observationState: "known",
      evidenceRefIds: [evidenceId],
    });
  }
  return {
    status,
    sourceGenerationId: source.generationId,
    sourceKind: "usd-denominated-circulating",
    circulatingUnits: null,
    referencePriceUsd: null,
    circulatingUsd,
    chainDistribution,
    selectedBridgeRoutes: review?.selectedBridgeRoutes ?? [],
    selectedRouteSupplyShare: review?.selectedRouteSupplyShare ?? null,
    unknownRouteSupplyShare: review?.unknownRouteSupplyShare ?? null,
    unreviewedRouteSupplyShare: review?.unreviewedRouteSupplyShare ?? null,
    failureDomains: stableFailureDomains([
      ...chains.flatMap((chain) =>
        isV9RepresentationGroupRoute(chain)
          ? []
          : [{
              kind: "chain" as const,
              key: resolveChainId(chain) ?? chain.toLowerCase(),
            }],
      ),
      ...(review?.failureDomains ?? []),
    ]),
  };
}

interface WrapperLocalFactBuildInputs {
  implementation: V9AssetFactsV2["implementation"];
  dependencies: V9EffectiveDependenciesV3;
  reserveStatus: V9FactStatusV2;
  reserveExposures: readonly V9ReserveExposureFactV2[];
  exitStatus: V9FactStatusV2;
  exitRoutes: readonly V9ExitRouteFactV2[];
  controlStatus: V9FactStatusV2;
  controls: readonly V9DeploymentControlFactV2[];
  economicControlReview: V9EconomicControlReviewV2;
  peg: V9AssetFactsV2["peg"];
  supply: V9AssetFactsV2["supply"];
}

function uniqueEvidenceRefIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function wrapperFactDisposition(
  context: AssetBuildContext,
  statuses: readonly V9FactStatusV2[],
  fallback: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> = "integration-missing",
): Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable"> {
  const responsibilities = statuses.flatMap((status) =>
    status.gapIds.flatMap((gapId) => {
      const responsibility = context.gaps.get(gapId)?.responsibility;
      return responsibility ? [responsibility] : [];
    }),
  );
  if (responsibilities.includes("issuer-undisclosed")) return "issuer-undisclosed";
  if (responsibilities.includes("method-unsupported")) return "method-unsupported";
  if (
    responsibilities.includes("producer-failed") ||
    statuses.some((status) => status.observationState === "stale")
  ) {
    return "producer-failed";
  }
  return fallback;
}

function reviewedWrapperFact(
  context: AssetBuildContext,
  assessment: V9WrapperRiskAssessment,
  signals: readonly string[],
  evidenceRefIds: readonly string[],
): V9WrapperLocalDimensionFact {
  const evidence = uniqueEvidenceRefIds(evidenceRefIds);
  return {
    disposition: "reviewed",
    assessment,
    signals: [...signals],
    evidenceRefIds: evidence.length > 0 ? evidence : [fallbackResearchEvidence(context)],
  };
}

function unavailableWrapperFact(
  disposition: Exclude<V9WrapperFactDisposition, "reviewed" | "not-applicable">,
  signal: string,
  evidenceRefIds: readonly string[] = [],
): V9WrapperLocalDimensionFact {
  return {
    disposition,
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function notApplicableWrapperFact(signal: string, evidenceRefIds: readonly string[] = []): V9WrapperLocalDimensionFact {
  return {
    disposition: "not-applicable",
    assessment: null,
    signals: [signal],
    evidenceRefIds: uniqueEvidenceRefIds(evidenceRefIds),
  };
}

function wrapperControlRisk(
  control: V9DeploymentControlFactV2,
): { assessment: V9WrapperRiskAssessment; signals: string[] } {
  if (control.incidentState === "active") {
    return { assessment: "critical", signals: [`active-control-incident:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "unbounded" ||
    control.economicLossScope === "global-claim" ||
    control.capSemantics.kind === "unbounded"
  ) {
    return { assessment: "high", signals: [`unbounded-claim-control:${control.controlKey}`] };
  }
  if (
    control.claimImpairment === "bounded" ||
    control.economicLossScope === "reserve-claim" ||
    control.capSemantics.kind === "raiseable"
  ) {
    return { assessment: "moderate", signals: [`claim-affecting-control:${control.controlKey}`] };
  }
  return { assessment: "low", signals: [`non-claim-control:${control.controlKey}`] };
}

function worstWrapperRisk(values: readonly V9WrapperRiskAssessment[]): V9WrapperRiskAssessment {
  const rank: Readonly<Record<V9WrapperRiskAssessment, number>> = {
    none: 0,
    low: 1,
    moderate: 2,
    high: 3,
    critical: 4,
  };
  return [...values].sort((left, right) => rank[right] - rank[left])[0] ?? "none";
}

function buildWrapperLocalFacts(
  context: AssetBuildContext,
  input: WrapperLocalFactBuildInputs,
): V9WrapperLocalFacts {
  const wrapperEdge = input.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form =
    context.asset.variantKind === "pure-wrapper"
      ? "pure"
      : context.asset.variantKind === "savings-passthrough" ||
          context.asset.variantKind === "risk-absorption"
        ? "native-staked"
        : context.asset.variantKind === "strategy-vault" || wrapperEdge !== undefined
          ? "strategy-vault"
          : null;
  const formEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.implementation.status.evidenceRefIds,
    ...input.dependencies.status.evidenceRefIds,
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  if (form === null) {
    return V9WrapperLocalFactsSchema.parse({
      schemaVersion: 1,
      applicability: "not-wrapper",
      evidenceRefIds:
        formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)],
    });
  }
  const reviewedFormEvidence =
    formEvidenceRefIds.length > 0 ? formEvidenceRefIds : [fallbackResearchEvidence(context)];
  const controlEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.controlStatus.evidenceRefIds,
    ...input.economicControlReview.mint.status.evidenceRefIds,
    ...input.controls.flatMap((control) => control.status.evidenceRefIds),
  ]);
  const reserveEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.reserveStatus.evidenceRefIds,
    ...input.reserveExposures.flatMap((exposure) => exposure.status.evidenceRefIds),
    ...(wrapperEdge?.evidenceRefIds ?? []),
  ]);
  const routeEvidenceRefIds = uniqueEvidenceRefIds([
    ...input.exitStatus.evidenceRefIds,
    ...input.exitRoutes.flatMap((route) => [
      ...route.status.evidenceRefIds,
      ...route.settlementEvidenceRefIds,
      ...route.output.status.evidenceRefIds,
      ...(route.output.valuation?.evidenceRefIds ?? []),
    ]),
  ]);
  let contractMutability: V9WrapperLocalDimensionFact;
  const upgrade = input.economicControlReview.mint.upgrade;
  if (input.economicControlReview.mint.status.observationState !== "known") {
    contractMutability = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.economicControlReview.mint.status]),
      "wrapper-upgrade-review-unavailable",
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "immutable" || upgrade.state === "not-applicable") {
    contractMutability = reviewedWrapperFact(
      context,
      "none",
      [`wrapper-upgrade-state:${upgrade.state}`],
      controlEvidenceRefIds,
    );
  } else if (upgrade.state === "reviewed" && upgrade.controlKey !== null) {
    const upgradeControl = input.controls.find((control) => control.controlKey === upgrade.controlKey);
    if (!upgradeControl || upgradeControl.status.observationState !== "known") {
      contractMutability = unavailableWrapperFact(
        "integration-missing",
        `reviewed-upgrade-control-not-compiled:${upgrade.controlKey}`,
        controlEvidenceRefIds,
      );
    } else {
      const delayAssessment: V9WrapperRiskAssessment =
        upgradeControl.delaySec === null || upgradeControl.delaySec < 86_400
          ? "high"
          : upgradeControl.delaySec < 604_800
            ? "moderate"
            : "low";
      const authorityRisk = wrapperControlRisk(upgradeControl);
      contractMutability = reviewedWrapperFact(
        context,
        worstWrapperRisk([delayAssessment, authorityRisk.assessment]),
        [
          `wrapper-upgrade-authority:${upgradeControl.authority?.model ?? "unknown"}`,
          `wrapper-upgrade-delay-sec:${upgradeControl.delaySec ?? "undisclosed"}`,
          ...authorityRisk.signals,
        ],
        controlEvidenceRefIds,
      );
    }
  } else {
    contractMutability = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-upgrade-authority-undisclosed",
      controlEvidenceRefIds,
    );
  }

  let custodyEscrow: V9WrapperLocalDimensionFact;
  const custody = context.asset.wrapperCustodyReview ?? null;
  if (custody !== null) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:custodyEscrow");
    const hasUnknown =
      custody.segregation === "unknown" ||
      custody.bankruptcyRemoteness === "unknown" ||
      custody.knownUnknownExposureShare === null ||
      custody.knownUnknownExposureShare > 0;
    custodyEscrow = hasUnknown
      ? unavailableWrapperFact(
          "issuer-undisclosed",
          `wrapper-custody-terms-incomplete:${custody.knownUnknownExposureShare ?? "unknown"}`,
          custodyEvidence,
        )
      : reviewedWrapperFact(
          context,
          custody.segregation === "segregated" && custody.bankruptcyRemoteness === "structured"
            ? "low"
            : custody.bankruptcyRemoteness === "none"
              ? "high"
              : "moderate",
          [
            `wrapper-custody-providers:${custody.providers.length}`,
            `wrapper-custody-segregation:${custody.segregation}`,
            `wrapper-custody-bankruptcy-remoteness:${custody.bankruptcyRemoteness}`,
          ],
          custodyEvidence,
        );
  } else if (form === "pure" && wrapperEdge !== undefined) {
    custodyEscrow = notApplicableWrapperFact(
      "pure-wrapper-custody-is-the-serial-parent-contract-claim",
      reviewedFormEvidence,
    );
  } else {
    custodyEscrow = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-custody-or-escrow-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let strategyComplexity: V9WrapperLocalDimensionFact;
  if (form === "pure" && wrapperEdge !== undefined) {
    strategyComplexity = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-has-no-local-strategy"],
      reviewedFormEvidence,
    );
  } else if (
    context.asset.variantKind === "savings-passthrough" ||
    context.asset.variantKind === "risk-absorption"
  ) {
    const riskAbsorption = context.asset.variantKind === "risk-absorption";
    strategyComplexity = reviewedWrapperFact(
      context,
      riskAbsorption ? "moderate" : "low",
      [
        riskAbsorption
          ? "native-wrapper-adds-reviewed-loss-absorption-layer"
          : "native-wrapper-is-single-parent-savings-passthrough",
      ],
      reviewedFormEvidence,
    );
  } else if (context.asset.variantKind === "strategy-vault") {
    const highComplexity =
      input.reserveExposures.some((exposure) => exposure.assetClass === "private-credit") ||
      (custody?.knownUnknownExposureShare ?? 0) > 0;
    strategyComplexity = reviewedWrapperFact(
      context,
      highComplexity ? "high" : "moderate",
      [
        highComplexity
          ? "strategy-vault-has-private-or-unknown-credit-exposure"
          : "strategy-vault-adds-third-party-allocation-layer",
        `wrapper-strategy-reserve-components:${input.reserveExposures.length}`,
      ],
      uniqueEvidenceRefIds([...reviewedFormEvidence, ...reserveEvidenceRefIds]),
    );
  } else {
    strategyComplexity = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus]),
      "wrapper-strategy-complexity-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let leverage: V9WrapperLocalDimensionFact;
  if (form === "pure" && wrapperEdge !== undefined) {
    leverage = notApplicableWrapperFact(
      "pure-wrapper-has-no-local-strategy-leverage",
      reviewedFormEvidence,
    );
  } else if (input.reserveStatus.observationState === "known") {
    const leverageFactors = input.reserveExposures.flatMap((exposure) =>
      exposure.riskFactors.filter((factor) => /\b(leverage|leveraged|borrowing|debt-financed)\b/i.test(factor)),
    );
    leverage =
      leverageFactors.length > 0
        ? reviewedWrapperFact(
            context,
            "high",
            leverageFactors.map((factor) => `wrapper-leverage-factor:${factor}`),
            reserveEvidenceRefIds,
          )
        : unavailableWrapperFact(
            "issuer-undisclosed",
            "wrapper-leverage-review-does-not-establish-absence",
            reserveEvidenceRefIds,
          );
  } else {
    leverage = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-leverage-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let rehypothecationCorrelation: V9WrapperLocalDimensionFact;
  if (custody !== null) {
    const custodyEvidence = componentResearchEvidence(context, "wrapper-local:rehypothecationCorrelation");
    rehypothecationCorrelation =
      custody.rehypothecation === "unknown"
        ? unavailableWrapperFact(
            "issuer-undisclosed",
            "wrapper-rehypothecation-terms-undisclosed",
            custodyEvidence,
          )
        : reviewedWrapperFact(
            context,
            custody.rehypothecation === "prohibited"
              ? "low"
              : custody.rehypothecation === "conditional"
                ? "moderate"
                : "high",
            [
              `wrapper-rehypothecation:${custody.rehypothecation}`,
              `wrapper-custody-provider-count:${custody.providers.length}`,
            ],
            custodyEvidence,
          );
  } else if (form === "pure" && wrapperEdge !== undefined) {
    rehypothecationCorrelation = notApplicableWrapperFact(
      "pure-wrapper-parent-correlation-is-applied-by-serial-dependency",
      reviewedFormEvidence,
    );
  } else {
    rehypothecationCorrelation = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.reserveStatus], "issuer-undisclosed"),
      "wrapper-rehypothecation-correlation-review-unavailable",
      reserveEvidenceRefIds,
    );
  }

  let shareAccountingNavOracle: V9WrapperLocalDimensionFact;
  if (form === "pure") {
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      "none",
      ["pure-wrapper-fixed-parent-claim-accounting"],
      reviewedFormEvidence,
    );
  } else if (
    (context.asset.variantKind === "savings-passthrough" ||
      context.asset.variantKind === "risk-absorption" ||
      context.asset.variantKind === "strategy-vault") &&
    input.peg.referenceKind === "nav" &&
    input.peg.status.observationState === "known"
  ) {
    const oracleTier = input.economicControlReview.oracle.tier;
    const weakOracle =
      oracleTier === "single-source-or-laggy" || oracleTier === "opaque-or-unknown";
    shareAccountingNavOracle = reviewedWrapperFact(
      context,
      weakOracle ? "high" : "moderate",
      [
        `wrapper-share-form:${context.asset.variantKind}`,
        `wrapper-share-reference-kind:${input.peg.referenceKind}`,
        `wrapper-share-oracle-tier:${oracleTier ?? "not-applicable"}`,
      ],
      uniqueEvidenceRefIds([
        ...reviewedFormEvidence,
        ...input.peg.status.evidenceRefIds,
        ...input.economicControlReview.oracle.status.evidenceRefIds,
      ]),
    );
  } else {
    shareAccountingNavOracle = unavailableWrapperFact(
      wrapperFactDisposition(
        context,
        [input.peg.status, input.economicControlReview.mint.status],
        "integration-missing",
      ),
      "wrapper-share-accounting-or-nav-oracle-review-unavailable",
      [...input.peg.status.evidenceRefIds, ...input.economicControlReview.mint.status.evidenceRefIds],
    );
  }

  const knownRedemptionRoutes = input.exitRoutes.filter(
    (route) =>
      route.lane === "redemption" &&
      (route.status.observationState === "known" || route.status.observationState === "stale"),
  );
  let withdrawalTerms: V9WrapperLocalDimensionFact;
  if (knownRedemptionRoutes.length === 0) {
    withdrawalTerms = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus]),
      "wrapper-withdrawal-fee-or-gate-terms-unavailable",
      routeEvidenceRefIds,
    );
  } else if (knownRedemptionRoutes.some((route) => route.feeEvidence === "undisclosed-reviewed")) {
    withdrawalTerms = unavailableWrapperFact(
      "issuer-undisclosed",
      "wrapper-withdrawal-fee-undisclosed",
      routeEvidenceRefIds,
    );
  } else {
    const termsRisk = knownRedemptionRoutes.map((route): V9WrapperRiskAssessment => {
      if (
        route.holderAccess === "issuer-only" ||
        route.executionModel === "discretionary" ||
        route.executionCertainty === "discretionary"
      ) {
        return "critical";
      }
      if (route.settlementModel === "queued" || route.executionModel === "queued") {
        return (route.settlementSlaSec ?? Number.POSITIVE_INFINITY) > 604_800 ? "high" : "moderate";
      }
      if (
        route.holderAccess === "allowlisted" ||
        route.holderAccess === "institutional-eligible" ||
        route.executionCertainty === "conditional"
      ) {
        return "moderate";
      }
      return "low";
    });
    withdrawalTerms = reviewedWrapperFact(
      context,
      worstWrapperRisk(termsRisk),
      knownRedemptionRoutes.flatMap((route) => [
        `wrapper-withdrawal-access:${route.holderAccess}`,
        `wrapper-withdrawal-execution:${route.executionModel}`,
        `wrapper-withdrawal-settlement:${route.settlementModel}:${route.settlementSlaSec ?? "atomic"}`,
      ]),
      routeEvidenceRefIds,
    );
  }

  const stressRequest =
    input.supply.status.observationState === "known"
      ? selectV9ExitStressRequest(input.supply.circulatingUsd, V9_CANDIDATE_POLICY_V1)
      : null;
  const admittedDocumentedUnwindRouteKeys =
    stressRequest === null
      ? new Set<string>()
      : new Set(
          evaluateV9ExitAssetFacts(
            {
              supply: input.supply,
              exitStatus: input.exitStatus,
              exitRoutes: [...input.exitRoutes],
            },
            V9_CANDIDATE_POLICY_V1,
          ).routes.flatMap((route) => (route.included ? [route.routeKey] : [])),
        );
  const observedUnwindRoutes = input.exitRoutes.filter(
    (route) =>
      (route.status.observationState === "known" && route.scoreEligible && route.capacityCurve.length > 0) ||
      // Undisclosed-fee credit is conditionally withheld by a later danger gate
      // that is unavailable while facts are being compiled.
      (route.feeEvidence !== "undisclosed-reviewed" &&
        admittedDocumentedUnwindRouteKeys.has(route.routeKey)),
  );
  let measuredUnwind: V9WrapperLocalDimensionFact;
  const stressCompletions =
    stressRequest === null
      ? []
      : observedUnwindRoutes.flatMap((route) => {
          const point = resolveV9ExitCapacityAtRequest(route.capacityCurve, stressRequest);
          return point === null ? [] : [point.completionRatio];
        });
  if (stressCompletions.length > 0) {
    const bestCompletion = Math.max(...stressCompletions);
    measuredUnwind = reviewedWrapperFact(
      context,
      bestCompletion >= 0.95
        ? "none"
        : bestCompletion >= 0.8
          ? "low"
          : bestCompletion >= 0.5
            ? "moderate"
            : bestCompletion > 0
              ? "high"
              : "critical",
      [
        `wrapper-measured-unwind-policy-notional:${stressRequest!.requestedNotionalUsd}`,
        `wrapper-measured-unwind-policy-completion:${bestCompletion}`,
        `wrapper-measured-unwind-route-count:${observedUnwindRoutes.length}`,
      ],
      routeEvidenceRefIds,
    );
  } else if (input.exitStatus.observationState === "known" && stressRequest !== null) {
    measuredUnwind = reviewedWrapperFact(
      context,
      "critical",
      ["wrapper-measured-unwind:no-score-eligible-capacity"],
      routeEvidenceRefIds,
    );
  } else {
    measuredUnwind = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.exitStatus], "producer-failed"),
      "wrapper-measured-unwind-unavailable",
      routeEvidenceRefIds,
    );
  }

  let lossAbsorptionEmergencyControls: V9WrapperLocalDimensionFact;
  if (
    context.asset.variantKind === "pure-wrapper" ||
    context.asset.variantKind === "savings-passthrough"
  ) {
    lossAbsorptionEmergencyControls = notApplicableWrapperFact(
      "wrapper-design-has-no-local-holder-loss-absorption-layer",
      reviewedFormEvidence,
    );
  } else if (input.controlStatus.observationState === "known") {
    const localControls =
      context.asset.variantKind === "strategy-vault"
        ? input.controls.filter((control) => control.controlKind !== "bridge")
        : [];
    const controlRisks = localControls.map(wrapperControlRisk);
    lossAbsorptionEmergencyControls =
      controlRisks.length > 0
        ? reviewedWrapperFact(
            context,
            worstWrapperRisk([
              ...controlRisks.map((risk) => risk.assessment),
              ...(context.asset.variantKind === "risk-absorption" ? (["moderate"] as const) : []),
            ]),
            [
              ...controlRisks.flatMap((risk) => risk.signals),
              ...(context.asset.variantKind === "risk-absorption"
                ? ["wrapper-holder-bears-protocol-loss-absorption"]
                : ["strategy-vault-holder-loss-controls-reviewed"]),
            ],
            controlEvidenceRefIds,
          )
        : unavailableWrapperFact(
            "integration-missing",
            "wrapper-emergency-control-review-has-no-local-controls",
            controlEvidenceRefIds,
          );
  } else {
    lossAbsorptionEmergencyControls = unavailableWrapperFact(
      wrapperFactDisposition(context, [input.controlStatus]),
      "wrapper-loss-absorption-or-emergency-control-review-unavailable",
      controlEvidenceRefIds,
    );
  }

  const facts: V9ApplicableWrapperLocalFacts = {
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: "reviewed",
    formSignals: [
      `wrapper-form:${form}`,
      `wrapper-form-source:${context.asset.variantKind ?? "serial-wrapper-dependency"}`,
    ],
    formEvidenceRefIds: reviewedFormEvidence,
    facts: {
      contractMutability,
      custodyEscrow,
      strategyComplexity,
      leverage,
      rehypothecationCorrelation,
      shareAccountingNavOracle,
      withdrawalTerms,
      measuredUnwind,
      lossAbsorptionEmergencyControls,
    },
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-documented-parent-loss-absorption-credit"],
      evidenceRefIds: [],
    },
  };
  return V9WrapperLocalFactsSchema.parse(facts);
}

function compileAsset(
  fixedInput: ReportCardsFixedInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  asset: AssetExtension,
  researchPayloadSha256: string,
): V9AssetFactsV3 {
  const context: AssetBuildContext = {
    fixedInput,
    extension,
    asset,
    researchPayloadSha256,
    evidence: new Map(),
    gaps: new Map(),
  };
  const implementation = buildImplementation(context);
  const mechanismRiskReview = buildMechanismReview(context);
  const mechanismExitFacts = buildMechanismExitFacts(context);
  const cdpStressCoverage = buildCdpStressCoverage(context);
  const rawDependencies = buildDependencies(context);
  const reserves = buildReserves(context);
  const dependencies = reconcileCollateralDependencyMappings(context, rawDependencies, reserves.reserveExposures);
  const routes = buildRoutes(context);
  const controls = buildControls(context);
  const economicControlReview = buildEconomicControlReview(context);
  const accessReview = buildAccessReview(context);
  const peg = buildPeg(context);
  const supply = buildSupply(context);
  const operationalResilience = buildOperationalResilienceFact(context);
  const wrapperLocalFacts = buildWrapperLocalFacts(context, {
    implementation,
    dependencies,
    reserveStatus: reserves.reserveStatus,
    reserveExposures: reserves.reserveExposures,
    exitStatus: routes.exitStatus,
    exitRoutes: routes.exitRoutes,
    controlStatus: controls.controlStatus,
    controls: controls.controls,
    economicControlReview,
    peg,
    supply,
  });
  const compiledAsset: V9AssetFactsV3 = {
    assetId: asset.assetId,
    assetIssuerKey: asset.assetIssuerKey ?? null,
    archetype: asset.archetype,
    ...(asset.variantKind == null ? {} : { variantKind: asset.variantKind }),
    evidence: [...context.evidence.values()],
    gaps: [...context.gaps.values()],
    implementation,
    mechanismRiskReview,
    mechanismExitFacts,
    ...(cdpStressCoverage === undefined ? {} : { cdpStressCoverage }),
    dependencies,
    ...reserves,
    ...routes,
    ...controls,
    economicControlReview,
    accessReview,
    peg,
    supply,
    operationalResilience,
    wrapperLocalFacts,
  };
  // Normalize once at the producer boundary so every score-bearing pillar,
  // including nested mechanism reviews, shares the same chain identity.
  return normalizeCompiledFailureDomains(compiledAsset);
}

/**
 * Compile policy-independent V9 facts directly from publication-exact base inputs.
 * ReportCard score outputs are intentionally not part of this adapter contract.
 */
export function compileSafetyScoreV9FactSetFromFixedInput(
  fixedInputValue: unknown,
  extensionValue: unknown,
): Readonly<CompiledV9FactSetV3> {
  return compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(fixedInputValue), extensionValue);
}

/** Trusted runtime entrypoint for already validated publication inputs. */
export function compileSafetyScoreV9FactSetFromNormalizedInput(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extensionValue: unknown,
): Readonly<CompiledV9FactSetV3> {
  return compileSafetyScoreV9FactSetFromValidatedExtension(
    fixedInput,
    materializeSafetyScoreV9FactSetExtension(fixedInput, extensionValue),
  );
}

/**
 * Trusted same-process path for an extension just returned by
 * materializeSafetyScoreV9FactSetExtension().
 */
export function compileSafetyScoreV9FactSetFromValidatedExtension(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extension: SafetyScoreV9FactSetExtensionV2,
): Readonly<CompiledV9FactSetV3> {
  if (!materializedExtensions.has(extension)) {
    throw new Error("Trusted Safety Score v9 compilation requires an in-process materialized extension");
  }
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    throw new Error("Safety Score v9 fact compilation requires exact publication inputs");
  }
  if (extension.registryFingerprint !== fixedInput.registryFingerprint) {
    throw new Error(
      `Safety Score v9 extension registry fingerprint ${extension.registryFingerprint} does not match fixed input ${fixedInput.registryFingerprint}`,
    );
  }
  assertSafetyScoreV9ExactExtensionAssets(fixedInput, extension);
  const researchPayloadSha256 = digest(
    "safety-score-v9.research-overlay.v1",
    projectResearchOverlayPayload(extension.assets),
  );
  const redemptionObservedAtSec =
    fixedInput.inputFreshness.redemptionBackstops.updatedAt ?? extension.sources.unavailableRedemptionObservedAtSec;
  const shockCoveragePayload = extension.assets.flatMap((asset) =>
    asset.cdpStressCoverage === undefined
      ? []
      : [{ assetId: asset.assetId, cdpStressCoverage: asset.cdpStressCoverage }],
  );
  const shockCoveragePayloadSha256 = digest("safety-score-v9.cdp-shock-coverage-source.v1", shockCoveragePayload);
  const shockCoverageObservedAtSec = shockCoveragePayload.reduce(
    (latest, entry) => Math.max(latest, entry.cdpStressCoverage.source?.block.timestampUnix ?? 0),
    0,
  );
  return compileV9FactSetV3({
    schemaVersion: 3,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    asOfSec: fixedInput.clockSec,
    compiledAtSec: extension.compiledAtSec,
    sourceFingerprints: {
      registry: {
        generationId: fixedInput.registryRevision,
        payloadSha256: fixedInput.registryFingerprint,
        observedAtSec: extension.sources.registryObservedAtSec,
      },
      dex: {
        generationId: fixedInput.dexGenerationId,
        payloadSha256: fixedInput.dexPayloadFingerprint,
        observedAtSec: fixedInput.inputFreshness.dexLiquidity.updatedAt!,
      },
      redemption: {
        generationId: fixedInput.redemptionGenerationId,
        payloadSha256: fixedInput.redemptionPayloadFingerprint,
        observedAtSec: redemptionObservedAtSec,
      },
      liveReserves: {
        generationId: extension.sources.liveReserves.generationId,
        payloadSha256: digest("safety-score-v9.live-reserves.v1", {
          reserves: fixedInput.liveReserveMap,
          provenance: fixedInput.liveReserveProvenanceMap,
        }),
        observedAtSec: extension.sources.liveReserves.observedAtSec,
      },
      chainSupply: {
        generationId: extension.sources.chainSupply.generationId,
        payloadSha256: digest(
          "safety-score-v9.chain-supply.v1",
          safetyScoreV9ChainSupplySourcePayload(fixedInput),
        ),
        observedAtSec: extension.sources.chainSupply.observedAtSec,
      },
      peg: {
        generationId: extension.sources.peg.generationId,
        payloadSha256: digest("safety-score-v9.peg.v1", {
          pegDataById: fixedInput.pegDataById,
          navPriceById: fixedInput.navPriceById ?? {},
          activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
        }),
        observedAtSec: extension.sources.peg.observedAtSec,
      },
      researchOverlays: {
        generationId: extension.sources.researchOverlays.generationId,
        payloadSha256: researchPayloadSha256,
        observedAtSec: extension.sources.researchOverlays.observedAtSec,
      },
      ...(shockCoveragePayload.length === 0
        ? {}
        : {
            shockCoverage: {
              generationId: `cdp-shock-coverage:v1:${shockCoveragePayloadSha256}`,
              payloadSha256: shockCoveragePayloadSha256,
              observedAtSec: shockCoverageObservedAtSec,
            },
          }),
    },
    activeAssetIds: fixedInput.activeAssetIds,
    assets: extension.assets.map((asset) => compileAsset(fixedInput, extension, asset, researchPayloadSha256)),
  });
}
