import { z } from "zod";
import { DependencyTypeSchema } from "./dependency-types";
import { V9PathKindSchema, V9ReasonCodeSchema, V9ReasonOwnerDomainSchema } from "./safety-score-v9";
import { V9MechanismRiskReviewSchema } from "./safety-score-v9-backing";
import {
  V9FactStatusV2Schema,
  V9FailureDomainRefSchema,
  V9ObservationStateSchema,
  type V9FactApplicability,
  type V9FactStatusV2,
  type V9FailureDomainKind,
  type V9FailureDomainRef,
  type V9ObservationState,
} from "./safety-score-v9-fact-primitives";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";

export const V9ResolvedMechanismArchetypeSchema = z.union([
  z.enum(MECHANISM_ARCHETYPE_VALUES),
  z.literal("unresolved"),
]);
export type V9ResolvedMechanismArchetype = z.infer<typeof V9ResolvedMechanismArchetypeSchema>;

export {
  V9FactStatusV2Schema,
};
export type { V9FactApplicability, V9FactStatusV2, V9FailureDomainKind, V9FailureDomainRef, V9ObservationState };

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UnixSecondsSchema = z.number().int().nonnegative();
const FractionSchema = z.number().finite().min(0).max(1);
const PositiveFractionSchema = z.number().finite().positive().max(1);
const NonNegativeUsdSchema = z.number().finite().nonnegative();
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalArrayBy<T>(schema: z.ZodType<T>, keyOf: (value: T) => string) {
  return z
    .array(schema)
    .superRefine((values, ctx) => {
      const keys = values.map(keyOf);
      const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicate !== undefined) {
        ctx.addIssue({ code: "custom", message: `Duplicate canonical key: ${duplicate}` });
      }
    })
    .transform((values) => [...values].sort((left, right) => compareText(keyOf(left), keyOf(right))));
}

const CanonicalStringArraySchema = canonicalArrayBy(CanonicalTextSchema, (value) => value);

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
export type V9EvidenceFreshness = z.infer<typeof V9EvidenceFreshnessSchema>;

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

export const V9FactGapV2Schema = z
  .object({
    gapId: CanonicalTextSchema,
    reasonCode: V9ReasonCodeSchema,
    ownerDomain: V9ReasonOwnerDomainSchema,
    policyRuleId: CanonicalTextSchema,
    observationState: V9ObservationStateSchema.exclude(["known"]),
    path: V9TypedFactPathSchema,
    message: CanonicalTextSchema,
    evidenceRefIds: CanonicalStringArraySchema,
  })
  .strict()
  .superRefine((gap, ctx) => {
    if (!V9PathKindSchema.safeParse(gap.path.kind).success) {
      ctx.addIssue({ code: "custom", path: ["path", "kind"], message: "Gap path kind is not registered by v9" });
    }
  });
export type V9FactGapV2 = z.infer<typeof V9FactGapV2Schema>;

const CanonicalFailureDomainsSchema = canonicalArrayBy(
  V9FailureDomainRefSchema,
  (domain) => `${domain.kind}:${domain.key}`,
);

const V9EffectiveDependencyEdgeV2Schema = z
  .object({
    edgeKey: CanonicalTextSchema,
    upstreamAssetId: CanonicalTextSchema,
    dependencyType: DependencyTypeSchema,
    pathKind: z.enum(["serial-dependency", "collateral-exposure"]),
    weight: PositiveFractionSchema,
    economicRole: z.enum(["serial-claim", "basket-exposure"]),
    evidenceRefIds: CanonicalStringArraySchema,
    failureDomains: CanonicalFailureDomainsSchema,
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
export type V9EffectiveDependencyEdgeV2 = z.infer<typeof V9EffectiveDependencyEdgeV2Schema>;

const V9EffectiveDependenciesV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    sourceGenerationId: CanonicalTextSchema,
    source: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none", "variant"]),
    baseSource: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none"]),
    dependencyFromLive: z.boolean(),
    mappedLiveReserveWeight: FractionSchema.nullable(),
    fallbackReason: z
      .enum(["live-unmapped-to-curated-reserve", "live-unmapped-to-manual", "live-cycle-to-curated"])
      .nullable(),
    edges: canonicalArrayBy(V9EffectiveDependencyEdgeV2Schema, (edge) => edge.edgeKey),
    diagnostics: z
      .object({
        graphState: z.enum(["valid", "cycle", "invalid", "unresolved"]),
        issueCodes: CanonicalStringArraySchema,
        sccMemberAssetIds: CanonicalStringArraySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((dependencies, ctx) => {
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
      .filter((edge) => edge.pathKind === "collateral-exposure")
      .reduce((sum, edge) => sum + edge.weight, 0);
    if (collateralWeight > 1.000001) {
      ctx.addIssue({ code: "custom", path: ["edges"], message: "Collateral dependency weight cannot exceed 1" });
    }
  });
export type V9EffectiveDependenciesV2 = z.infer<typeof V9EffectiveDependenciesV2Schema>;

export const V9ReserveAssetClassSchema = z.enum([
  "cash",
  "bank-deposit",
  "treasury-bill",
  "government-security",
  "repo",
  "money-market-fund",
  "stablecoin",
  "cryptoasset",
  "hedged-crypto",
  "private-credit",
  "public-credit",
  "tokenized-security",
  "fund-share",
  "protocol-position",
  "other",
]);

const V9ReserveExposureFactV2Schema = z
  .object({
    exposureKey: CanonicalTextSchema,
    classificationKey: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    provenance: z.enum(["live", "curated", "curated-fallback"]),
    status: V9FactStatusV2Schema,
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
    if (exposure.status.observationState === "known" && exposure.status.applicability.state === "required") {
      if (exposure.assetClass === null) {
        ctx.addIssue({ code: "custom", path: ["assetClass"], message: "Known reserve exposure requires asset class" });
      }
      if (exposure.failureDomains.length === 0) {
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
    executionCostBps: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((point, ctx) => {
    if (point.executableUsd > point.requestedNotionalUsd + 0.01) {
      ctx.addIssue({ code: "custom", path: ["executableUsd"], message: "Executable value exceeds requested value" });
    }
    if (Math.abs(point.completionRatio - point.executableUsd / point.requestedNotionalUsd) > 0.00001) {
      ctx.addIssue({ code: "custom", path: ["completionRatio"], message: "Completion ratio is inconsistent" });
    }
    if (point.executableUsd > 0 && point.executionCostBps > point.maxCostBps) {
      ctx.addIssue({ code: "custom", path: ["executionCostBps"], message: "Execution cost exceeds the request limit" });
    }
  });

const CanonicalCapacityCurveSchema = canonicalArrayBy(
  V9RouteCapacityPointV2Schema,
  (point) => `${String(point.maxCostBps).padStart(20, "0")}:${String(point.requestedNotionalUsd).padStart(30, "0")}`,
);

const V9RouteOutputValuationV2Schema = z
  .object({
    basis: z.enum(["price", "nav", "fx", "reviewed-par"]),
    referenceAssetKey: CanonicalTextSchema,
    unitValueUsd: z.number().finite().positive(),
    expectedUnitValueUsd: z.number().finite().positive(),
    valueRetentionRatio: z.number().finite().nonnegative().max(2),
    sourceId: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema,
    asOfSec: UnixSecondsSchema,
    confidence: z.enum(["high", "medium", "low", "unknown"]),
    freshness: V9EvidenceFreshnessSchema,
    evidenceRefIds: CanonicalStringArraySchema,
  })
  .strict()
  .superRefine((valuation, ctx) => {
    const expectedRatio = valuation.unitValueUsd / valuation.expectedUnitValueUsd;
    if (Math.abs(valuation.valueRetentionRatio - expectedRatio) > 0.000001) {
      ctx.addIssue({ code: "custom", path: ["valueRetentionRatio"], message: "Value retention is inconsistent" });
    }
  });

const V9RouteOutputV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    kind: z.enum(["tracked-stablecoin", "fiat", "collateral", "basket", "unknown"]),
    assetKeys: CanonicalStringArraySchema,
    basketWeights: canonicalArrayBy(
      z.object({ assetKey: CanonicalTextSchema, weight: PositiveFractionSchema }).strict(),
      (entry) => entry.assetKey,
    ),
    valuation: V9RouteOutputValuationV2Schema.nullable(),
  })
  .strict()
  .superRefine((output, ctx) => {
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

const V9ExitRouteFactV2Schema = z
  .object({
    routeKey: CanonicalTextSchema,
    routeId: CanonicalTextSchema,
    lane: z.enum(["dex", "redemption"]),
    sourceGenerationId: CanonicalTextSchema,
    routeFamily: z.enum([
      "dex-amm",
      "dex-orderbook",
      "issuer-redemption",
      "protocol-redemption",
      "eventual-redemption",
    ]),
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
    observationConfidence: z.enum(["high", "medium", "low", "unknown"]),
    evidenceKind: z.enum([
      "measured-executable-depth",
      "reserve-based-amm-simulation",
      "direct-orderbook-depth",
      "generic-tvl-proxy",
      "synthetic-or-fallback",
      "unobserved",
      "documented-terms",
      "live-reserve-state",
      "onchain-contract-state",
      "manual-review",
    ]),
    coverageClass: z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]),
    settlementModel: z.enum(["atomic", "same-day", "bounded-delay", "queued", "eventual", "unknown"]),
    settlementSlaSec: z.number().int().nonnegative().nullable(),
    settlementEvidenceRefIds: CanonicalStringArraySchema,
    physicalResourceKeys: CanonicalStringArraySchema,
    status: V9FactStatusV2Schema,
    scoreEligible: z.boolean(),
    request: V9RouteRequestV2Schema.nullable(),
    capacityCurve: CanonicalCapacityCurveSchema,
    output: V9RouteOutputV2Schema,
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((route, ctx) => {
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
        route.holderAccess === "unknown" ||
        route.executionModel === "unknown" ||
        route.executionCertainty === "unknown" ||
        route.observationConfidence === "unknown" ||
        route.settlementModel === "unknown"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Score-eligible route requires explicit access, execution, confidence, and settlement facts",
        });
      }
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

const V9ControlCapabilitySchema = z.enum([
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

const V9DeploymentControlFactV2Schema = z
  .object({
    controlKey: CanonicalTextSchema,
    deploymentKey: CanonicalTextSchema,
    sourceGenerationId: CanonicalTextSchema,
    controlKind: z.enum(["mint", "upgrade", "custody", "oracle", "bridge", "freeze", "governance"]),
    scope: z.enum(["global", "deployment", "exposure", "route"]),
    status: V9FactStatusV2Schema,
    capabilities: canonicalArrayBy(V9ControlCapabilitySchema, (capability) => capability),
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
    failureDomains: CanonicalFailureDomainsSchema,
  })
  .strict()
  .superRefine((control, ctx) => {
    if (control.authority?.model === "multisig") {
      if (!control.authority.threshold || control.authority.threshold.required > control.authority.threshold.total) {
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
        control.capSemantics.kind === "unknown" ||
        control.claimImpairment === "unknown" ||
        control.economicLossScope === "unknown"
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
    controlKey: CanonicalTextSchema.nullable(),
    reconciliation: z.enum(["continuous", "periodic", "not-applicable", "unknown"]),
    upgrade: V9UpgradeControlReviewV2Schema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.status.applicability.state === "not-applicable") {
      if (review.controlKey !== null || review.reconciliation !== "not-applicable") {
        ctx.addIssue({ code: "custom", message: "Not-applicable mint review cannot claim mint facts" });
      }
    }
    if (
      review.status.observationState === "known" &&
      review.status.applicability.state === "required" &&
      review.reconciliation === "unknown"
    ) {
      ctx.addIssue({ code: "custom", path: ["reconciliation"], message: "Known mint review needs reconciliation" });
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
    tier: z
      .enum([
        "oracleless-or-internal",
        "redundant-with-failover",
        "medianized-with-delay",
        "standard-external",
        "single-source-or-laggy",
        "opaque-or-unknown",
      ])
      .nullable(),
    branches: canonicalArrayBy(V9OracleBranchReviewV2Schema, (branch) => branch.branch),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      review.status.applicability.state === "not-applicable" &&
      (review.tier !== null || review.branches.length > 0)
    ) {
      ctx.addIssue({ code: "custom", message: "Not-applicable oracle review cannot claim oracle facts" });
    }
    if (
      review.status.observationState === "known" &&
      review.status.applicability.state === "required" &&
      review.tier === null
    ) {
      ctx.addIssue({ code: "custom", path: ["tier"], message: "Known required oracle review needs a tier" });
    }
  });

const V9BridgeRouteControlReviewV2Schema = z
  .object({
    controlKey: CanonicalTextSchema,
    tier: z.enum([
      "single-chain-or-native",
      "issuer-native-burn-mint",
      "canonical-rollup-bridge",
      "issuer-native-lock-mint",
      "external-validated-network",
      "liquidity-or-intent-route",
      "external-lock-mint",
      "opaque-or-unknown",
    ]),
  })
  .strict();

const V9BridgeControlReviewV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    routes: canonicalArrayBy(V9BridgeRouteControlReviewV2Schema, (route) => route.controlKey),
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
export type V9PegFactV2 = z.infer<typeof V9PegFactV2Schema>;

const V9BridgeSupplyRouteV2Schema = z
  .object({
    deploymentRouteKey: CanonicalTextSchema,
    supplyUsd: NonNegativeUsdSchema,
    supplyShare: FractionSchema,
    reviewState: z.enum(["selected-reviewed", "selected-unresolved", "unmatched"]),
  })
  .strict();

const V9SupplyFactV2Schema = z
  .object({
    status: V9FactStatusV2Schema,
    sourceGenerationId: CanonicalTextSchema,
    sourceKind: z.enum(["usd-denominated-circulating", "raw-supply-times-price", "reported-market-cap"]),
    circulatingUnits: z.number().finite().nonnegative().nullable(),
    referencePriceUsd: z.number().finite().nonnegative().nullable(),
    circulatingUsd: NonNegativeUsdSchema.nullable(),
    selectedBridgeRoutes: canonicalArrayBy(V9BridgeSupplyRouteV2Schema, (route) => route.deploymentRouteKey),
    selectedRouteSupplyShare: FractionSchema.nullable(),
    unknownRouteSupplyShare: FractionSchema.nullable(),
    unreviewedRouteSupplyShare: FractionSchema.nullable(),
    failureDomains: CanonicalFailureDomainsSchema,
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
    if (supply.sourceKind === "usd-denominated-circulating" && supply.referencePriceUsd !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["referencePriceUsd"],
        message: "USD-denominated circulating supply must not be multiplied by price",
      });
    }
    const shares = [supply.selectedRouteSupplyShare, supply.unknownRouteSupplyShare, supply.unreviewedRouteSupplyShare];
    if (shares.every((share) => share !== null) && shares.reduce((sum, share) => sum + share!, 0) > 1.000001) {
      ctx.addIssue({ code: "custom", message: "Bridge supply shares cannot exceed 1" });
    }
  });
export type V9SupplyFactV2 = z.infer<typeof V9SupplyFactV2Schema>;

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

const V9AssetFactsV2Schema = z
  .object({
    assetId: CanonicalTextSchema,
    archetype: V9ResolvedMechanismArchetypeSchema,
    evidence: canonicalArrayBy(V9EvidenceReferenceV2Schema, (reference) => reference.evidenceId),
    gaps: canonicalArrayBy(V9FactGapV2Schema, (gap) => gap.gapId),
    implementation: V9ImplementationFactV2Schema,
    mechanismRiskReview: V9MechanismRiskReviewFactV2Schema,
    dependencies: V9EffectiveDependenciesV2Schema,
    reserveStatus: V9FactStatusV2Schema,
    reserveExposures: canonicalArrayBy(V9ReserveExposureFactV2Schema, (exposure) => exposure.exposureKey),
    exitStatus: V9FactStatusV2Schema,
    exitRoutes: canonicalArrayBy(V9ExitRouteFactV2Schema, (route) => route.routeKey),
    controlStatus: V9FactStatusV2Schema,
    controls: canonicalArrayBy(V9DeploymentControlFactV2Schema, (control) => control.controlKey),
    economicControlReview: V9EconomicControlReviewV2Schema,
    accessReview: V9AccessReviewV2Schema,
    peg: V9PegFactV2Schema,
    supply: V9SupplyFactV2Schema,
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.mechanismRiskReview.review && asset.mechanismRiskReview.review.archetype !== asset.archetype) {
      ctx.addIssue({
        code: "custom",
        path: ["mechanismRiskReview", "review", "archetype"],
        message: "Mechanism review archetype does not match the asset archetype",
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
  });
export type V9AssetFactsV2 = z.infer<typeof V9AssetFactsV2Schema>;

const V9FactSourceIdentityV2Schema = z
  .object({
    generationId: CanonicalTextSchema,
    payloadSha256: Sha256Schema,
    observedAtSec: UnixSecondsSchema,
  })
  .strict();

export const V9FactSourceFingerprintsV2Schema = z
  .object({
    registry: V9FactSourceIdentityV2Schema,
    dex: V9FactSourceIdentityV2Schema,
    redemption: V9FactSourceIdentityV2Schema,
    liveReserves: V9FactSourceIdentityV2Schema,
    chainSupply: V9FactSourceIdentityV2Schema,
    peg: V9FactSourceIdentityV2Schema,
    researchOverlays: V9FactSourceIdentityV2Schema,
  })
  .strict();
export type V9FactSourceFingerprintsV2 = z.infer<typeof V9FactSourceFingerprintsV2Schema>;

const V9FactSetCoreFields = {
  schemaVersion: z.literal(2),
  baseInputGenerationId: BaseInputGenerationIdSchema,
  asOfSec: UnixSecondsSchema,
  compiledAtSec: UnixSecondsSchema,
  sourceFingerprints: V9FactSourceFingerprintsV2Schema,
  activeAssetIds: CanonicalStringArraySchema.pipe(z.array(CanonicalTextSchema).min(1)),
  assets: canonicalArrayBy(V9AssetFactsV2Schema, (asset) => asset.assetId),
};

const V9FactSetCoreObjectSchema = z.object(V9FactSetCoreFields).strict();
export type V9FactSetCoreV2 = z.infer<typeof V9FactSetCoreObjectSchema>;

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function factStatuses(asset: V9AssetFactsV2): Array<{ label: string; status: V9FactStatusV2 }> {
  const mechanismStatuses = asset.mechanismRiskReview.review
    ? Object.entries(asset.mechanismRiskReview.review).flatMap(([key, value]) =>
        value !== null && typeof value === "object" && "status" in value
          ? [{ label: `mechanism-review:${key}`, status: value.status as V9FactStatusV2 }]
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
    { label: "exit-envelope", status: asset.exitStatus },
    ...asset.exitRoutes.flatMap((fact) => [
      { label: `route:${fact.routeKey}`, status: fact.status },
      { label: `route-output:${fact.routeKey}`, status: fact.output.status },
    ]),
    { label: "control-envelope", status: asset.controlStatus },
    ...asset.controls.map((fact) => ({ label: `control:${fact.controlKey}`, status: fact.status })),
    { label: "economic-control:mint", status: asset.economicControlReview.mint.status },
    { label: "economic-control:oracle", status: asset.economicControlReview.oracle.status },
    ...asset.economicControlReview.oracle.branches.map((branch) => ({
      label: `economic-control:oracle:${branch.branch}`,
      status: branch.status,
    })),
    { label: "economic-control:bridge", status: asset.economicControlReview.bridge.status },
    { label: "access:transfer", status: asset.accessReview.transfer.status },
    { label: "access:freeze", status: asset.accessReview.freeze.status },
    ...asset.accessReview.freeze.reviews.map((review) => ({
      label: `access:freeze:${review.reviewKey}`,
      status: review.status,
    })),
    { label: "peg", status: asset.peg.status },
    { label: "supply", status: asset.supply.status },
  ];
}

function validateAssetReferences(
  asset: V9AssetFactsV2,
  activeAssetIds: ReadonlySet<string>,
  assetIndex: number,
  ctx: z.RefinementCtx,
): void {
  const evidenceById = new Map(asset.evidence.map((reference) => [reference.evidenceId, reference]));
  const evidenceIds = new Set(evidenceById.keys());
  const gapIds = new Set(asset.gaps.map((gap) => gap.gapId));
  const referencedEvidenceIds = new Set<string>();
  const referencedGapIds = new Set<string>();

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
  for (const edge of asset.dependencies.edges) captureRefs(`dependency:${edge.edgeKey}`, edge.evidenceRefIds, []);
  for (const route of asset.exitRoutes) {
    captureRefs(`settlement:${route.routeKey}`, route.settlementEvidenceRefIds, []);
    if (route.output.valuation) captureRefs(`valuation:${route.routeKey}`, route.output.valuation.evidenceRefIds, []);
  }
  for (const gap of asset.gaps) captureRefs(`gap:${gap.gapId}`, gap.evidenceRefIds, []);

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
    const expectedKey = `${edge.dependencyType}:${edge.upstreamAssetId}`;
    if (edge.edgeKey !== expectedKey) {
      addIssue(ctx, ["assets", assetIndex, "dependencies", "edges", edgeIndex, "edgeKey"], `Expected ${expectedKey}`);
    }
    const relationKey = `${edge.upstreamAssetId}:${edge.dependencyType}`;
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
  const resourceOwners = new Map<string, string>();
  for (const route of asset.exitRoutes.filter((candidate) => candidate.scoreEligible)) {
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
  for (const [gapIndex, gap] of asset.gaps.entries()) {
    const path = gap.path;
    if (path.kind === "serial-dependency") {
      const key = `${path.dependencyType}:${path.upstreamAssetId}`;
      if (!asset.dependencies.edges.some((edge) => edge.edgeKey === key)) {
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

function validateFactSetCore(value: V9FactSetCoreV2, ctx: z.RefinementCtx): void {
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

  for (const [assetIndex, asset] of value.assets.entries()) {
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
    validateAssetReferences(asset, activeAssetIds, assetIndex, ctx);
  }
}

export const V9FactSetCoreV2Schema = V9FactSetCoreObjectSchema.superRefine(validateFactSetCore);

export const CompiledV9FactSetV2Schema = z
  .object({ ...V9FactSetCoreFields, v9FactSetDigest: Sha256Schema })
  .strict()
  .superRefine(validateFactSetCore);
export type CompiledV9FactSetV2 = z.infer<typeof CompiledV9FactSetV2Schema>;

const V9PublicFactGapV2Schema = z
  .object({
    gapId: CanonicalTextSchema,
    reasonCode: V9ReasonCodeSchema,
    ownerDomain: V9ReasonOwnerDomainSchema,
    policyRuleId: CanonicalTextSchema,
    observationState: V9ObservationStateSchema.exclude(["known"]),
    pathKind: V9PathKindSchema,
  })
  .strict();

const V9PublicAssetFactProjectionV2Schema = z
  .object({
    assetId: CanonicalTextSchema,
    archetype: V9ResolvedMechanismArchetypeSchema,
    stateCounts: z
      .object({
        known: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        unsupported: z.number().int().nonnegative(),
        boundedUnknown: z.number().int().nonnegative(),
        notApplicable: z.number().int().nonnegative(),
        applicabilityUnresolved: z.number().int().nonnegative(),
      })
      .strict(),
    dependencies: canonicalArrayBy(
      z
        .object({
          upstreamAssetId: CanonicalTextSchema,
          dependencyType: DependencyTypeSchema,
          pathKind: z.enum(["serial-dependency", "collateral-exposure"]),
          weight: PositiveFractionSchema,
        })
        .strict(),
      (dependency) => `${dependency.dependencyType}:${dependency.upstreamAssetId}`,
    ),
    exitRoutes: canonicalArrayBy(
      z
        .object({
          routeKey: CanonicalTextSchema,
          lane: z.enum(["dex", "redemption"]),
          observationState: V9ObservationStateSchema,
          scoreEligible: z.boolean(),
        })
        .strict(),
      (route) => route.routeKey,
    ),
    supply: z
      .object({
        observationState: V9ObservationStateSchema,
        circulatingUsd: NonNegativeUsdSchema.nullable(),
        selectedRouteSupplyShare: FractionSchema.nullable(),
        unknownRouteSupplyShare: FractionSchema.nullable(),
        unreviewedRouteSupplyShare: FractionSchema.nullable(),
      })
      .strict(),
    gaps: canonicalArrayBy(V9PublicFactGapV2Schema, (gap) => gap.gapId),
  })
  .strict();

export const V9PublicFactSetProjectionV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    v9FactSetDigest: Sha256Schema,
    asOfSec: UnixSecondsSchema,
    activeAssetIds: CanonicalStringArraySchema.pipe(z.array(CanonicalTextSchema).min(1)),
    assets: canonicalArrayBy(V9PublicAssetFactProjectionV2Schema, (asset) => asset.assetId),
  })
  .strict();
export type V9PublicFactSetProjectionV2 = z.infer<typeof V9PublicFactSetProjectionV2Schema>;
