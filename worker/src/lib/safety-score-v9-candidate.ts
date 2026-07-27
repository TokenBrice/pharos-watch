import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { evaluateValidatedV9FactSet, type V9EvaluatedSet } from "@shared/lib/safety-score-v9/evaluate-set";
import type { V9ExitHolderEligibility } from "@shared/lib/safety-score-v9/exit";
import { DEX_ROUTE_SOURCE_CAPABILITIES } from "@shared/lib/p4-exit-route-capacity";
import { assertV9ValidatedPolicyEnvelope, V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9Response } from "@shared/lib/safety-score-v9/public";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { CompiledV9FactSetV3 } from "@shared/types/safety-score-v9-facts";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { z } from "zod";
import {
  compileSafetyScoreV9FactSetFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
  type SafetyScoreV9FactSetExtensionV2,
} from "./safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "./safety-score-v9-extension";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";

const SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN = "safety-score-v9.compiler-fact-schema.v1";
const SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN = "safety-score-v9.producer-capability-build.v1";
const SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN = "safety-score-v9.publication-id.v1";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ReleaseCandidateIdSchema = z.string().regex(/^v9-rc-[1-9][0-9]*$/);
const CanonicalStringArraySchema = z.array(z.string().min(1)).superRefine((values, ctx) => {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && values[index - 1]! >= value)
  ) {
    ctx.addIssue({ code: "custom", message: "Values must be unique and sorted" });
  }
});

const SafetyScoreV9CompilerFactSchemaIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    fixedInputSchemaVersion: z.literal(3),
    factExtensionSchemaVersion: z.literal(2),
    compiledFactSchemaVersion: z.literal(3),
    compiledFactSchemaCapabilities: z.tuple([
      z.literal("canonical-chain-supply-distribution.v1"),
      z.literal("canonical-lock-mint-supply-attribution.v1"),
      z.literal("exit-route-modeled-confidence.v1"),
      z.literal("fact-gap-responsibility.v1"),
      z.literal("journaled-cdp-shock-coverage.v1"),
      z.literal("reviewed-deployment-unit-supply-attribution.v1"),
      z.literal("reviewed-transfer-deployments.v1"),
      z.literal("wrapper-local-facts.v1"),
    ]),
    compilerAdapter: z.literal("exact-fixed-input-to-v9-facts.v2"),
    evaluationBuildDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreV9CompilerFactSchemaIdentityV1 = z.infer<typeof SafetyScoreV9CompilerFactSchemaIdentityV1Schema>;

const SafetyScoreV9ProducerCapabilityIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    inputContractVersions: z
      .object({
        fixedInput: z.literal(3),
        factExtension: z.literal(2),
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
        researchOverlays: z.literal("v9-fact-extension.review-overlays.v3"),
        shockCoverage: z.literal("journal-registry.cdp-shock-coverage.v1"),
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
        chainSupply: z.number().int().nonnegative().nullable(),
        peg: z.number().int().nonnegative().nullable(),
        researchOverlays: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type SafetyScoreV9ProducerCapabilityIdentityV1 = z.infer<typeof SafetyScoreV9ProducerCapabilityIdentityV1Schema>;

const SafetyScoreV9CandidateIdentityV1Schema = z
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

export interface BuildSafetyScoreV9CandidateInput {
  fixedInput: unknown;
  publishedAtSec: number;
  extension?: unknown;
  policy?: V9ValidatedPolicyEnvelope;
  releaseCandidateId?: string;
}

export interface BuildSafetyScoreV9CandidateFromNormalizedInput extends Omit<
  BuildSafetyScoreV9CandidateInput,
  "fixedInput"
> {
  fixedInput: Readonly<ReportCardsFixedInput>;
}

export interface SafetyScoreV9CandidatePipelineResult {
  fixedInput: Readonly<ReportCardsFixedInput>;
  extension: Readonly<SafetyScoreV9FactSetExtensionV2>;
  compiledFacts: Readonly<CompiledV9FactSetV3>;
  evaluatedSet: Readonly<V9EvaluatedSet>;
  candidate: Readonly<SafetyScoreV9CurrentResponse>;
  compilerFactSchemaIdentity: Readonly<SafetyScoreV9CompilerFactSchemaIdentityV1>;
  compilerFactSchemaDigest: string;
  producerCapabilityIdentity: Readonly<SafetyScoreV9ProducerCapabilityIdentityV1>;
  producerCapabilityDigest: string;
  candidateIdentity: Readonly<SafetyScoreV9CandidateIdentityV1>;
}

export interface SafetyScoreV9PublicationResult {
  candidate: Readonly<SafetyScoreV9CurrentResponse>;
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function publicExitHolderEligibility(
  holderAccess: CompiledV9FactSetV3["assets"][number]["exitRoutes"][number]["holderAccess"],
): V9ExitHolderEligibility {
  switch (holderAccess) {
    case "permissionless":
    case "retail-open":
      return "any-holder";
    case "institutional-eligible":
      return "verified-customer";
    case "allowlisted":
      return "whitelisted-primary";
    case "issuer-only":
      return "issuer-discretionary";
    case "unknown":
      return "unknown";
  }
}

function publicDisplayMetadata(
  asset: CompiledV9FactSetV3["assets"][number],
): {
  labels: Record<string, string>;
  exitHolderEligibility: Record<string, V9ExitHolderEligibility>;
} {
  const labels: Record<string, string> = {
    mint: "Mint authority",
    oracle: "Oracle design",
    "bridge:native": "Native deployment",
    "bridge:unverified": "Unverified bridge controls",
    "reserve:concentration": "Reserve concentration",
    "reserve:unclassified-residual": "Unclassified reserve exposure",
  };
  for (const exposure of asset.reserveExposures) {
    labels[`reserve:${exposure.exposureKey}`] = exposure.name;
  }
  for (const control of asset.controls) {
    const deployment = control.deploymentKey.split(":")[0]!
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
    labels[`bridge:${control.deploymentKey}:${control.controlKey}`] =
      `${deployment || "Deployment"} bridge`;
  }
  const routeBaseLabel = (
    route: CompiledV9FactSetV3["assets"][number]["exitRoutes"][number],
  ): string => {
    if (route.lane === "dex") {
      const encodedChain = /(?:^|:)([a-z0-9-]+)%3a/i.exec(route.routeId)?.[1];
      if (encodedChain === undefined) return route.routeFamily === "dex-orderbook" ? "DEX order book" : "DEX AMM";
      const chain = encodedChain.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
      return `${chain} ${route.routeFamily === "dex-orderbook" ? "order book" : "AMM"}`;
    }
    const semanticKinds = [
      ["collateral-redeem", "Collateral redemption"],
      ["psm-swap", "PSM swap"],
      ["basket-redeem", "Basket redemption"],
      ["stablecoin-redeem", "Stablecoin redemption"],
      ["offchain-issuer", "Issuer redemption"],
      ["mint-redeem", "Mint and redemption"],
    ] as const;
    return semanticKinds.find(([token]) => route.routeId.includes(token))?.[1] ??
      (route.routeFamily === "protocol-redemption" ? "Protocol redemption" : "Issuer redemption");
  };
  const routeLabels = asset.exitRoutes
    .map((route) => ({ route, base: routeBaseLabel(route) }))
    .sort((left, right) => compareText(left.route.routeKey, right.route.routeKey));
  const labelTotals = new Map<string, number>();
  for (const { base } of routeLabels) labelTotals.set(base, (labelTotals.get(base) ?? 0) + 1);
  const labelIndexes = new Map<string, number>();
  for (const { route, base } of routeLabels) {
    const index = (labelIndexes.get(base) ?? 0) + 1;
    labelIndexes.set(base, index);
    labels[route.routeKey] = (labelTotals.get(base) ?? 0) > 1 ? `${base} ${index}` : base;
  }
  return {
    labels,
    exitHolderEligibility: Object.fromEntries(
      asset.exitRoutes.map((route) => [
        route.routeKey,
        publicExitHolderEligibility(route.holderAccess),
      ]),
    ),
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(domain: string, payload: unknown): string {
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}

function computeSafetyScoreV9CompilerFactSchemaDigest(
  identityValue: SafetyScoreV9CompilerFactSchemaIdentityV1,
): string {
  const identity = SafetyScoreV9CompilerFactSchemaIdentityV1Schema.parse(identityValue);
  return digest(SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN, identity);
}

export function computeSafetyScoreV9ProducerCapabilityDigest(
  identityValue: SafetyScoreV9ProducerCapabilityIdentityV1,
): string {
  const identity = SafetyScoreV9ProducerCapabilityIdentityV1Schema.parse(identityValue);
  return digest(SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN, identity);
}

export function computeSafetyScoreV9CandidateId(identityValue: SafetyScoreV9CandidateIdentityV1): string {
  const identity = SafetyScoreV9CandidateIdentityV1Schema.parse(identityValue);
  return `safety-score-v9:v1:${digest(SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN, identity)}`;
}

function compilerFactSchemaIdentity(
  fixedInput: ReportCardsFixedInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  compiledFacts: CompiledV9FactSetV3,
): SafetyScoreV9CompilerFactSchemaIdentityV1 {
  return SafetyScoreV9CompilerFactSchemaIdentityV1Schema.parse({
    schemaVersion: 1,
    fixedInputSchemaVersion: fixedInput.schemaVersion,
    factExtensionSchemaVersion: extension.schemaVersion,
    compiledFactSchemaVersion: compiledFacts.schemaVersion,
    compiledFactSchemaCapabilities: [
      "canonical-chain-supply-distribution.v1",
      "canonical-lock-mint-supply-attribution.v1",
      "exit-route-modeled-confidence.v1",
      "fact-gap-responsibility.v1",
      "journaled-cdp-shock-coverage.v1",
      "reviewed-deployment-unit-supply-attribution.v1",
      "reviewed-transfer-deployments.v1",
      "wrapper-local-facts.v1",
    ],
    compilerAdapter: "exact-fixed-input-to-v9-facts.v2",
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
  });
}

function producerCapabilityIdentity(
  fixedInput: ReportCardsFixedInput,
  extension: SafetyScoreV9FactSetExtensionV2,
): SafetyScoreV9ProducerCapabilityIdentityV1 {
  return SafetyScoreV9ProducerCapabilityIdentityV1Schema.parse({
    schemaVersion: 1,
    inputContractVersions: {
      fixedInput: fixedInput.schemaVersion,
      factExtension: extension.schemaVersion,
    },
    sourceAdapters: {
      registry: "fixed-input.registry.v1",
      dexExitRoutes: "fixed-input.dex-exit-observations.v2",
      redemptionExitRoutes: "fixed-input.redemption-exit-observations.v2",
      liveReserves: "fixed-input.live-reserves.v1",
      chainSupply: "fixed-input.usd-circulating-supply.v4",
      peg: "fixed-input.peg-summary.v1",
      researchOverlays: "v9-fact-extension.review-overlays.v3",
      shockCoverage: "journal-registry.cdp-shock-coverage.v1",
    },
    scoreBearingMethodologyVersions: {
      dexExitRoutes: sortedUnique(fixedInput.inputMethodologyVersions.dexLiquidity),
      redemptionExitRoutes: sortedUnique(fixedInput.inputMethodologyVersions.redemptionBackstop),
      peg: sortedUnique(fixedInput.inputMethodologyVersions.pegScore),
    },
    dexRouteCapabilityMatrixVersions: [
      `declared-source-capabilities:v1:${digest(
        "safety-score-v9.dex-route-source-capabilities.v1",
        DEX_ROUTE_SOURCE_CAPABILITIES,
      )}`,
    ],
    freshnessPolicySec: {
      dexExitRoutes: extension.routeFreshness.dexMaxAgeSec,
      redemptionExitRoutes: extension.routeFreshness.redemptionMaxAgeSec,
      // Documented-terms freshness governs score-eligible redemption evidence
      // and must be capability-bound (VER-011).
      documentedTermsExitRoutes: extension.routeFreshness.documentedTermsMaxAgeSec,
      accessReviews: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
      liveReserves: extension.sources.liveReserves.maxAgeSec,
      chainSupply: extension.sources.chainSupply.maxAgeSec,
      peg: extension.sources.peg.maxAgeSec,
      researchOverlays: extension.sources.researchOverlays.maxAgeSec,
    },
  });
}

function v9PolicyVersion(policy: V9ValidatedPolicyEnvelope): string {
  if (policy.policy.lifecycle !== "active" || policy.policy.releaseVersion === null) {
    throw new Error("Safety Score v9 publication requires an active release policy");
  }
  if (policy.policy.policyId !== "safety-score-v9") {
    throw new Error(`Safety Score v9 policy ID is not publication-compatible: ${policy.policy.policyId}`);
  }
  return policy.policy.releaseVersion;
}

/**
 * Compile, evaluate, and project one exact V9 publication without storage,
 * network access, wall-clock access, or mutation of another publication.
 */
export function buildSafetyScoreV9Candidate(
  input: BuildSafetyScoreV9CandidateInput,
): Readonly<SafetyScoreV9CandidatePipelineResult> {
  return buildSafetyScoreV9CandidateFromNormalizedInput({
    ...input,
    fixedInput: normalizeFixedInput(input.fixedInput),
  });
}

/** Trusted runtime entrypoint for an already normalized exact input. */
function buildSafetyScoreV9CandidateFromNormalizedInput(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
): Readonly<SafetyScoreV9CandidatePipelineResult> {
  return deepFreeze(buildSafetyScoreV9CandidatePipeline(input));
}

function buildSafetyScoreV9CandidatePipeline(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
): SafetyScoreV9CandidatePipelineResult {
  if (!Number.isInteger(input.publishedAtSec) || input.publishedAtSec < 0) {
    throw new Error("Safety Score v9 publication time must be a non-negative integer");
  }

  const fixedInput = input.fixedInput;
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    throw new Error("Safety Score v9 publication evaluation requires exact publication inputs");
  }
  if (input.publishedAtSec < fixedInput.clockSec) {
    throw new Error("Safety Score v9 publication cannot predate its evidence clock");
  }

  const policy = input.policy ?? V9_CANDIDATE_POLICY_V1;
  assertV9ValidatedPolicyEnvelope(policy);
  const policyVersion = v9PolicyVersion(policy);
  const extension = materializeSafetyScoreV9FactSetExtension(
    fixedInput,
    input.extension ?? buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput),
  );
  const compiledFacts = compileSafetyScoreV9FactSetFromValidatedExtension(fixedInput, extension);
  const displayByAssetId = new Map(
    compiledFacts.assets.map((asset) => [asset.assetId, publicDisplayMetadata(asset)]),
  );
  const evaluatedSet = evaluateValidatedV9FactSet(compiledFacts, policy);
  const compilerIdentity = compilerFactSchemaIdentity(fixedInput, extension, compiledFacts);
  const compilerFactSchemaDigest = computeSafetyScoreV9CompilerFactSchemaDigest(compilerIdentity);
  const capabilityIdentity = producerCapabilityIdentity(fixedInput, extension);
  const producerCapabilityDigest = computeSafetyScoreV9ProducerCapabilityDigest(capabilityIdentity);
  const candidateIdentity = SafetyScoreV9CandidateIdentityV1Schema.parse({
    schemaVersion: 1,
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    evaluationBuildDigest: evaluatedSet.evaluationBuildDigest,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
  });
  const candidateId =
    input.releaseCandidateId === undefined
      ? computeSafetyScoreV9CandidateId(candidateIdentity)
      : ReleaseCandidateIdSchema.parse(input.releaseCandidateId);
  const publicationGenerationId = `report-cards:v9:v1:${digest("safety-score-v9.publication.v1", {
    candidateId,
    baseInputGenerationId: evaluatedSet.baseInputGenerationId,
    factSetDigest: evaluatedSet.factSetDigest,
    evaluatedSetDigest: evaluatedSet.evaluatedSetDigest,
    resultDigest: evaluatedSet.scoreResultDigest,
    publishedAtSec: input.publishedAtSec,
  })}`;
  const candidate = buildSafetyScoreV9Response({
    candidateId,
    policyVersion,
    publicationGenerationId,
    publishedAtSec: input.publishedAtSec,
    results: evaluatedSet.assets.map((asset) => ({
      trace: asset.trace,
      scoreInput: asset.scoreInput,
      access: asset.access,
      dependencyInputs: asset.dependencyInputs,
      stressState: asset.stressState,
      policy,
      backing: asset.backing,
      exit: asset.exit,
      control: asset.control,
      display: displayByAssetId.get(asset.assetId),
    })),
  });

  return {
    fixedInput,
    extension,
    compiledFacts,
    evaluatedSet,
    candidate,
    compilerFactSchemaIdentity: compilerIdentity,
    compilerFactSchemaDigest,
    producerCapabilityIdentity: capabilityIdentity,
    producerCapabilityDigest,
    candidateIdentity,
  };
}

/**
 * Compact runtime projection for the canonical publisher. Full pipeline state is
 * retained only by replay and verification callers.
 */
export function buildSafetyScoreV9PublicationFromNormalizedInput(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
): Readonly<SafetyScoreV9PublicationResult> {
  if (!Number.isInteger(input.publishedAtSec) || input.publishedAtSec < 0) {
    throw new Error("Safety Score v9 publication time must be a non-negative integer");
  }
  const fixedInput = input.fixedInput;
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    throw new Error("Safety Score v9 publication evaluation requires exact publication inputs");
  }
  if (input.publishedAtSec < fixedInput.clockSec) {
    throw new Error("Safety Score v9 publication cannot predate its evidence clock");
  }

  const policy = input.policy ?? V9_CANDIDATE_POLICY_V1;
  assertV9ValidatedPolicyEnvelope(policy);
  const policyVersion = v9PolicyVersion(policy);
  let extension: SafetyScoreV9FactSetExtensionV2 | null = materializeSafetyScoreV9FactSetExtension(
    fixedInput,
    input.extension ?? buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput),
  );
  let compiledFacts: CompiledV9FactSetV3 | null = compileSafetyScoreV9FactSetFromValidatedExtension(
    fixedInput,
    extension,
  );
  const compilerIdentity = compilerFactSchemaIdentity(fixedInput, extension, compiledFacts);
  const compilerFactSchemaDigest = computeSafetyScoreV9CompilerFactSchemaDigest(compilerIdentity);
  const capabilityIdentity = producerCapabilityIdentity(fixedInput, extension);
  const producerCapabilityDigest = computeSafetyScoreV9ProducerCapabilityDigest(capabilityIdentity);
  const displayByAssetId = new Map(
    compiledFacts.assets.map((asset) => [asset.assetId, publicDisplayMetadata(asset)]),
  );

  // The published response does not expose replay intermediates. Release each
  // large graph as soon as its compact projection has been captured.
  extension = null;
  const evaluatedSet = evaluateValidatedV9FactSet(compiledFacts, policy);
  compiledFacts = null;
  const candidateIdentity = SafetyScoreV9CandidateIdentityV1Schema.parse({
    schemaVersion: 1,
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    evaluationBuildDigest: evaluatedSet.evaluationBuildDigest,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
  });
  const candidateId =
    input.releaseCandidateId === undefined
      ? computeSafetyScoreV9CandidateId(candidateIdentity)
      : ReleaseCandidateIdSchema.parse(input.releaseCandidateId);
  const publicationGenerationId = `report-cards:v9:v1:${digest("safety-score-v9.publication.v1", {
    candidateId,
    baseInputGenerationId: evaluatedSet.baseInputGenerationId,
    factSetDigest: evaluatedSet.factSetDigest,
    evaluatedSetDigest: evaluatedSet.evaluatedSetDigest,
    resultDigest: evaluatedSet.scoreResultDigest,
    publishedAtSec: input.publishedAtSec,
  })}`;
  const candidate = buildSafetyScoreV9Response({
    candidateId,
    policyVersion,
    publicationGenerationId,
    publishedAtSec: input.publishedAtSec,
    results: evaluatedSet.assets.map((asset) => ({
      trace: asset.trace,
      scoreInput: asset.scoreInput,
      access: asset.access,
      dependencyInputs: asset.dependencyInputs,
      stressState: asset.stressState,
      policy,
      backing: asset.backing,
      exit: asset.exit,
      control: asset.control,
      display: displayByAssetId.get(asset.assetId),
    })),
  });

  return deepFreeze({
    candidate,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
  });
}
