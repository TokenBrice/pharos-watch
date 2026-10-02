import { z } from "zod";
import candidatePolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { BaseInputGenerationIdSchema, CanonicalChainIdSchema, CanonicalTextSchema, NonNegativeFiniteSchema, Sha256Schema, StrictIsoDateSchema, UnixSecondsSchema, uniqueKeyedCollectionSchema } from "./safety-schema-primitives";

const vocabulary = candidatePolicy.semantic.supplyAttribution;
function vocabularySchema(values: string[]) { return z.enum(values as [string, ...string[]]); }
const EconomicSupplyAmountBasisSchema = vocabularySchema(vocabulary.amountBases);
const EconomicSupplyHoldingKindSchema = vocabularySchema(vocabulary.holdingKinds);
const EconomicSupplyAccountingFamilySchema = vocabularySchema(vocabulary.accountingFamilies);
const EconomicSupplyInFlightTreatmentSchema = vocabularySchema(vocabulary.inFlightTreatments);
const REVIEWED_ECONOMIC_SUPPLY_MODEL = "reviewed-economic-deployment-partition-v1" as const;
export const V9SupplyAttributionPolicySchema = z.strictObject({
  amountBases: z.array(EconomicSupplyAmountBasisSchema).min(1),
  accountingFamilies: z.array(EconomicSupplyAccountingFamilySchema).min(1),
  holdingKinds: z.array(EconomicSupplyHoldingKindSchema).min(1),
  inFlightTreatments: z.array(EconomicSupplyInFlightTreatmentSchema).min(1),
  sourcePreference: z.literal("complete-provider-first"),
  journalSourceId: z.literal("reviewed.economic-deployment-partition.v1"),
  observationMaxAgeSec: z.number().int().positive(), observationMaxSkewSec: z.number().int().nonnegative(),
  referencePriceMaxAgeSec: z.number().int().positive(), postClockMaxSkewSec: z.number().int().nonnegative(),
  conservationAbsoluteToleranceUsd: z.number().finite().positive(), conservationRelativeTolerance: z.number().finite().positive(),
  reviewMaxAgeDays: z.number().int().positive(),
}).superRefine((value, ctx) => {
  for (const key of ["amountBases", "accountingFamilies", "holdingKinds", "inFlightTreatments"] as const) {
    if (new Set(value[key]).size !== value[key].length || value[key].length !== vocabulary[key].length) ctx.addIssue({ code: "custom", path: [key], message: "Supply vocabulary must include each policy value exactly once" });
  }
});
// eslint-disable-next-line security/detect-unsafe-regex -- anchored canonical decimal over a 128-character cap; groups cannot overlap.
const DecimalSchema = z.string().max(128).regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
const ReadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("provider-chain"), sourceChain: CanonicalTextSchema }),
  z.strictObject({ kind: z.literal("evm-total-supply"), safeBlockLag: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("evm-balance"), safeBlockLag: z.number().int().positive(), account: z.string().regex(/^0x[0-9a-f]{40}$/) }),
  z.strictObject({ kind: z.literal("solana-mint"), programOwner: CanonicalTextSchema }),
  z.strictObject({ kind: z.literal("xrpl-issued-currency"), currency: CanonicalTextSchema, issuer: CanonicalTextSchema }),
  z.strictObject({ kind: z.literal("native-from-aggregate"), safeBlockLag: z.number().int().positive() }),
]);
const CensusRowSchema = z.strictObject({
  deploymentKey: CanonicalTextSchema, chainId: CanonicalChainIdSchema, address: CanonicalTextSchema.nullable(),
  holdingKind: EconomicSupplyHoldingKindSchema, amountBasis: EconomicSupplyAmountBasisSchema,
  decimals: z.number().int().min(0).max(36).nullable(), routeId: CanonicalTextSchema.nullable(),
  read: ReadSchema, claimUnit: CanonicalTextSchema,
  conversionSourceId: CanonicalTextSchema.nullable(),
}).superRefine((row, ctx) => {
  const expected = row.holdingKind === "native-gas" ? `${row.chainId}:native:${row.address}` : `${row.chainId}:${row.address}`;
  if (row.address === null || row.deploymentKey !== expected) ctx.addIssue({ code: "custom", message: "Holding identity must use its exact economic deployment key" });
  if ((row.amountBasis === "fixed-token-units") !== (row.decimals !== null)) ctx.addIssue({ code: "custom", message: "Only fixed token units have fixed decimals" });
  if (row.read.kind === "xrpl-issued-currency" &&
    (row.chainId !== "xrpl" || row.amountBasis !== "issued-currency-decimal" ||
      row.address !== `${row.read.currency}.${row.read.issuer}`)) ctx.addIssue({ code: "custom", message: "XRPL identity must bind exact currency and issuer; no fixed decimals" });
});
const BalanceRuleSchema = z.strictObject({ id: CanonicalTextSchema, deploymentKey: CanonicalTextSchema, account: CanonicalTextSchema });
const ApiAmountReadSchema = z.strictObject({
  sourceId: CanonicalTextSchema, url: z.string().url().refine(url => url.startsWith("https://")),
  amountPath: z.array(CanonicalTextSchema).min(1), observedAtPath: z.array(CanonicalTextSchema).min(1),
  generationPath: z.array(CanonicalTextSchema).min(1),
});
// Reviewed enumerable pending queue: count and indexed ids prove coverage, not an
// escrow-minus-receipts estimate. Amounts are raw canonical token units.
const EvmPendingStateReadSchema = z.strictObject({
  kind: z.literal("evm-pending-state"), sourceId: CanonicalTextSchema,
  chainId: CanonicalChainIdSchema, bridgeAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  bridgeRuntimeCodeSha256: Sha256Schema, finality: z.literal("finalized"),
  messageCountSelector: z.string().regex(/^0x[0-9a-f]{8}$/),
  messageIdSelector: z.string().regex(/^0x[0-9a-f]{8}$/),
  pendingAmountSelector: z.string().regex(/^0x[0-9a-f]{8}$/),
  messageIds: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(64),
}).superRefine((source, ctx) => {
  if (new Set(source.messageIds).size !== source.messageIds.length) ctx.addIssue({ code: "custom", message: "Pending message identities must be unique" });
});
const PendingAmountReadSchema = z.union([ApiAmountReadSchema, EvmPendingStateReadSchema]);
export const ReviewedEconomicSupplyPlanSchema = z.strictObject({
  assetId: CanonicalTextSchema, reviewer: CanonicalTextSchema, reviewedAtSec: UnixSecondsSchema, expiresAtSec: UnixSecondsSchema,
  evidenceUrls: z.array(z.string().url()).min(1), economicScope: CanonicalTextSchema, sourceId: CanonicalTextSchema,
  accountingFamily: EconomicSupplyAccountingFamilySchema, commonClaimUnit: CanonicalTextSchema,
  exhaustive: z.literal(true), inFlightTreatment: EconomicSupplyInFlightTreatmentSchema,
  deployments: z.array(CensusRowSchema).min(1).max(64),
  conversionSources: z.array(ApiAmountReadSchema).max(64),
  referencePriceSource: ApiAmountReadSchema.nullable(),
  liabilityInFlightSource: ApiAmountReadSchema.nullable(),
  excludedRegistryDeploymentKeys: z.array(CanonicalTextSchema), exclusions: z.array(BalanceRuleSchema).max(64),
  escrows: z.array(z.strictObject({
    id: CanonicalTextSchema, canonicalDeploymentKey: CanonicalTextSchema, account: CanonicalTextSchema,
    receiptDeploymentKeys: z.array(CanonicalTextSchema).min(1), independentReceiptLiability: z.literal(false),
    receiptClaimSources: z.array(z.strictObject({ deploymentKey: CanonicalTextSchema, source: ApiAmountReadSchema })).max(64),
    inFlightSource: PendingAmountReadSchema.nullable(),
  })).max(64),
}).superRefine((plan, ctx) => {
  const keys = plan.deployments.map(row => row.deploymentKey);
  const ids = [...plan.exclusions, ...plan.escrows].map(row => row.id);
  const receipts = plan.escrows.flatMap(row => row.receiptDeploymentKeys);
  if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length || new Set(receipts).size !== receipts.length || new Set(plan.escrows.map(row => `${row.canonicalDeploymentKey}:${row.account}`)).size !== plan.escrows.length) ctx.addIssue({ code: "custom", message: "Duplicate census, balance rule or escrow receipt" });
  const balances = [...plan.exclusions.map(row => `${row.deploymentKey}:${row.account.toLowerCase()}`),
    ...plan.escrows.map(row => `${row.canonicalDeploymentKey}:${row.account.toLowerCase()}`)];
  if (new Set(balances).size !== balances.length) ctx.addIssue({ code: "custom", message: "Exclusions and escrows must use distinct economic balance identities" });
  if ((plan.accountingFamily === "independent-liability" && plan.escrows.length > 0) ||
    (plan.accountingFamily !== "independent-liability" && plan.escrows.length === 0)) ctx.addIssue({ code: "custom", message: "Accounting family must match its reviewed escrow rules" });
  if (plan.referencePriceSource !== null && plan.referencePriceSource.sourceId !== plan.sourceId) ctx.addIssue({ code: "custom", message: "Reference source identity differs from reviewed source binding" });
  for (const escrow of plan.escrows) {
    const subsetKeys = escrow.receiptClaimSources.map(row => row.deploymentKey);
    if (new Set(subsetKeys).size !== subsetKeys.length || subsetKeys.some(key => !escrow.receiptDeploymentKeys.includes(key))) ctx.addIssue({ code: "custom", message: "Receipt subset observations require unique exact receipt identities" });
    if (escrow.inFlightSource !== null && "kind" in escrow.inFlightSource) {
      const canonical = plan.deployments.find(row => row.deploymentKey === escrow.canonicalDeploymentKey);
      if (!canonical || canonical.chainId !== escrow.inFlightSource.chainId ||
        canonical.amountBasis !== "fixed-token-units" ||
        (canonical.read.kind !== "evm-total-supply" && canonical.read.kind !== "evm-balance")) {
        ctx.addIssue({ code: "custom", message: "On-chain pending state must share the canonical escrow's pinned EVM token-unit generation" });
      }
    }
  }
  if (plan.inFlightTreatment === "atomic-native-wrapper" &&
    (plan.accountingFamily !== "native-wrapped" || plan.escrows.length === 0 || plan.liabilityInFlightSource !== null ||
      !plan.deployments.some(row => row.holdingKind === "native-gas") ||
      plan.escrows.some(escrow => escrow.inFlightSource !== null))) ctx.addIssue({ code: "custom", message: "Atomic in-flight proof applies only to a reviewed native-wrapper accounting scope" });
  if (plan.inFlightTreatment === "observed-reconciled" && plan.escrows.some(escrow => escrow.inFlightSource === null)) ctx.addIssue({ code: "custom", message: "Asynchronous escrow accounting requires an observed pending source" });
  if (plan.expiresAtSec <= plan.reviewedAtSec || plan.expiresAtSec - plan.reviewedAtSec > vocabulary.reviewMaxAgeDays * 86400) ctx.addIssue({ code: "custom", message: "Explicit expiry exceeds review budget" });
  if (plan.deployments.some(row => row.claimUnit !== plan.commonClaimUnit && row.conversionSourceId === null)) ctx.addIssue({ code: "custom", message: "Distinct claim units require sourced conversion" });
  if (new Set(plan.conversionSources.map(row => row.sourceId)).size !== plan.conversionSources.length || plan.deployments.some(row => row.conversionSourceId !== null && !plan.conversionSources.some(source => source.sourceId === row.conversionSourceId))) ctx.addIssue({ code: "custom", message: "Conversion source must bind an exact reviewed API read" });
  if (plan.escrows.some(row => !keys.includes(row.canonicalDeploymentKey) || row.receiptDeploymentKeys.some(key => !keys.includes(key) || key === row.canonicalDeploymentKey)) || plan.exclusions.some(row => !keys.includes(row.deploymentKey))) ctx.addIssue({ code: "custom", message: "Accounting rule references an unknown holding" });
});
/** Attribution only: this proof never changes a provider observation or liability census. */
export const ReviewedProviderRowExclusionSchema = z.strictObject({
  assetId: CanonicalTextSchema, providerChainLabel: CanonicalTextSchema,
  belongsToAssetId: CanonicalTextSchema, chainId: CanonicalChainIdSchema, contractAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  reviewer: CanonicalTextSchema, reviewedAtSec: UnixSecondsSchema, expiresAtSec: UnixSecondsSchema,
  evidenceUrls: z.array(z.string().url().refine(url => url.startsWith("https://"))).min(1), rationale: CanonicalTextSchema,
  provenance: z.strictObject({
    provider: z.literal("defillama"), providerAssetId: CanonicalTextSchema,
    adapterSourceUrl: z.string().url().regex(/^https:\/\/raw\.githubusercontent\.com\/DefiLlama\/peggedassets-server\/[0-9a-f]{40}\/src\/adapters\/peggedAssets\/[^?#]+$/),
    blockNumber: z.number().int().positive(), blockHash: z.string().regex(/^0x[0-9a-f]{64}$/), observedAtSec: UnixSecondsSchema,
    rpcUrl: z.string().url().refine(url => url.startsWith("https://")),
    remoteChainId: CanonicalChainIdSchema, remoteTokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  }),
}).superRefine((review, ctx) => {
  if (review.assetId === review.belongsToAssetId) ctx.addIssue({ code: "custom", message: "Excluded row must belong to a distinct asset" });
  if (review.expiresAtSec <= review.reviewedAtSec || review.expiresAtSec - review.reviewedAtSec > vocabulary.reviewMaxAgeDays * 86400 ||
    review.provenance.observedAtSec > review.reviewedAtSec) ctx.addIssue({ code: "custom", message: "Provider-row proof exceeds its reviewed research window" });
});
export const AdmittedProviderRowExclusionSchema = z.strictObject({
  review: ReviewedProviderRowExclusionSchema, deploymentRouteKey: CanonicalTextSchema,
  supplyShare: z.number().finite().min(0).max(1),
});
const CuratedNativeSingleRouteReviewSchema = z.strictObject({
  assetId: CanonicalTextSchema, routeId: CanonicalTextSchema, reviewer: CanonicalTextSchema,
  reviewedAt: StrictIsoDateSchema, rationale: CanonicalTextSchema,
});
export type CuratedNativeSingleRouteSupplyAttribution = z.infer<typeof CuratedNativeSingleRouteReviewSchema>;
export const ReviewedEconomicSupplyPlanFileSchema = uniqueKeyedCollectionSchema({ itemSchema: ReviewedEconomicSupplyPlanSchema, collectionKey: "reviews", duplicateMessage: "Duplicate economic supply plan", noteSchema: CanonicalTextSchema }).extend({
  nativeSingleRouteReviews: z.array(CuratedNativeSingleRouteReviewSchema).superRefine((rows, ctx) => {
    if (new Set(rows.map(row => row.assetId)).size !== rows.length) ctx.addIssue({ code: "custom", message: "Duplicate native single-route review" });
  }),
  independentLiabilityAssetIds: z.array(CanonicalTextSchema).superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate independent-liability eligibility" });
  }),
  // Validate attributed envelopes here; malformed evidence is ignored per asset by the consumer.
  providerRowExclusionReviews: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()).superRefine((rows, ctx) => {
    const keys = rows.map(row => `${row.assetId}:${String(row.providerChainLabel)}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate provider-row exclusion review" });
  }).optional(),
});
/** Global attribution is strict; score-bearing plan evidence is asset-local (R8). */
export const ReviewedEconomicSupplyPlanEnvelopeSchema = ReviewedEconomicSupplyPlanFileSchema.omit({ reviews: true }).extend({
  reviews: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()),
});
export type ReviewedEconomicSupplyPlan = z.infer<typeof ReviewedEconomicSupplyPlanSchema>;
const EconomicSupplyObservationSchema = z.strictObject({
  id: CanonicalTextSchema, deploymentKey: CanonicalTextSchema, amount: DecimalSchema,
  observedAtSec: UnixSecondsSchema, anchor: CanonicalTextSchema, anchorHash: CanonicalTextSchema, responseSha256: Sha256Schema,
});
// eslint-disable-next-line security/detect-unsafe-regex -- anchored linear unsigned-decimal shape; groups cannot overlap.
const EconomicSupplyReferenceSchema = z.strictObject({ sourceId: CanonicalTextSchema, sourceGeneration: CanonicalTextSchema, observedAtSec: UnixSecondsSchema, value: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).refine(value => Number(value) > 0 && Number.isFinite(Number(value))), responseSha256: Sha256Schema });
export const ReviewedEconomicDeploymentPartitionSchema = z.strictObject({
  model: z.literal(REVIEWED_ECONOMIC_SUPPLY_MODEL), assetId: CanonicalTextSchema,
  baseInputGenerationId: BaseInputGenerationIdSchema, sourceGeneration: CanonicalTextSchema, registryFingerprint: Sha256Schema,
  scoringClockSec: UnixSecondsSchema, observedAtSec: UnixSecondsSchema, captureStartedAtSec: UnixSecondsSchema, captureEndedAtSec: UnixSecondsSchema,
  planDigest: Sha256Schema, routeInventoryDigest: Sha256Schema,
  aggregate: z.strictObject({ sourceGeneration: CanonicalTextSchema, observedAtSec: UnixSecondsSchema, supplyUsd: NonNegativeFiniteSchema }),
  referencePrice: EconomicSupplyReferenceSchema, conversions: z.array(EconomicSupplyReferenceSchema).max(64),
  observations: z.array(EconomicSupplyObservationSchema).min(1).max(256),
  inFlight: z.array(EconomicSupplyObservationSchema).max(64),
  deployments: z.array(z.strictObject({ deploymentKey: CanonicalTextSchema, chainId: CanonicalChainIdSchema, routeId: CanonicalTextSchema.nullable(), holdingKind: EconomicSupplyHoldingKindSchema, currentSupplyUsd: NonNegativeFiniteSchema })).min(1).max(64),
  unattributedSupplyUsd: NonNegativeFiniteSchema, quantitativeCompleteness: z.boolean(),
});
export type ReviewedEconomicDeploymentPartition = z.infer<typeof ReviewedEconomicDeploymentPartitionSchema>;
export type EconomicSupplyObservation = z.infer<typeof EconomicSupplyObservationSchema>;
export type EconomicSupplyReference = z.infer<typeof EconomicSupplyReferenceSchema>;
