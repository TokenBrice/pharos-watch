import { z } from "zod";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
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
} from "./compliance-vocabulary";
import { StablecoinLinkSchema } from "./stablecoin-meta-primitives";

export const ComplianceApiRegimeGeniusSchema = z.object({
  publicLawDate: z.string(),
  finalRulesIssuedAt: z.string().nullable(),
  statutoryFallbackEffectiveDate: z.string(),
  effectiveDate: z.string(),
  rulemakingPhase: z.enum(["pre-rulemaking", "proposed-rules", "final-rules-issued", "effective"]),
  isEffective: z.boolean(),
  sourceLabel: z.string(),
  sourceUrl: z.string(),
  reviewedAt: z.string(),
});

export const ComplianceApiMicaSchema = z.object({
  status: z.enum(MICA_STATUS_VALUES),
  tokenType: z.enum(MICA_TOKEN_TYPE_VALUES).nullable(),
  authorizationType: z.enum(MICA_AUTHORIZATION_TYPE_VALUES).nullable(),
  competentAuthority: z.string().nullable(),
  authorizedEntity: z.string().nullable(),
  significant: z.boolean().nullable(),
  references: z.array(StablecoinLinkSchema),
});

const ComplianceApiGeniusReferenceSchema = z.object({
  label: z.string(),
  url: z.string(),
  sourceKind: z.enum(GENIUS_SOURCE_KIND_VALUES),
  sourceDate: z.string().optional(),
  accessedAt: z.string().optional(),
});

export const ComplianceApiGeniusSchema = z.object({
  applicability: z.enum(GENIUS_APPLICABILITY_VALUES),
  authorizationStatus: z.enum(GENIUS_AUTHORIZATION_STATUS_VALUES),
  issuerPathway: z.enum(GENIUS_ISSUER_PATHWAY_VALUES),
  issuerEntity: z.string().nullable(),
  issuerDomicile: z.string().nullable(),
  licensingRegulator: z.string().nullable(),
  primaryFederalRegulator: z.enum(GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES).nullable(),
  stateRegulator: z.string().nullable(),
  foreignExceptionStatus: z.enum(GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES).nullable(),
  enforcementStatus: z.enum(GENIUS_ENFORCEMENT_STATUS_VALUES).nullable(),
  daspOfferSaleStatus: z.enum(GENIUS_DASP_OFFER_SALE_STATUS_VALUES).nullable(),
  reserveDisclosurePresent: z.boolean().nullable(),
  reserveDisclosureUrl: z.string().nullable(),
  redemptionPolicyPresent: z.boolean().nullable(),
  monthlyAttestationPresent: z.boolean().nullable(),
  notes: z.string().nullable(),
  references: z.array(ComplianceApiGeniusReferenceSchema),
  reviewer: z.string(),
  reviewedAt: z.string(),
});

export const ComplianceUnavailableReasonSchema = z.enum(["not-reviewed"]);

export const ComplianceApiRowSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  status: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  backing: z.string().nullable(),
  navToken: z.boolean(),
  yieldBearing: z.boolean(),
  mica: ComplianceApiMicaSchema.nullable(),
  micaUnavailableReason: ComplianceUnavailableReasonSchema.nullable(),
  genius: ComplianceApiGeniusSchema.nullable(),
  geniusUnavailableReason: ComplianceUnavailableReasonSchema.nullable(),
});
export type ComplianceApiRow = z.infer<typeof ComplianceApiRowSchema>;

export const ComplianceRegimesEnvelopeSchema = z.object({
  genius: ComplianceApiRegimeGeniusSchema,
});

export const ComplianceListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  regimes: ComplianceRegimesEnvelopeSchema,
  summary: z.object({
    totalCoins: z.number().int().nonnegative(),
    assessedCoins: z.number().int().nonnegative(),
    unassessedCoins: z.number().int().nonnegative(),
    micaAssessed: z.number().int().nonnegative(),
    geniusAssessed: z.number().int().nonnegative(),
  }),
  coins: z.array(ComplianceApiRowSchema),
  _meta: ApiMetaEnvelopeSchema,
});
export type ComplianceListResponse = z.infer<typeof ComplianceListResponseSchema>;

export const ComplianceCoinResponseSchema = z.object({
  schemaVersion: z.literal(1),
  regimes: ComplianceRegimesEnvelopeSchema,
  coin: ComplianceApiRowSchema,
  _meta: ApiMetaEnvelopeSchema,
});
export type ComplianceCoinResponse = z.infer<typeof ComplianceCoinResponseSchema>;
