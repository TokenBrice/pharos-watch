import { z } from "zod";
import { CanonicalChainIdSchema, CanonicalTextSchema, FractionSchema, UnixSecondsSchema } from "./safety-score-v9-fact-input-primitives";
import { canonicalArrayBy, V9WrapperRiskAssessmentSchema } from "./safety-score-v9-fact-primitives";
import { StrictIsoDateSchema } from "./safety-schema-primitives";
import { V9WrapperLocalFactKeySchema } from "./safety-score-v9-wrapper";

const SourceSchema = z.object({ label: CanonicalTextSchema, url: z.string().url() }).strict();
const DateSchema = StrictIsoDateSchema;
const V9AllocationLeverageSchema = z.enum(["no-borrowing-surface", "bounded-up-to-1.1x", "bounded-up-to-1.5x", "bounded-up-to-2x", "unbounded-or-above-2x"]);
const V9AllocationReuseSchema = z.enum(["none", "bluechip-overcollateralized-lending", "mixed-overcollateralized-lending", "long-tail-overcollateralized-lending", "multi-strategy-reuse", "liquidation-loss-absorption", "single-borrower-risk-capital"]);
export const V9AllocationScoredDimensionSchema = V9WrapperLocalFactKeySchema.extract(["custodyEscrow", "leverage", "rehypothecationCorrelation"]);
export type V9AllocationScoredDimension = z.output<typeof V9AllocationScoredDimensionSchema>;
const V9AllocationDimensionSchema = z.enum([...V9AllocationScoredDimensionSchema.options, "providerIdentity", "holderClaim", "segregation", "bankruptcyRemoteness", "supervision"]);
const V9AllocationLayerSchema = z.enum(["contract", "immediate-custodian", "borrower-spv", "lender-of-record", "holder-claim", "parent"]);
const V9AllocationCustodyStatementSchema = z.enum(["idle-token-custody-absent", "segregated-structured", "unsegregated"]);
const V9AllocationLegalStatementSchema = z.enum(["provider-identified", "holder-rights-excluded", "participation-transfer-permitted", "conditional-segregation", "conditional-bankruptcy-remoteness", "supervision-context", "legal-scope-undisclosed", "parent-risk-carried"]);
const WrapperAllocationObservationSchema = z.object({ chain: CanonicalTextSchema, address: CanonicalTextSchema, function: CanonicalTextSchema, value: CanonicalTextSchema, block: z.number().int().nonnegative() }).strict();
const LEGAL_STATEMENTS: Partial<Record<z.output<typeof V9AllocationDimensionSchema>, readonly string[]>> = {
  providerIdentity: ["provider-identified"], holderClaim: ["holder-rights-excluded", "participation-transfer-permitted"],
  segregation: ["conditional-segregation"], bankruptcyRemoteness: ["conditional-bankruptcy-remoteness"],
  supervision: ["supervision-context"],
};

// Legacy whole-book reviews intentionally keep their original date semantics.
const V9WholeAllocationReviewSchema = z.object({
  scopeKind: z.literal("whole-allocation"), assetId: CanonicalTextSchema, reviewedAt: DateSchema, expiresAt: DateSchema,
  reviewer: CanonicalTextSchema, custody: z.literal("fully-onchain-no-offchain-custodian"),
  localLeverage: V9AllocationLeverageSchema, capitalReuse: V9AllocationReuseSchema, rationale: CanonicalTextSchema,
  observations: z.array(WrapperAllocationObservationSchema).min(1), sources: z.array(SourceSchema).min(1),
}).strict().superRefine((review, ctx) => {
  if (review.expiresAt <= review.reviewedAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Review must expire after review date" });
});

const V9AllocationDeploymentIdentitySchema = z.discriminatedUnion("codeKind", [
  z.object({ codeKind: z.literal("immutable"), chain: CanonicalChainIdSchema, address: CanonicalTextSchema, observedAtSec: UnixSecondsSchema, block: z.number().int().nonnegative(), sourceUrl: z.string().url() }).strict(),
  z.object({ codeKind: z.literal("proxy"), chain: CanonicalChainIdSchema, address: CanonicalTextSchema, implementation: CanonicalTextSchema, observedAtSec: UnixSecondsSchema, block: z.number().int().nonnegative(), sourceUrl: z.string().url() }).strict(),
]);
export const V9AllocationScopeIdentityReviewSchema = z.object({ assetId: CanonicalTextSchema, registeredDeploymentKeys: z.array(CanonicalTextSchema), deployments: z.array(V9AllocationDeploymentIdentitySchema) }).strict().superRefine((review, ctx) => {
  const keys = new Set<string>();
  for (const row of review.deployments) {
    const key = `${row.chain}:${row.address}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: ["deployments"], message: `Duplicate deployment identity: ${key}` });
    if (!review.registeredDeploymentKeys.includes(key)) ctx.addIssue({ code: "custom", path: ["deployments"], message: "Implementation identity must bind a registered deployment" });
    keys.add(key);
  }
});
const V9AllocationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deployment"), deployment: V9AllocationDeploymentIdentitySchema, reachableTargets: z.array(V9AllocationDeploymentIdentitySchema).min(1), reachableSetComplete: z.literal(true),
    idleCustodyProof: z.object({ mechanism: z.literal("burn-parent-mint-parent"), upstreamAssetId: CanonicalTextSchema, parentTokenAddress: CanonicalTextSchema, burnSourceUrl: z.string().url(), mintSourceUrl: z.string().url() }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal("reserve-leg"), sourceKey: CanonicalTextSchema.nullable(), providerOrEntity: CanonicalTextSchema.nullable(), applicability: z.enum(["conditional", "whole-book"]), conditions: CanonicalTextSchema }).strict(),
  z.object({ kind: z.literal("parent-claim"), upstreamAssetId: CanonicalTextSchema, edgeKey: CanonicalTextSchema, inheritedRisk: CanonicalTextSchema }).strict(),
]);
const V9AllocationCoverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conditional"), condition: CanonicalTextSchema, shareFraction: FractionSchema.nullable() }).strict(),
  z.object({ kind: z.literal("scope-only"), shareFraction: z.null() }).strict(),
  z.object({ kind: z.literal("whole-dimension"), denominator: z.literal("accepted-reserve-envelope"), reserveSourceKeys: z.array(CanonicalTextSchema).min(1), shareFraction: z.literal(1) }).strict(),
]);
const ClaimFields = {
  claimKey: CanonicalTextSchema, dimension: V9AllocationDimensionSchema, layer: V9AllocationLayerSchema,
  target: V9AllocationTargetSchema, coverage: V9AllocationCoverageSchema,
  disposition: z.enum(["reviewed", "not-applicable", "issuer-undisclosed", "inherited-parent"]),
  statement: z.union([V9AllocationLeverageSchema, V9AllocationReuseSchema, V9AllocationCustodyStatementSchema, V9AllocationLegalStatementSchema]),
  rationale: CanonicalTextSchema, reviewedAt: z.union([DateSchema, z.iso.datetime()]), observedAtSec: UnixSecondsSchema,
  expiresAtSec: UnixSecondsSchema, sources: z.array(SourceSchema).min(1),
  observations: z.array(z.object({ sourceUrl: z.string().url(), observedAtSec: UnixSecondsSchema, description: CanonicalTextSchema }).strict()).min(1),
};
export function allocationReviewClockSec(value: string): number {
  return value.length === 10 ? Date.parse(`${value}T00:00:00Z`) / 1_000 + 86_400 : Date.parse(value) / 1_000;
}
export const V9ScopedAllocationClaimSchema = z.object(ClaimFields).strict().superRefine((claim, ctx) => {
  const fail = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (claim.expiresAtSec <= Math.max(allocationReviewClockSec(claim.reviewedAt), claim.observedAtSec)) fail(["expiresAtSec"], "Claim expiry must follow observation and review");
  if (claim.observedAtSec > allocationReviewClockSec(claim.reviewedAt)) fail(["reviewedAt"], "Review cannot precede the observation");
  if (claim.claimKey.startsWith("required:")) fail(["claimKey"], "Required-scope diagnostic keys are compiler-owned");
  const allowed = claim.dimension === "leverage" ? V9AllocationLeverageSchema : claim.dimension === "rehypothecationCorrelation" ? V9AllocationReuseSchema : claim.dimension === "custodyEscrow" ? V9AllocationCustodyStatementSchema : V9AllocationLegalStatementSchema;
  if (claim.disposition !== "issuer-undisclosed" && claim.disposition !== "inherited-parent" && !allowed.safeParse(claim.statement).success) fail(["statement"], "Statement does not match dimension");
  if (claim.disposition === "reviewed" && LEGAL_STATEMENTS[claim.dimension] &&
    !LEGAL_STATEMENTS[claim.dimension]!.includes(claim.statement)) fail(["statement"], "Legal statement does not match its explanatory dimension");
  if (claim.dimension === "leverage" && claim.disposition !== "inherited-parent" &&
    !["contract", "borrower-spv", "lender-of-record"].includes(claim.layer)) fail(["layer"], "Borrowing proof must name the actual borrowing layer");
  if (claim.disposition === "issuer-undisclosed" && claim.statement !== "legal-scope-undisclosed") fail(["statement"], "Nondisclosure needs explicit unknown statement");
  if ((claim.disposition === "inherited-parent") !== (claim.target.kind === "parent-claim") || (claim.target.kind === "parent-claim" && (claim.layer !== "parent" || claim.statement !== "parent-risk-carried"))) fail(["target"], "Parent claims are adverse-only explanatory inheritance");
  if (claim.target.kind === "deployment" && claim.layer !== "contract") fail(["layer"], "Deployment fact must remain contract-local");
  if (claim.target.kind === "reserve-leg" && (claim.layer === "contract" || claim.layer === "parent")) fail(["layer"], "Legal leg must name a legal layer");
  if (claim.disposition === "not-applicable" && (claim.target.kind !== "deployment" || claim.statement !== "idle-token-custody-absent")) fail(["disposition"], "Structural N/A requires exact idle-custody proof");
  if (claim.statement === "idle-token-custody-absent" && (claim.disposition !== "not-applicable" ||
    claim.target.kind !== "deployment" || !claim.target.idleCustodyProof)) fail(["statement"], "Idle custody absence requires burn/mint structural proof");
  const sources = new Set(claim.sources.map((source) => source.url));
  for (const observation of claim.observations) if (!sources.has(observation.sourceUrl) || observation.observedAtSec > claim.observedAtSec) fail(["observations"], "Observations must bind claim sources and clock");
  if (claim.target.kind === "deployment") {
    const target = claim.target;
    const deployments = [target.deployment, ...target.reachableTargets];
    if (!target.reachableTargets.some((row) => row.chain === target.deployment.chain && row.address === target.deployment.address && row.codeKind === target.deployment.codeKind &&
      (row.codeKind !== "proxy" || target.deployment.codeKind !== "proxy" || row.implementation === target.deployment.implementation))) fail(["target"], "Reachable set must include exact root deployment");
    const keys = new Set<string>();
    for (const row of target.reachableTargets) {
      const key = `${row.chain}:${row.address}`;
      if (keys.has(key)) fail(["target"], "Reachable targets cannot overlap");
      keys.add(key);
    }
    for (const row of deployments) if (!sources.has(row.sourceUrl) || row.observedAtSec > claim.observedAtSec) fail(["target"], "Deployment observations must bind claim source and clock");
    if (target.idleCustodyProof && (!sources.has(target.idleCustodyProof.burnSourceUrl) || !sources.has(target.idleCustodyProof.mintSourceUrl))) fail(["target"], "Burn/mint proof must bind exact reviewed sources");
  }
  if (claim.coverage.kind === "whole-dimension" && new Set(claim.coverage.reserveSourceKeys).size !== claim.coverage.reserveSourceKeys.length) fail(["coverage"], "Coverage roster cannot overlap");
  if (claim.target.kind === "reserve-leg" && claim.target.applicability === "conditional" && claim.coverage.kind !== "conditional") fail(["coverage"], "Conditional legal legs cannot assert whole-book coverage");
  if (claim.target.kind === "reserve-leg" && claim.target.applicability === "whole-book" && (claim.target.providerOrEntity === null || claim.coverage.kind !== "whole-dimension")) fail(["coverage"], "Whole-book legal proof requires named entity and complete reserve denominator");
});
const V9ScopedAllocationReviewSchema = z.object({ scopeKind: z.literal("per-dimension"), assetId: CanonicalTextSchema, reviewer: CanonicalTextSchema, rationale: CanonicalTextSchema, claims: z.array(V9ScopedAllocationClaimSchema).min(1) }).strict().superRefine((review, ctx) => {
  const keys = new Set<string>();
  for (const claim of review.claims) {
    if (keys.has(claim.claimKey)) ctx.addIssue({ code: "custom", path: ["claims"], message: `Duplicate claim: ${claim.claimKey}` });
    keys.add(claim.claimKey);
  }
});
export const SafetyScoreV9WrapperAllocationReviewSchema = z.discriminatedUnion("scopeKind", [V9WholeAllocationReviewSchema, V9ScopedAllocationReviewSchema]);
export type SafetyScoreV9WrapperAllocationReview = z.output<typeof SafetyScoreV9WrapperAllocationReviewSchema>;
export type V9ScopedAllocationClaim = z.output<typeof V9ScopedAllocationClaimSchema>;
export type V9AllocationScopeIdentityReview = z.output<typeof V9AllocationScopeIdentityReviewSchema>;

export const V9AllocationScopeFactSchema = z.object({
  ...ClaimFields, admitted: z.boolean(), assessment: V9WrapperRiskAssessmentSchema.nullable(),
  disposition: z.enum(["reviewed", "not-applicable", "issuer-undisclosed", "inherited-parent", "integration-missing"]),
  target: V9AllocationTargetSchema.nullable(), coverage: V9AllocationCoverageSchema.nullable(),
  statement: ClaimFields.statement.nullable(), reviewedAt: ClaimFields.reviewedAt.nullable(),
  observedAtSec: UnixSecondsSchema.nullable(), expiresAtSec: UnixSecondsSchema.nullable(),
  sources: z.array(SourceSchema), observations: z.array(ClaimFields.observations.element),
  rejectionReason: z.enum(["future-observation", "expired", "identity-unmatched", "reserve-leg-unmatched", "reserve-coverage-unestablished", "parent-claim-unmatched", "evidence-unbound", "required-scope-unresolved", "overlapping-scope"]).nullable(),
  evidenceRefIds: z.array(CanonicalTextSchema), maxAgeSec: z.number().positive(), sourceGenerationId: CanonicalTextSchema,
}).strict().superRefine((fact, ctx) => {
  if (fact.admitted && (fact.rejectionReason !== null || fact.target === null || fact.evidenceRefIds.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Admitted scope requires target, evidence and no rejection" });
  }
  if (!fact.admitted && (fact.rejectionReason === null || fact.assessment !== null)) {
    ctx.addIssue({ code: "custom", message: "Rejected scope requires reason and cannot carry a risk assessment" });
  }
});
export type V9AllocationScopeFact = z.output<typeof V9AllocationScopeFactSchema>;

// Exact enum-keyed records reject omitted or extra assessment categories.
const RequiredLayersSchema = canonicalArrayBy(V9AllocationLayerSchema, (layer) => layer, 1);
const RequiredDimensions = z.object({
  custodyEscrow: RequiredLayersSchema,
  leverage: RequiredLayersSchema,
  rehypothecationCorrelation: RequiredLayersSchema,
}).strict();
export const V9WrapperAllocationScopePolicySchema = z.object({
  completenessMode: z.literal("all-required-scopes"), aggregation: z.literal("worst-risk"), parentLegalInheritance: z.literal("adverse-only"), contractIdentity: z.literal("exact-chain-deployment-implementation"),
  requiredScopes: z.object({ contractOnly: RequiredDimensions, mixedInstitutional: RequiredDimensions, privateCredit: RequiredDimensions }).strict(),
  leverageAssessments: z.record(V9AllocationLeverageSchema, V9WrapperRiskAssessmentSchema),
  reuseAssessments: z.record(V9AllocationReuseSchema, V9WrapperRiskAssessmentSchema),
  custodyAssessments: z.record(V9AllocationCustodyStatementSchema, V9WrapperRiskAssessmentSchema),
}).strict();
