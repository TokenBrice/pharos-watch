import { z } from "zod";
import {
  GENIUS_APPLICABILITY_VALUES,
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  GENIUS_DASP_OFFER_SALE_STATUS_VALUES,
  GENIUS_ENFORCEMENT_STATUS_VALUES,
  GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES,
  GENIUS_ISSUER_PATHWAY_VALUES,
  GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES,
  GENIUS_SOURCE_KIND_VALUES,
  MICA_AUTHORIZATION_TYPE_VALUES,
  MICA_STATUS_VALUES,
  MICA_TOKEN_TYPE_VALUES,
} from "./core";
import { HttpUrlSchema } from "./validators";
import {
  BlacklistabilityReviewStatusSchema,
  ReviewDateSchema,
  StablecoinLinkSchema,
} from "./stablecoin-meta-schemas";

export const BlacklistabilityReviewSchema = z
  .object({
    reviewedStatus: BlacklistabilityReviewStatusSchema,
    sources: z.array(StablecoinLinkSchema).min(1).optional(),
    sourceFreeRationale: z.string().min(1).optional(),
    evidence: z.string().min(12),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
  })
  .strict()
  .superRefine((review, ctx) => {
    if ((review.sources?.length ?? 0) > 0 || review.sourceFreeRationale) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "blacklistabilityReview requires sources or sourceFreeRationale",
      path: ["sources"],
    });
  });

export const JurisdictionSchema = z
  .object({
    country: z.string(),
    regulator: z.string().optional(),
    license: z.string().optional(),
  })
  .strict();

export const MicaProfileSchema = z
  .object({
    status: z.enum(MICA_STATUS_VALUES),
    tokenType: z.enum(MICA_TOKEN_TYPE_VALUES).optional(),
    authorizationType: z.enum(MICA_AUTHORIZATION_TYPE_VALUES).optional(),
    competentAuthority: z.string().min(1).optional(),
    authorizedEntity: z.string().min(1).optional(),
    significant: z.boolean().optional(),
    references: z.array(StablecoinLinkSchema).optional(),
  })
  .strict()
  .superRefine((mica, ctx) => {
    if (mica.status === "out-of-scope") {
      for (const field of ["tokenType", "authorizationType", "competentAuthority", "authorizedEntity"] as const) {
        if (mica[field] != null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "mica.out-of-scope rows cannot carry in-scope classification fields",
            path: [field],
          });
        }
      }
    }

    if (mica.status !== "out-of-scope" && (mica.references?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mica.status requires at least one source reference unless it is 'out-of-scope'",
        path: ["references"],
      });
    }
  });

const GENIUS_REGULATOR_SOURCE_KINDS = new Set(["federal-register", "federal-regulator", "state-regulator"]);
const GENIUS_FEDERAL_SOURCE_KINDS = new Set(["federal-register", "federal-regulator"]);

const GeniusReferenceSchema = z
  .object({
    label: z.string().min(1),
    url: HttpUrlSchema,
    sourceKind: z.enum(GENIUS_SOURCE_KIND_VALUES),
    sourceDate: ReviewDateSchema.optional(),
    accessedAt: ReviewDateSchema.optional(),
    /** Verbatim external title; see `StablecoinLinkSchema.quoted`. */
    quoted: z.boolean().optional(),
  })
  .strict();
export type GeniusReference = z.output<typeof GeniusReferenceSchema>;

function hasGeniusReferenceKind(
  references: readonly GeniusReference[] | undefined,
  sourceKinds: ReadonlySet<string>,
): boolean {
  return references?.some((reference) => sourceKinds.has(reference.sourceKind)) ?? false;
}

const GeniusApplicabilityBasisSchema = z
  .object({
    summary: z.string().min(12),
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

const GeniusForeignExceptionEvidenceSchema = z
  .object({
    summary: z.string().min(12),
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

const GeniusNegativeEvidenceReviewSchema = z
  .object({
    sourcesChecked: z.array(z.string().min(1)).min(1),
    summary: z.string().min(12),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
    references: z.array(GeniusReferenceSchema).optional(),
  })
  .strict();

export const GeniusProfileSchema = z
  .object({
    applicability: z.enum(GENIUS_APPLICABILITY_VALUES),
    applicabilityBasis: GeniusApplicabilityBasisSchema.optional(),
    authorizationStatus: z.enum(GENIUS_AUTHORIZATION_STATUS_VALUES),
    issuerPathway: z.enum(GENIUS_ISSUER_PATHWAY_VALUES),
    issuerEntity: z.string().min(1).optional(),
    issuerDomicile: z.string().min(1).optional(),
    licensingRegulator: z.string().min(1).optional(),
    primaryFederalRegulator: z.enum(GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES).optional(),
    stateRegulator: z.string().min(1).optional(),
    foreignExceptionStatus: z.enum(GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES).optional(),
    foreignExceptionEvidence: GeniusForeignExceptionEvidenceSchema.optional(),
    enforcementStatus: z.enum(GENIUS_ENFORCEMENT_STATUS_VALUES).optional(),
    daspOfferSaleStatus: z.enum(GENIUS_DASP_OFFER_SALE_STATUS_VALUES).optional(),
    reserveDisclosurePresent: z.boolean().optional(),
    reserveDisclosureUrl: HttpUrlSchema.optional(),
    redemptionPolicyPresent: z.boolean().optional(),
    monthlyAttestationPresent: z.boolean().optional(),
    latestReportDate: ReviewDateSchema.optional(),
    notes: z.string().min(1).optional(),
    references: z.array(GeniusReferenceSchema).optional(),
    negativeEvidenceReview: GeniusNegativeEvidenceReviewSchema.optional(),
    reviewer: z.string().min(1),
    reviewedAt: ReviewDateSchema,
  })
  .strict()
  .superRefine((genius, ctx) => {
    if (
      (genius.authorizationStatus === "ppsi-approved" ||
        genius.authorizationStatus === "state-qualified" ||
        genius.authorizationStatus === "official-application-pending") &&
      !hasGeniusReferenceKind(genius.references, GENIUS_REGULATOR_SOURCE_KINDS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS official authorization statuses require a federal, state, or Federal Register reference",
        path: ["references"],
      });
    }

    if (
      genius.authorizationStatus === "issuer-announced-intent" &&
      !hasGeniusReferenceKind(
        genius.references,
        new Set(["issuer-disclosure", "issuer-filing", ...GENIUS_REGULATOR_SOURCE_KINDS]),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS issuer-announced-intent requires an issuer, regulator, or filing reference",
        path: ["references"],
      });
    }

    if (genius.authorizationStatus === "no-public-authorization-found" && genius.negativeEvidenceReview == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS no-public-authorization-found requires a negative evidence review",
        path: ["negativeEvidenceReview"],
      });
    }

    if (genius.reserveDisclosurePresent === true && !genius.reserveDisclosureUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS reserve disclosure presence requires a reserve disclosure URL",
        path: ["reserveDisclosureUrl"],
      });
    }

    if (
      genius.foreignExceptionStatus === "registered-exception" &&
      (genius.foreignExceptionEvidence == null ||
        !hasGeniusReferenceKind(genius.foreignExceptionEvidence.references, GENIUS_FEDERAL_SOURCE_KINDS))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "GENIUS registered foreign exception requires evidence with a federal regulator or Federal Register reference",
        path: ["foreignExceptionEvidence"],
      });
    }

    if (
      (genius.enforcementStatus === "warning-or-notice" || genius.enforcementStatus === "prohibited-or-revoked") &&
      !hasGeniusReferenceKind(genius.references, GENIUS_REGULATOR_SOURCE_KINDS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GENIUS enforcement actions require a federal, state, or Federal Register reference",
        path: ["references"],
      });
    }
  });

export type BlacklistabilityReview = z.output<typeof BlacklistabilityReviewSchema>;
export type Jurisdiction = z.output<typeof JurisdictionSchema>;
export type MicaProfile = z.output<typeof MicaProfileSchema>;
export type GeniusApplicabilityBasis = z.output<typeof GeniusApplicabilityBasisSchema>;
export type GeniusForeignExceptionEvidence = z.output<typeof GeniusForeignExceptionEvidenceSchema>;
export type GeniusNegativeEvidenceReview = z.output<typeof GeniusNegativeEvidenceReviewSchema>;
export type GeniusProfile = z.output<typeof GeniusProfileSchema>;
