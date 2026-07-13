import { z } from "zod";
import { compileV9FactSetV2 } from "@shared/lib/safety-score-v9/compile";
import { canonicalV9DependencyEdgeKey, canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import {
  createV9EvidenceReference,
  createV9FactStatus,
  notApplicableV9Fact,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import { collateralExposureV9Path, createV9FactGap, optionalExitV9Path } from "@shared/lib/safety-score-v9/reasons";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9AccessReviewV2Schema,
  V9EconomicControlReviewV2Schema,
  V9ReserveAssetClassSchema,
  V9ResolvedMechanismArchetypeSchema,
  type CompiledV9FactSetV2,
  type V9AccessReviewV2,
  type V9AssetFactsV2,
  type V9DeploymentControlFactV2,
  type V9EconomicControlReviewV2,
  type V9EffectiveDependenciesV2,
  type V9EvidenceReferenceV2,
  type V9ExitRouteFactV2,
  type V9FactGapV2,
  type V9FactStatusV2,
  type V9FailureDomainRef,
  type V9MechanismRiskReviewFactV2,
  type V9ReserveExposureFactV2,
} from "@shared/types/safety-score-v9-facts";
import { V9MechanismRiskReviewSchema, type V9MechanismRiskReview } from "@shared/types/safety-score-v9-backing";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationSchema,
  RedemptionExitRouteObservationSchema,
  type ExitRouteObservation,
} from "@shared/types/exit-route";
import type { ReserveSlice } from "@shared/types/reserves";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import { assertSafetyScoreV9ExactExtensionAssets } from "./safety-score-v9-fact-set-boundary";

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
  })
  .strict();

const DependencyEdgeOverlaySchema = z
  .object({
    upstreamAssetId: CanonicalTextSchema,
    dependencyType: z.enum(["wrapper", "mechanism", "collateral"]),
    weight: z.number().finite().positive().max(1),
    failureDomains: FailureDomainsSchema,
  })
  .strict();

const EffectiveDependenciesOverlaySchema = z
  .object({
    source: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none", "variant"]),
    baseSource: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none"]),
    dependencyFromLive: z.boolean(),
    mappedLiveReserveWeight: FractionSchema.nullable(),
    fallbackReason: z
      .enum(["live-unmapped-to-curated-reserve", "live-unmapped-to-manual", "live-cycle-to-curated"])
      .nullable(),
    edges: canonicalArrayBy(DependencyEdgeOverlaySchema, (edge) =>
      canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId),
    ),
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
    coverageClass: z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]),
    settlementModel: z.enum(["atomic", "same-day", "bounded-delay", "queued", "eventual", "unknown"]),
    settlementSlaSec: z.number().int().nonnegative().nullable(),
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
        })
        .strict(),
      (route) => route.deploymentRouteKey,
    ),
    selectedRouteSupplyShare: FractionSchema,
    unknownRouteSupplyShare: FractionSchema,
    unreviewedRouteSupplyShare: FractionSchema,
    failureDomains: FailureDomainsSchema,
  })
  .strict();

const AssetExtensionSchema = z
  .object({
    assetId: CanonicalTextSchema,
    archetype: V9ResolvedMechanismArchetypeSchema,
    launchedAtSec: UnixSecondsSchema.nullable(),
    mechanismRiskReview: V9MechanismRiskReviewSchema.nullable(),
    dependencies: EffectiveDependenciesOverlaySchema.nullable(),
    reserveApplicability: ReserveApplicabilitySchema,
    reserveClassifications: canonicalArrayBy(ReserveClassificationSchema, (row) => row.exposureKey),
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
    researchEvidence: canonicalArrayBy(ResearchEvidenceSchema, (evidence) => evidence.evidenceKey).default([]),
    componentEvidence: canonicalArrayBy(ComponentEvidenceBindingSchema, (binding) => binding.componentKey).default([]),
  })
  .strict()
  .superRefine((asset, ctx) => {
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

interface AssetBuildContext {
  readonly fixedInput: ReportCardsFixedInput;
  readonly extension: SafetyScoreV9FactSetExtensionV2;
  readonly asset: AssetExtension;
  readonly researchPayloadSha256: string;
  readonly evidence: Map<string, V9EvidenceReferenceV2>;
  readonly gaps: Map<string, V9FactGapV2>;
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
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, projectResearchOverlayPayload(entry)]));
}

function stableFailureDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [...new Map(domains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort((left, right) =>
    compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
}

function addEvidence(context: AssetBuildContext, evidence: V9EvidenceReferenceV2): string {
  const existing = context.evidence.get(evidence.evidenceId);
  if (existing && stableJsonStringifyV1(existing) !== stableJsonStringifyV1(evidence)) {
    throw new Error(`Conflicting Safety Score v9 evidence identity ${evidence.evidenceId}`);
  }
  context.evidence.set(evidence.evidenceId, evidence);
  return evidence.evidenceId;
}

function addGap(context: AssetBuildContext, gap: V9FactGapV2): string {
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

function missingLocalFact(
  context: AssetBuildContext,
  args: {
    componentKey: string;
    reasonCode: V9FactGapV2["reasonCode"];
    ownerDomain: V9FactGapV2["ownerDomain"];
    policyRuleId: string;
    message: string;
    observationState?: Exclude<V9FactStatusV2["observationState"], "known">;
    evidenceRefIds?: readonly string[];
  },
): { gapId: string; status: V9FactStatusV2 } {
  const observationState = args.observationState ?? "missing";
  const gapId = addGap(
    context,
    createV9FactGap({
      gapId: `${context.asset.assetId}:gap:${args.componentKey}`,
      reasonCode: args.reasonCode,
      ownerDomain: args.ownerDomain,
      policyRuleId: args.policyRuleId,
      observationState,
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
  const evidenceId = researchEvidence(context);
  const evidence = context.evidence.get(evidenceId)!;
  const normalized = structuredClone(review) as V9MechanismRiskReview;
  const componentGapIds: string[] = [];
  const componentEvidenceIds = new Set<string>();
  let hasStale = false;
  let hasIncomplete = false;

  for (const [componentKey, value] of Object.entries(normalized)) {
    if (value === null || typeof value !== "object" || !("status" in value)) continue;
    const fact = value as { status: V9FactStatusV2 };
    const original = fact.status;
    if (original.observationState === "known") {
      fact.status = createV9FactStatus({
        applicability: original.applicability,
        observationState: "known",
        evidenceRefIds: [evidenceId],
      });
      componentEvidenceIds.add(evidenceId);
      continue;
    }
    const bounded = original.observationState === "stale" || original.observationState === "bounded-unknown";
    const gapId = addGap(
      context,
      createV9FactGap({
        gapId: `${context.asset.assetId}:gap:mechanism-review:${componentKey}`,
        reasonCode: bounded ? "bounded-mechanism-review" : "missing-pillar-evidence",
        ownerDomain: "backing",
        policyRuleId: original.applicability.policyRuleId,
        observationState: original.observationState,
        path: { kind: "local-component", componentKey: `mechanism-review:${componentKey}` },
        message: `The ${componentKey} mechanism review is not a current known fact.`,
        evidenceRefIds:
          original.observationState === "stale" || original.observationState === "bounded-unknown" ? [evidenceId] : [],
      }),
    );
    const applicability =
      original.applicability.state === "unresolved" ? { ...original.applicability, gapId } : original.applicability;
    fact.status = createV9FactStatus({
      applicability,
      observationState: original.observationState,
      evidenceRefIds:
        original.observationState === "stale" || original.observationState === "bounded-unknown" ? [evidenceId] : [],
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
    if (fact.status.evidenceRefIds.length > 0) componentEvidenceIds.add(evidenceId);
  }

  const observationState = hasIncomplete ? "bounded-unknown" : hasStale ? "stale" : "known";
  return {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("v9.backing.mechanism-review"),
      observationState,
      evidenceRefIds: [...new Set([evidenceId, ...componentEvidenceIds])],
      gapIds: componentGapIds,
    }),
    review: normalized,
  };
}

function buildMechanismReview(context: AssetBuildContext): V9MechanismRiskReviewFactV2 {
  if (context.asset.mechanismRiskReview === null) {
    const unresolvedArchetype = context.asset.archetype === "unresolved";
    return {
      status: missingLocalFact(context, {
        componentKey: "mechanism-risk-review",
        reasonCode: unresolvedArchetype ? "missing-archetype" : "missing-pillar-evidence",
        ownerDomain: "backing",
        policyRuleId: "v9.backing.mechanism-review",
        message: unresolvedArchetype
          ? "The asset does not yet have a resolved Safety Score v9 mechanism archetype."
          : "No policy-independent archetype mechanism review is present in the v9 overlay.",
      }).status,
      review: null,
    };
  }
  if (context.asset.mechanismRiskReview.archetype !== context.asset.archetype) {
    throw new Error(`Mechanism review archetype mismatch for ${context.asset.assetId}`);
  }
  return normalizeMechanismReview(context, context.asset.mechanismRiskReview);
}

function buildDependencies(context: AssetBuildContext): V9EffectiveDependenciesV2 {
  const overlay = context.asset.dependencies;
  if (overlay === null) {
    return {
      status: missingLocalFact(context, {
        componentKey: "effective-dependencies",
        reasonCode: "unreviewed-dependency-relationships",
        ownerDomain: "dependency",
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
      const serial = edge.dependencyType === "wrapper" || edge.dependencyType === "mechanism";
      return {
        edgeKey: canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId),
        upstreamAssetId: edge.upstreamAssetId,
        dependencyType: edge.dependencyType,
        pathKind: serial ? "serial-dependency" : "collateral-exposure",
        weight: edge.weight,
        economicRole: serial ? "serial-claim" : "basket-exposure",
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
    if ((context.fixedInput.liveReserveMap[context.asset.assetId] ?? []).length > 0) {
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

  const slices = context.fixedInput.liveReserveMap[context.asset.assetId] ?? [];
  if (slices.length === 0) {
    return {
      reserveStatus: missingLocalFact(context, {
        componentKey: "reserve-composition",
        reasonCode: "missing-reserve-composition",
        ownerDomain: "backing",
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
    const evidenceId = reserveSourceEvidence(context, exposureKey, groupedSlices);
    const evidence = context.evidence.get(evidenceId)!;
    const issuerOrObligorKey = classification?.issuerOrObligorKey ?? raw.issuerOrObligor ?? null;
    const assetClass = classification?.assetClass ?? raw.assetClass ?? null;
    const failureDomains = stableFailureDomains([
      ...(classification?.failureDomains ?? []),
      ...(issuerOrObligorKey ? [{ kind: "reserve-issuer" as const, key: issuerOrObligorKey }] : []),
      ...(raw.coinId ? [{ kind: "reserve-issuer" as const, key: `asset:${raw.coinId}` }] : []),
    ]);
    const classificationKnown = assetClass !== null && failureDomains.length > 0;
    let status: V9FactStatusV2;
    if (!classificationKnown) {
      const gapId = addGap(
        context,
        createV9FactGap({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}`,
          reasonCode: "material-reserve-slice-unstructured",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-classification",
          observationState: "bounded-unknown",
          path: collateralExposureV9Path(exposureKey),
          message: "The captured reserve slice lacks a complete v9 classification or failure-domain identity.",
          evidenceRefIds: [evidenceId],
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "bounded-unknown",
        evidenceRefIds: [evidenceId],
        gapIds: [gapId],
      });
    } else if (evidence.freshness.state === "stale") {
      const gapId = addGap(
        context,
        createV9FactGap({
          gapId: `${context.asset.assetId}:gap:reserve:${exposureKey}:stale`,
          reasonCode: "partial-reserve-review",
          ownerDomain: "backing",
          policyRuleId: "v9.backing.reserve-freshness",
          observationState: "stale",
          path: collateralExposureV9Path(exposureKey),
          message: "The last-known reserve exposure is older than the v9 freshness bound.",
          evidenceRefIds: [evidenceId],
        }),
      );
      envelopeGapIds.push(gapId);
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "stale",
        evidenceRefIds: [evidenceId],
        gapIds: [gapId],
      });
    } else {
      status = createV9FactStatus({
        applicability: requiredV9Applicability("v9.backing.reserve-classification"),
        observationState: "known",
        evidenceRefIds: [evidenceId],
      });
    }
    envelopeEvidenceIds.push(evidenceId);
    exposures.push({
      exposureKey,
      classificationKey: classification?.classificationKey ?? `base:${exposureKey}`,
      sourceGenerationId: context.extension.sources.liveReserves.generationId,
      provenance: "live",
      status,
      name: raw.name.trim(),
      weight,
      trackedAssetId: raw.coinId ?? null,
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
      evidenceRefIds: envelopeEvidenceIds,
      gapIds: envelopeGapIds,
    }),
    reserveExposures: exposures,
  };
}

function reconcileCollateralDependencyMappings(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV2,
  reserveExposures: readonly V9ReserveExposureFactV2[],
): V9EffectiveDependenciesV2 {
  const mappedWeightByUpstream = new Map<string, number>();
  for (const exposure of reserveExposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  const mappingIssues = dependencies.edges.flatMap((edge) => {
    if (edge.pathKind !== "collateral-exposure") return [];
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

function scopeFailureDomains(observation: ExitRouteObservation): V9FailureDomainRef[] {
  const scope = observation.scope;
  if (scope.kind === "chain-contract") {
    return [
      { kind: "chain", key: scope.chain },
      { kind: "dex-protocol", key: scope.protocol },
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
      ? context.extension.routeFreshness.dexMaxAgeSec
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
  const assetKeys = [
    ...(output.assetKeys ?? []),
    ...(output.kind === "tracked-stablecoin" ? (output.trackedAssetIds ?? []) : []),
    ...(output.kind === "fiat" && output.currency ? [`fiat:${output.currency}`] : []),
  ];
  return { kind: output.kind, assetKeys: [...new Set(assetKeys)].sort(compareText) };
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
  reasonCode: V9FactGapV2["reasonCode"],
  message: string,
  evidenceRefIds: readonly string[],
): string {
  return addGap(
    context,
    createV9FactGap({
      gapId: `${context.asset.assetId}:gap:route:${routeKey}:${suffix}`,
      reasonCode,
      ownerDomain: "exit",
      policyRuleId: suffix === "output" ? "v9.exit.output-valuation" : "v9.exit.same-notional-route",
      observationState,
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
  const baseDomains = scopeFailureDomains(args.observation);

  if (!args.review) {
    const gapId = routeGap(
      context,
      routeKey,
      "semantics",
      args.disposition === "rejected" ? "unsupported" : "bounded-unknown",
      "unsupported-same-notional-route",
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
      observationConfidence: args.observation.confidence,
      evidenceKind: args.observation.evidenceKind,
      coverageClass: "diagnostic",
      settlementModel: "unknown",
      settlementSlaSec: null,
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
    observationConfidence: args.observation.confidence,
    evidenceKind: args.observation.evidenceKind,
    coverageClass: args.review.coverageClass,
    settlementModel: args.review.settlementModel,
    settlementSlaSec: args.review.settlementSlaSec,
    settlementEvidenceRefIds: [evidenceId],
    physicalResourceKeys: args.review.physicalResourceKeys,
    status: routeStatus,
    scoreEligible,
    request: {
      requestedNotionalUsd: args.observation.requestedNotionalUsd,
      maxCostBps: args.observation.maxCostBps,
      settlementHorizonSec: args.observation.settlementHorizonSec,
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
    return {
      exitStatus: missingLocalFact(context, {
        componentKey: "exit-routes",
        reasonCode: "missing-runtime-route-evidence",
        ownerDomain: "exit",
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
  // requires every retained DEX pool to carry a score-eligible observation.
  // A portfolio holding only diagnostic routes over an incompletely observed
  // DEX surface stays bounded-unknown. A missing redemption row does not
  // demote the state: absent redemption evidence can only understate the
  // score, and the zero-score path still requires an observed portfolio.
  const coverage = context.fixedInput.dexLiqMap[context.asset.assetId]?.exitRouteObservationCoverage;
  const dexSurfaceComplete =
    coverage != null &&
    (coverage.retainedPoolCount === 0 ||
      (coverage.status === "populated" &&
        coverage.scoreEligiblePoolCount != null &&
        coverage.scoreEligiblePoolCount === coverage.retainedPoolCount));
  const portfolioGapIds = [...gapIds];
  if (!dexSurfaceComplete) {
    portfolioGapIds.push(
      addGap(
        context,
        createV9FactGap({
          gapId: `${context.asset.assetId}:gap:exit-portfolio-coverage`,
          reasonCode: "incomplete-dex-route-coverage",
          ownerDomain: "exit",
          policyRuleId: "v9.exit.same-notional-route",
          observationState: "bounded-unknown",
          path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
          message: "Retained DEX pools do not all carry score-eligible exact route observations.",
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
          policyRuleId: "v9.control.review",
          message: review.rationale,
          observationState: "bounded-unknown",
          evidenceRefIds: evidenceIds,
        }).status;
  if (review.state === "reviewed-controls") {
    assertKnownComponentEvidenceCurrent(context, "control", evidenceIds);
  }
  return {
    controlStatus: status,
    controls: review.controls.map((control) => ({
      ...control,
      sourceGenerationId: context.extension.sources.researchOverlays.generationId,
      status,
    })),
  };
}

function normalizeEconomicControlStatus(
  context: AssetBuildContext,
  original: V9FactStatusV2,
  componentKey: string,
  reasonCode: V9FactGapV2["reasonCode"],
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
    createV9FactGap({
      gapId: `${context.asset.assetId}:gap:economic-control:${componentKey}`,
      reasonCode,
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
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
          policyRuleId: "v9.control.mint-review",
          message: "Mint reconciliation and upgrade linkage have not been reviewed.",
        }).status,
        controlKey: null,
        reconciliation: "unknown",
        upgrade: { state: "unknown", controlKey: null },
      },
      oracle: {
        status: missingLocalFact(context, {
          componentKey: "economic-control:oracle",
          reasonCode: "missing-oracle-profile",
          ownerDomain: "control",
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
    createV9FactGap({
      gapId: `${context.asset.assetId}:gap:access:${componentKey}`,
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "control",
      policyRuleId: original.applicability.policyRuleId,
      observationState: original.observationState,
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
          reasonCode: "missing-pillar-evidence",
          ownerDomain: "control",
          policyRuleId: "v9.access.transfer-review",
          message: "Transfer permissioning posture has not been reviewed.",
        }).status,
        posture: null,
      },
      freeze: {
        status: missingLocalFact(context, {
          componentKey: "access:freeze",
          reasonCode: "missing-pillar-evidence",
          ownerDomain: "control",
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
  const complete =
    reference !== null &&
    peg.pegScore !== null &&
    peg.currentDeviationBps !== null &&
    (!peg.activeDepeg || activeDepegBps !== null);
  let status: V9FactStatusV2;
  if (!complete) {
    status = missingLocalFact(context, {
      componentKey: "peg",
      reasonCode: reference === null ? "missing-applicable-peg" : "missing-peg-input",
      ownerDomain: "peg",
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
    pegScore: complete ? peg.pegScore : null,
    // The v8 peg summary reports signed deviation; the v9 peg fact carries the
    // magnitude per its nonnegative schema contract.
    currentDeviationBps: complete && peg.currentDeviationBps !== null ? Math.abs(peg.currentDeviationBps) : null,
    activeDepeg: complete ? peg.activeDepeg : null,
    activeDepegBps: complete && peg.activeDepeg ? activeDepegBps : null,
    trackingSpanDays: peg.trackingSpanDays,
    failureDomains: reference?.failureDomains ?? [],
  };
}

function buildSupply(context: AssetBuildContext): V9AssetFactsV2["supply"] {
  const source = context.extension.sources.chainSupply;
  const chainRows = context.fixedInput.chainCirculatingById[context.asset.assetId] ?? {};
  const chains = Object.keys(chainRows).sort(compareText);
  const circulatingUsd = chains.reduce((sum, chain) => sum + chainRows[chain]!.current, 0);
  if (chains.length === 0) {
    return {
      status: missingLocalFact(context, {
        componentKey: "chain-supply",
        reasonCode: "missing-pillar-evidence",
        ownerDomain: "evidence",
        policyRuleId: "v9.supply.current",
        message: "No USD-denominated chain circulating rows are present in the exact fixed input.",
      }).status,
      sourceGenerationId: source.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: null,
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: null,
      unknownRouteSupplyShare: null,
      unreviewedRouteSupplyShare: null,
      failureDomains: [],
    };
  }
  const evidenceId = addEvidence(
    context,
    createV9EvidenceReference(
      {
        evidenceId: `${context.asset.assetId}:chain-supply`,
        sourceId: "report-cards-chain-circulating",
        sourceGenerationId: source.generationId,
        disposition: "observed",
        observedAtSec: source.observedAtSec,
        contentSha256: digest("safety-score-v9.chain-supply.v1", chainRows),
        maxAgeSec: source.maxAgeSec,
      },
      context.fixedInput.clockSec,
    ),
  );
  const evidence = context.evidence.get(evidenceId)!;
  const review = context.asset.supplyReview;
  let status: V9FactStatusV2;
  if (evidence.freshness.state === "stale") {
    status = missingLocalFact(context, {
      componentKey: "chain-supply",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "evidence",
      policyRuleId: "v9.supply.current",
      message: "The chain supply observation is stale.",
      observationState: "stale",
      evidenceRefIds: [evidenceId],
    }).status;
  } else if (review === null) {
    status = missingLocalFact(context, {
      componentKey: "bridge-materiality",
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "dependency",
      policyRuleId: "v9.supply.bridge-materiality",
      message: "Circulating USD is known, but bridge-route materiality has not been reviewed.",
      observationState: "bounded-unknown",
      evidenceRefIds: [evidenceId],
    }).status;
  } else {
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
    selectedBridgeRoutes: review?.selectedBridgeRoutes ?? [],
    selectedRouteSupplyShare: review?.selectedRouteSupplyShare ?? null,
    unknownRouteSupplyShare: review?.unknownRouteSupplyShare ?? null,
    unreviewedRouteSupplyShare: review?.unreviewedRouteSupplyShare ?? null,
    failureDomains: stableFailureDomains([
      ...chains.map((chain) => ({ kind: "chain" as const, key: chain })),
      ...(review?.failureDomains ?? []),
    ]),
  };
}

function compileAsset(
  fixedInput: ReportCardsFixedInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  asset: AssetExtension,
  researchPayloadSha256: string,
): V9AssetFactsV2 {
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
  const rawDependencies = buildDependencies(context);
  const reserves = buildReserves(context);
  const dependencies = reconcileCollateralDependencyMappings(context, rawDependencies, reserves.reserveExposures);
  const routes = buildRoutes(context);
  const controls = buildControls(context);
  const economicControlReview = buildEconomicControlReview(context);
  const accessReview = buildAccessReview(context);
  const peg = buildPeg(context);
  const supply = buildSupply(context);
  return {
    assetId: asset.assetId,
    archetype: asset.archetype,
    evidence: [...context.evidence.values()],
    gaps: [...context.gaps.values()],
    implementation,
    mechanismRiskReview,
    dependencies,
    ...reserves,
    ...routes,
    ...controls,
    economicControlReview,
    accessReview,
    peg,
    supply,
  };
}

/**
 * Compile policy-independent V9 facts directly from publication-exact base inputs.
 * ReportCard score outputs are intentionally not part of this adapter contract.
 */
export function compileSafetyScoreV9FactSetFromFixedInput(
  fixedInputValue: unknown,
  extensionValue: unknown,
): Readonly<CompiledV9FactSetV2> {
  return compileSafetyScoreV9FactSetFromNormalizedInput(
    normalizeFixedInput(fixedInputValue),
    SafetyScoreV9FactSetExtensionV2Schema.parse(extensionValue),
  );
}

/** Trusted runtime entrypoint for already validated publication inputs. */
export function compileSafetyScoreV9FactSetFromNormalizedInput(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extension: Readonly<SafetyScoreV9FactSetExtensionV2>,
): Readonly<CompiledV9FactSetV2> {
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
  return compileV9FactSetV2({
    schemaVersion: 2,
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
        payloadSha256: digest("safety-score-v9.chain-supply.v1", {
          chainCirculatingById: fixedInput.chainCirculatingById,
          dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
        }),
        observedAtSec: extension.sources.chainSupply.observedAtSec,
      },
      peg: {
        generationId: extension.sources.peg.generationId,
        payloadSha256: digest("safety-score-v9.peg.v1", {
          pegDataById: fixedInput.pegDataById,
          activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
        }),
        observedAtSec: extension.sources.peg.observedAtSec,
      },
      researchOverlays: {
        generationId: extension.sources.researchOverlays.generationId,
        payloadSha256: researchPayloadSha256,
        observedAtSec: extension.sources.researchOverlays.observedAtSec,
      },
    },
    activeAssetIds: fixedInput.activeAssetIds,
    assets: extension.assets.map((asset) => compileAsset(fixedInput, extension, asset, researchPayloadSha256)),
  });
}
