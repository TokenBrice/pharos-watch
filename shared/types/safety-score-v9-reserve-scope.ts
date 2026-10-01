import { z } from "zod";
import candidatePolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { isWellFormedDeploymentId } from "../lib/deployment-id";
import { sha256Hex } from "../lib/sha256";
import { stableJsonStringifyV1 } from "../lib/stable-json";
import { CanonicalTextSchema, FractionSchema, NonNegativeFiniteSchema, Sha256Schema, StrictIsoDateSchema, UnixSecondsSchema, BaseInputGenerationIdSchema } from "./safety-schema-primitives";

const vocabulary = candidatePolicy.semantic.backing.reserveScope;
const policyEnum = (values: string[]) => z.enum(values as [string, ...string[]]);
export const ReserveScopeRejectionSchema = policyEnum(vocabulary.admissionRejectionCodes);
export const ReserveScopePolicySchema = z.strictObject({
  crossChainObservationMaxSkewSec: UnixSecondsSchema, maxFutureSkewSec: z.literal(0),
  financialMethodQuality: z.record(z.string(), z.enum(["strong", "adequate"])),
  observationKinds: z.array(policyEnum(vocabulary.observationKinds)),
  liabilityExclusionKinds: z.array(policyEnum(vocabulary.liabilityExclusionKinds)),
  admissionRejectionCodes: z.array(ReserveScopeRejectionSchema),
  standingEvidenceClass: z.literal("static-validated"), unknownResidualTreatment: z.literal("bounded-unknown"),
});
export const ReserveDeploymentRefSchema = CanonicalTextSchema.refine(isWellFormedDeploymentId, "Expected normalized economic deployment key");
// B4 economic deployment identity is also the authority for native-gas keys.
export const ReserveNativeLiabilityRefSchema = ReserveDeploymentRefSchema.refine(value => value.includes(":native:"), "Expected B4 native economic deployment key");
// eslint-disable-next-line security/detect-unsafe-regex -- capped anchored unsigned decimal.
export const ReserveExactDecimalSchema = z.string().max(128).regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
const SourceSchema = z.strictObject({ url: z.string().url(), accessedAtSec: UnixSecondsSchema, sha256: Sha256Schema });
const IdentitySchema = z.strictObject({ deploymentRef: ReserveDeploymentRefSchema, bookKey: CanonicalTextSchema, account: CanonicalTextSchema.nullable() });
export const ReserveLiabilityExclusionSchema = z.strictObject({
  id: CanonicalTextSchema, identity: IdentitySchema, kind: policyEnum(vocabulary.liabilityExclusionKinds),
  reason: CanonicalTextSchema, amount: ReserveExactDecimalSchema.nullable(), currency: CanonicalTextSchema,
  unitBasis: CanonicalTextSchema, asOfSec: UnixSecondsSchema, source: SourceSchema, economicallyOwed: z.boolean().nullable(),
});
const DenominatorRowSchema = z.strictObject({ identity: IdentitySchema, amount: ReserveExactDecimalSchema, evidenceRefIds: z.array(CanonicalTextSchema).min(1) });
export const ReserveLiabilityDenominatorSchema = z.strictObject({
  periodEnd: StrictIsoDateSchema, asOfSec: UnixSecondsSchema, currency: CanonicalTextSchema,
  unitBasis: CanonicalTextSchema, decimals: z.number().int().min(0).max(36).nullable(),
  totalCoveredLiabilities: ReserveExactDecimalSchema, included: z.array(DenominatorRowSchema).min(1),
  excluded: z.array(CanonicalTextSchema), completeness: z.enum(["complete", "partial", "unknown"]),
  evidenceRefIds: z.array(CanonicalTextSchema).min(1), sourceSha256: Sha256Schema,
});
export const ReserveReportCoverageSchema = z.strictObject({
  scopeId: CanonicalTextSchema, liabilityBookKey: CanonicalTextSchema,
  deploymentRefs: z.array(ReserveDeploymentRefSchema).min(1), nativeLiabilityRef: ReserveNativeLiabilityRefSchema.optional(),
  liabilityExclusions: z.array(ReserveLiabilityExclusionSchema), denominator: ReserveLiabilityDenominatorSchema,
  reconciliationWithinScope: z.enum(["full", "partial", "none", "unknown"]),
  assetsAsOfSec: UnixSecondsSchema, reviewedAtSec: UnixSecondsSchema, confidence: z.enum(["verified", "unknown"]),
  // Exact within-deployment joins supplement, never replace, the admitted B4 partition.
  currentBookPartition: z.strictObject({ baseInputGenerationId: BaseInputGenerationIdSchema, sourceGeneration: CanonicalTextSchema,
    observedAtSec: UnixSecondsSchema, completeness: z.literal("complete"), evidenceRefIds: z.array(CanonicalTextSchema).min(1),
    books: z.array(z.strictObject({ deploymentRef: ReserveDeploymentRefSchema, bookKey: CanonicalTextSchema,
      currentLiabilityUsd: NonNegativeFiniteSchema, exclusions: z.array(z.strictObject({ id: CanonicalTextSchema, currentAmountUsd: NonNegativeFiniteSchema })) })).min(1),
  }).optional(),
}).superRefine((scope, ctx) => {
  const ids = scope.liabilityExclusions.map(row => row.id);
  if (new Set(scope.deploymentRefs).size !== scope.deploymentRefs.length || new Set(ids).size !== ids.length || scope.denominator.excluded.some(id => !ids.includes(id)) || ids.some(id => !scope.denominator.excluded.includes(id))) ctx.addIssue({ code: "custom", message: "Scope identities/exclusions must join exactly and uniquely" });
  if (scope.denominator.included.some(row => row.identity.bookKey !== scope.liabilityBookKey || !scope.deploymentRefs.includes(row.identity.deploymentRef))) ctx.addIssue({ code: "custom", message: "Denominator must join the exact covered book and deployment" });
});
const ObservationBase = {
  scopeId: CanonicalTextSchema, liabilityBookKey: CanonicalTextSchema, deploymentRefs: z.array(ReserveDeploymentRefSchema),
  reviewer: CanonicalTextSchema, confidence: z.enum(["verified", "unknown"]), sources: z.array(SourceSchema).min(1),
  reviewedAtSec: UnixSecondsSchema, expiresAtSec: UnixSecondsSchema, sourceGeneration: CanonicalTextSchema, sourceSha256: Sha256Schema,
  completeness: z.enum(["complete", "partial", "unknown"]),
  obligations: z.array(z.strictObject({ key: CanonicalTextSchema, disposition: z.enum(["included", "omitted", "unresolved"]), reason: CanonicalTextSchema })),
};
export const ReserveObservationEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...ObservationBase, kind: z.literal("standing-structure"), observedAtSec: z.null(), wholeHolderClaim: z.boolean(), instrumentKey: CanonicalTextSchema }),
  z.strictObject({ ...ObservationBase, kind: z.literal("portfolio-observation"), observedAtSec: UnixSecondsSchema,
    wholeAssetDenominator: z.strictObject({ amount: ReserveExactDecimalSchema, asOfSec: UnixSecondsSchema, unitBasis: CanonicalTextSchema, sourceSha256: Sha256Schema }).nullable() }),
  z.strictObject({ ...ObservationBase, kind: z.literal("onchain-observation"), observedAtSec: UnixSecondsSchema,
    blocks: z.array(z.strictObject({ chain: CanonicalTextSchema, number: UnixSecondsSchema, hash: z.string().regex(/^0x[0-9a-f]{64}$/), timestamp: UnixSecondsSchema, finality: z.enum(["safe", "finalized"]) })).min(1),
    quantities: z.array(z.strictObject({ key: CanonicalTextSchema, deploymentRef: ReserveDeploymentRefSchema, selector: CanonicalTextSchema, rawAmount: ReserveExactDecimalSchema, decimals: z.number().int().min(0).max(36) })).min(1),
    ratio: z.strictObject({ numerator: ReserveExactDecimalSchema, denominator: ReserveExactDecimalSchema, unitBasis: CanonicalTextSchema }).nullable(),
  }),
]).superRefine((row, ctx) => {
  if (row.expiresAtSec <= row.reviewedAtSec || (row.observedAtSec !== null && row.observedAtSec > row.reviewedAtSec) ||
    row.sources.some(source => source.accessedAtSec > row.reviewedAtSec) ||
    new Set(row.deploymentRefs).size !== row.deploymentRefs.length ||
    new Set(row.obligations.map(obligation => obligation.key)).size !== row.obligations.length) {
    ctx.addIssue({ code: "custom", message: "Observation chronology and exact identities must be consistent" });
  }
});
export const ReserveScopedAdmissionSchema = z.strictObject({
  kind: z.enum(["financial-report", ...vocabulary.observationKinds] as [string, ...string[]]), scopeId: CanonicalTextSchema,
  liabilityBookKey: CanonicalTextSchema, deploymentRefs: z.array(ReserveDeploymentRefSchema), admitted: z.boolean(),
  rejectionCodes: z.array(ReserveScopeRejectionSchema), currentLiabilityShare: FractionSchema.nullable(),
  wholeAssetComposition: z.boolean(), observedAtSec: UnixSecondsSchema.nullable(), evidenceRefIds: z.array(CanonicalTextSchema),
});
export const ReserveBoundedFactsGenerationSchema = z.strictObject({
  sourceGenerationId: CanonicalTextSchema, observedAtSec: UnixSecondsSchema, maxAgeSec: z.number().int().positive(),
});
export const LiveReserveSnapshotProvenanceSchema = z.preprocess((value) => {
  if (value == null || typeof value !== "object" || !("reserveObservation" in value) || value.reserveObservation === undefined) return value;
  if (ReserveObservationEnvelopeSchema.safeParse(value.reserveObservation).success) return value;
  return { ...value, reserveObservation: undefined, reserveObservationFailure: {
    code: "producer-failed", reason: "malformed-reserve-observation",
    sourceSha256: sha256Hex(stableJsonStringifyV1(value.reserveObservation)),
  } };
}, z.strictObject({
  source: CanonicalTextSchema, fetchedAt: UnixSecondsSchema, balanceSheetScope: z.literal("shared-sky-maker").optional(),
  sharedBookAssetIds: z.array(CanonicalTextSchema).optional(), sharedBookMeasuredHoldings: z.record(z.string(), NonNegativeFiniteSchema).optional(),
  reserveObservation: ReserveObservationEnvelopeSchema.optional(),
  boundedFactsGeneration: ReserveBoundedFactsGenerationSchema.optional(),
  reserveObservationFailure: z.strictObject({
    code: z.literal("producer-failed"), reason: z.literal("malformed-reserve-observation"), sourceSha256: Sha256Schema,
  }).optional(),
}));
export type ReserveReportCoverage = z.output<typeof ReserveReportCoverageSchema>;
export type ReserveObservationEnvelope = z.output<typeof ReserveObservationEnvelopeSchema>;
export type ReserveScopedAdmission = z.output<typeof ReserveScopedAdmissionSchema>;
export type LiveReserveSnapshotProvenance = z.output<typeof LiveReserveSnapshotProvenanceSchema>;
