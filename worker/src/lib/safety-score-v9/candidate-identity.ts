import { z } from "zod";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./consumer-freshness";

const SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN = "safety-score-v9.compiler-fact-schema.v1";
const SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN = "safety-score-v9.producer-capability-build.v1";
const SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN = "safety-score-v9.publication-id.v1";

export const ReleaseCandidateIdSchema = z.string().regex(/^v9-rc-[1-9][0-9]*$/);
const CanonicalStringArraySchema = z.array(z.string().min(1)).superRefine((values, ctx) => {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && values[index - 1]! >= value)
  ) {
    ctx.addIssue({ code: "custom", message: "Values must be unique and sorted" });
  }
});

export const SafetyScoreV9CompilerFactSchemaIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    // 3 = retained exact fixed input (frozen-capture replay); 4 = native V9
    // capture. The digest is unchanged for a v3 input, so historical replays
    // keep their candidate identity byte-for-byte.
    fixedInputSchemaVersion: z.union([z.literal(3), z.literal(4)]),
    factExtensionSchemaVersion: z.literal(3),
    compiledFactSchemaVersion: z.literal(4),
    compiledFactSchemaCapabilities: z.tuple([
      z.literal("canonical-chain-supply-distribution.v1"),
      z.literal("canonical-lock-mint-supply-attribution.v1"),
      z.literal("exit-route-modeled-confidence.v1"),
      z.literal("fact-gap-cause-proofs.v1"),
      z.literal("governed-issuance.v1"),
      z.literal("journaled-cdp-shock-coverage.v1"),
      z.literal("morpho-lender-collateral-book.v1"),
      z.literal("reviewed-deployment-unit-supply-attribution.v1"),
      z.literal("reviewed-transfer-deployments.v1"),
      z.literal("wrapper-local-facts.v1"),
    ]),
    compilerAdapter: z.literal("exact-fixed-input-to-v9-facts.v3"),
    evaluationBuildDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreV9CompilerFactSchemaIdentityV1 = z.infer<typeof SafetyScoreV9CompilerFactSchemaIdentityV1Schema>;

export const SafetyScoreV9ProducerCapabilityIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    inputContractVersions: z
      .object({
        fixedInput: z.union([z.literal(3), z.literal(4)]),
        factExtension: z.literal(3),
      })
      .strict(),
    sourceAdapters: z
      .object({
        registry: z.literal("fixed-input.registry.v1"),
        dexExitRoutes: z.literal("fixed-input.dex-exit-observations.v2"),
        redemptionExitRoutes: z.literal("fixed-input.redemption-exit-observations.v2"),
        liveReserves: z.literal("fixed-input.live-reserves.v1"),
        chainSupply: z.literal("fixed-input.usd-circulating-supply.v4"),
        peg: z.literal("fixed-input.peg-summary.v1"),
        researchOverlays: z.literal("v9-fact-extension.review-overlays.v4"),
        shockCoverage: z.literal("journal-registry.cdp-shock-coverage.v1"),
        lenderBook: z.literal("fixed-input.morpho-lender-book.v1"),
        lenderCollateralBacking: z.literal("fixed-input.previous-accepted-backing.v1"),
      })
      .strict(),
    scoreBearingMethodologyVersions: z
      .object({
        dexExitRoutes: CanonicalStringArraySchema,
        redemptionExitRoutes: CanonicalStringArraySchema,
        peg: CanonicalStringArraySchema,
      })
      .strict(),
    dexRouteCapabilityMatrixVersions: CanonicalStringArraySchema,
    freshnessPolicySec: z
      .object({
        dexExitRoutes: z.number().int().nonnegative(),
        redemptionExitRoutes: z.number().int().nonnegative(),
        documentedTermsExitRoutes: z.number().int().nonnegative(),
        accessReviews: z.literal(V9_ACCESS_EVIDENCE_MAX_AGE_SEC),
        liveReserves: z.number().int().nonnegative().nullable(),
        lenderBook: z.literal(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook.observationMaxAgeSec),
        lenderCollateralBacking: z.literal(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC),
        chainSupply: z.number().int().nonnegative().nullable(),
        peg: z.number().int().nonnegative().nullable(),
        researchOverlays: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type SafetyScoreV9ProducerCapabilityIdentityV1 = z.infer<typeof SafetyScoreV9ProducerCapabilityIdentityV1Schema>;

export const SafetyScoreV9CandidateIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    policyId: z.string().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreV9CandidateIdentityV1 = z.infer<typeof SafetyScoreV9CandidateIdentityV1Schema>;

/** Hash admitted identity bytes without applying today's version pins. */
export function hashSafetyScoreV9CompilerFactSchemaIdentity(identity: unknown): string {
  return domainDigest(SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN, identity);
}

export function hashSafetyScoreV9ProducerCapabilityIdentity(identity: unknown): string {
  return domainDigest(SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN, identity);
}

export function computeSafetyScoreV9CompilerFactSchemaDigest(
  identityValue: SafetyScoreV9CompilerFactSchemaIdentityV1,
): string {
  const identity = SafetyScoreV9CompilerFactSchemaIdentityV1Schema.parse(identityValue);
  return hashSafetyScoreV9CompilerFactSchemaIdentity(identity);
}

export function computeSafetyScoreV9ProducerCapabilityDigest(
  identityValue: SafetyScoreV9ProducerCapabilityIdentityV1,
): string {
  const identity = SafetyScoreV9ProducerCapabilityIdentityV1Schema.parse(identityValue);
  return hashSafetyScoreV9ProducerCapabilityIdentity(identity);
}

export function computeSafetyScoreV9CandidateId(identityValue: SafetyScoreV9CandidateIdentityV1): string {
  const identity = SafetyScoreV9CandidateIdentityV1Schema.parse(identityValue);
  return `safety-score-v9:v1:${domainDigest(SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN, identity)}`;
}

export function computeSafetyScoreV9PublicationGenerationId(identity: {
  candidateId: string;
  baseInputGenerationId: string;
  factSetDigest: string;
  evaluatedSetDigest: string;
  resultDigest: string;
  publishedAtSec: number;
}): string {
  return `report-cards:v9:v1:${domainDigest("safety-score-v9.publication.v1", identity)}`;
}
