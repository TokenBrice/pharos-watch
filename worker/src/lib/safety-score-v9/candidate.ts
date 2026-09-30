import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { V9ExtensionRegistryMeta } from "./extension";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import {
  evaluateValidatedV9FactSet,
  V9AssetEvaluationError,
  type V9EvaluatedSet,
} from "@shared/lib/safety-score-v9/evaluate-set";
import type { V9ExitHolderEligibility } from "@shared/lib/safety-score-v9/exit";
import { DEX_ROUTE_SOURCE_CAPABILITIES } from "@shared/lib/p4-exit-route-capacity";
import {
  assertV9ValidatedPolicyEnvelope,
  loadV9CandidateMethodologyPolicy,
} from "@shared/lib/safety-score-v9/policy";
import { compareText, deepFreeze, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { buildSafetyScoreV9Response } from "@shared/lib/safety-score-v9/public";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type {
  CompiledV9FactSetV3,
  V9BridgeJoinDiagnosticsV1,
} from "@shared/types/safety-score-v9-facts";
import type {
  SafetyScoreV9CurrentResponse,
  SafetyScoreV9EvidenceFreshness,
} from "@shared/types/safety-score-v9-public";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import { z } from "zod";
import {
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
  type SafetyScoreV9FactSetExtensionV2,
  type V9AssetQuarantine,
} from "./fact-set";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "./extension";
import type { BuildSafetyScoreV9BaselineExtensionOptions } from "./extension";
import type { SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import {
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "./native-input";

const SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN = "safety-score-v9.compiler-fact-schema.v1";
const SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN = "safety-score-v9.producer-capability-build.v1";
const SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN = "safety-score-v9.publication-id.v1";

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
    // 3 = retained exact fixed input (frozen-capture replay); 4 = native V9
    // capture. The digest is unchanged for a v3 input, so historical replays
    // keep their candidate identity byte-for-byte.
    fixedInputSchemaVersion: z.union([z.literal(3), z.literal(4)]),
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
        fixedInput: z.union([z.literal(3), z.literal(4)]),
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
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
  /**
   * Replay-only: accept a capture whose registry fingerprint does not match the
   * local registry. Only reaches the baseline extension builder, so it is inert
   * when an explicit `extension` is supplied. See
   * `BuildSafetyScoreV9BaselineExtensionOptions.allowRegistryMismatch`.
   */
  allowRegistryMismatch?: boolean;
  registry?: Pick<BuildSafetyScoreV9BaselineExtensionOptions, "metaById" | "registryFingerprint" | "reviewedTransferFacts">;
}

export interface BuildSafetyScoreV9CandidateFromNormalizedInput extends Omit<
  BuildSafetyScoreV9CandidateInput,
  "fixedInput"
> {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
}

export interface SafetyScoreV9CandidatePipelineResult {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  extension: Readonly<SafetyScoreV9FactSetExtensionV2>;
  compiledFacts: Readonly<CompiledV9FactSetV3>;
  evaluatedSet: Readonly<V9EvaluatedSet>;
  candidate: Readonly<SafetyScoreV9CurrentResponse>;
  compilerFactSchemaIdentity: Readonly<SafetyScoreV9CompilerFactSchemaIdentityV1>;
  compilerFactSchemaDigest: string;
  producerCapabilityIdentity: Readonly<SafetyScoreV9ProducerCapabilityIdentityV1>;
  producerCapabilityDigest: string;
  candidateIdentity: Readonly<SafetyScoreV9CandidateIdentityV1>;
  quarantines: readonly V9AssetQuarantine[];
  quarantineAffectedAssetIds: readonly string[];
  bridgeJoinDiagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[];
}

export interface SafetyScoreV9PublicationResult {
  candidate: Readonly<SafetyScoreV9CurrentResponse>;
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
  quarantines: readonly V9AssetQuarantine[];
  quarantineAffectedAssetIds: readonly string[];
  bridgeJoinDiagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[];
}

export type SafetyScoreV9BridgeJoinDiagnostic = V9BridgeJoinDiagnosticsV1 & {
  assetId: string;
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function quarantineAffectedAssetIds(
  factSet: CompiledV9FactSetV3,
  quarantines: readonly V9AssetQuarantine[],
): string[] {
  const affected = new Set(
    quarantines.map((quarantine) => quarantine.assetId),
  );
  let added = true;
  while (added) {
    added = false;
    for (const asset of factSet.assets) {
      if (
        affected.has(asset.assetId) ||
        !asset.dependencies.edges.some((edge) =>
          affected.has(edge.upstreamAssetId),
        )
      ) {
        continue;
      }
      affected.add(asset.assetId);
      added = true;
    }
  }
  return [...affected].sort(compareText);
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
  exitRouteDetails: Record<string, {
    chain: string | null;
    protocol: string | null;
    poolId: string | null;
    evidenceKind: string;
    observedAtSec: number | null;
  }>;
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
  const evidenceById = new Map(
    asset.evidence.map((evidence) => [evidence.evidenceId, evidence]),
  );
  const exitRouteDetails = Object.fromEntries(
    asset.exitRoutes.map((route) => {
      const chain = route.failureDomains.find((domain) => domain.kind === "chain")?.key ?? null;
      const protocol = route.failureDomains.find(
        (domain) => domain.kind === "dex-protocol" || domain.kind === "redemption-rail",
      )?.key ?? null;
      const scopedPool = route.routeId
        .split(":")
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        })
        .find((part) => chain !== null && part.startsWith(`${chain.toLowerCase()}:`));
      const routeEvidence = route.status.evidenceRefIds
        .map((evidenceId) => evidenceById.get(evidenceId))
        .find(
          (item) =>
            item?.sourceId === "report-cards-dex-route-observation" ||
            item?.sourceId === "report-cards-redemption-route-observation" ||
            item?.sourceId === "safety-score-v9-retained-route-overlay",
        );
      const evidence = routeEvidence ?? route.status.evidenceRefIds
        .map((evidenceId) => evidenceById.get(evidenceId))
        .find((item) => item !== undefined);
      return [
        route.routeKey,
        {
          chain,
          protocol,
          poolId: scopedPool?.slice(scopedPool.indexOf(":") + 1) ?? null,
          evidenceKind: route.evidenceKind,
          observedAtSec: evidence?.observedAtSec ?? null,
        },
      ];
    }),
  );
  return {
    labels,
    exitHolderEligibility: Object.fromEntries(
      asset.exitRoutes.map((route) => [
        route.routeKey,
        publicExitHolderEligibility(route.holderAccess),
      ]),
    ),
    exitRouteDetails,
  };
}

function computeSafetyScoreV9CompilerFactSchemaDigest(
  identityValue: SafetyScoreV9CompilerFactSchemaIdentityV1,
): string {
  const identity = SafetyScoreV9CompilerFactSchemaIdentityV1Schema.parse(identityValue);
  return domainDigest(SAFETY_SCORE_V9_COMPILER_FACT_SCHEMA_DIGEST_DOMAIN, identity);
}

export function computeSafetyScoreV9ProducerCapabilityDigest(
  identityValue: SafetyScoreV9ProducerCapabilityIdentityV1,
): string {
  const identity = SafetyScoreV9ProducerCapabilityIdentityV1Schema.parse(identityValue);
  return domainDigest(SAFETY_SCORE_V9_PRODUCER_CAPABILITY_DIGEST_DOMAIN, identity);
}

export function computeSafetyScoreV9CandidateId(identityValue: SafetyScoreV9CandidateIdentityV1): string {
  const identity = SafetyScoreV9CandidateIdentityV1Schema.parse(identityValue);
  return `safety-score-v9:v1:${domainDigest(SAFETY_SCORE_V9_CANDIDATE_ID_DIGEST_DOMAIN, identity)}`;
}

function compilerFactSchemaIdentity(
  fixedInput: SafetyScoreV9CompilerInput,
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
  fixedInput: SafetyScoreV9CompilerInput,
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
      `declared-source-capabilities:v1:${domainDigest(
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
 * Public exit-pillar freshness is the age of the captured DEX liquidity input,
 * judged against the same lane bound the fact set applies
 * (`routeFreshness.dexMaxAgeSec`). Presentation only: it annotates the card and
 * never enters a score, a cap, or a candidate/publication identity digest.
 */
function exitPillarFreshnessFromDexInput(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  dexMaxAgeSec: number,
): SafetyScoreV9EvidenceFreshness {
  const updatedAt = fixedInput.dexLiqMap[assetId]?.updatedAt;
  if (updatedAt === undefined) return "unknown";
  return fixedInput.clockSec - updatedAt <= dexMaxAgeSec ? "current" : "stale";
}

const SHARED_BOOK_ID_BY_SCOPE: Readonly<Record<string, string>> = {
  "shared-sky-maker": "sky-maker",
};

/** Capture disclosure before releasing the compiled fact graph. No scoring inputs change. */
export function publicDependencyMetadata(
  asset: CompiledV9FactSetV3["assets"][number],
  factSet: CompiledV9FactSetV3,
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  meta: V9ExtensionRegistryMeta | undefined,
) {
  const live = fixedInput.liveReserveMap[asset.assetId];
  const slices = live ?? meta?.reserves ?? [];
  const reviewedSliceOf = (slice: (typeof slices)[number]) => meta?.reserves?.find((row) =>
    slice.sourceKey ? row.sourceKey === slice.sourceKey : row.name.trim().toLowerCase() === slice.name.trim().toLowerCase(),
  );
  const source = asset.dependencies.dependencyFromLive ? factSet.sourceFingerprints.liveReserves : factSet.sourceFingerprints.researchOverlays;
  const evidence = asset.evidence.filter((row) => asset.dependencies.status.evidenceRefIds.includes(row.evidenceId));
  const evidenceAsOf = evidence.length === 0 ? null : new Date(Math.max(...evidence.map((row) => row.observedAtSec)) * 1000).toISOString();
  const sourceAsOf = asset.dependencies.dependencyFromLive
    ? new Date((fixedInput.liveReserveProvenanceMap[asset.assetId]?.fetchedAt ?? source.observedAtSec) * 1000).toISOString()
    : meta?.dependencyReview?.reviewedAt ?? meta?.reserveReview?.reviewedAt ?? null;
  const dependencyProvenance = new Map(asset.dependencies.edges.map((edge) => {
    const matchingSlices = slices.filter((slice) => (slice.coinId ?? reviewedSliceOf(slice)?.coinId) === edge.upstreamAssetId);
    const contributingSlices = matchingSlices.length > 0 ? matchingSlices : meta?.reserves?.filter((slice) => slice.coinId === edge.upstreamAssetId) ?? [];
    const annotations = contributingSlices.map((slice) => slice.intermediary ?? reviewedSliceOf(slice)?.intermediary ?? null);
    const unverified = annotations.find((annotation) => annotation?.verified === false);
    const first = annotations[0] ?? null;
    const intermediary = unverified ?? (annotations.length === 0
      ? edge.intermediary ?? null
      : annotations.every((annotation) => stableJsonStringifyV1(annotation) === stableJsonStringifyV1(first)) ? first : null);
    return [edge.upstreamAssetId, {
      source: edge.dependencyType === "wrapper" && (meta?.variantOf === edge.upstreamAssetId || asset.dependencies.source === "variant") ? "variant" as const : asset.dependencies.baseSource,
      evidenceAsOf,
      intermediary,
    }] as const;
  }));
  const dependencyCoverage: NonNullable<SafetyScoreV9CurrentCard["dependencyCoverage"]> = [];
  const coveredIdentities = new Set<string>();
  const addCoverage = (label: string, id: string | undefined, share: number | null, reason: string, verified: boolean, sourceKey?: string) => {
    if (reason !== "coinId-without-depType" && id && asset.dependencies.edges.some((edge) => edge.upstreamAssetId === id)) return;
    const key = `${sourceKey ?? `${id ?? ""}\u0000${label}`}\u0000${reason}`;
    if (coveredIdentities.has(key)) return;
    coveredIdentities.add(key);
    dependencyCoverage.push({ upstreamLabel: label, upstreamAssetId: verified ? id ?? null : null, share, reason, sourceAsOf, identityVerified: verified });
  };
  for (const rejection of asset.dependencies.rejectionReasons ?? []) {
    const slice = slices[rejection.sliceIndex];
    const reviewed = slice && reviewedSliceOf(slice);
    const id = rejection.upstreamAssetId ?? slice?.coinId ?? reviewed?.coinId;
    if (id === undefined && slice?.assetClass !== "stablecoin" && !slice?.intermediary) continue;
    addCoverage(slice?.name ?? id ?? "Unresolved reserve relationship", id, rejection.share ?? (slice ? slice.pct / 100 : null), rejection.reason, rejection.reason !== "reviewed-dependency-identity-conflict" && id !== undefined && (slice?.intermediary ?? reviewed?.intermediary)?.verified !== false, slice?.sourceKey);
  }
  for (const slice of slices) {
    if (!slice.coinId) continue;
    const outside = asset.dependencies.diagnostics.issueCodes.find((code) => code === `outside-active-set:${slice.coinId}`);
    const envelope = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition" || gap.reasonCode === "partial-reserve-review");
    if (outside || envelope) addCoverage(slice.name, slice.coinId, slice.pct / 100, outside ?? envelope!.reasonCode, slice.intermediary?.verified !== false, slice.sourceKey);
  }
  for (const code of asset.dependencies.diagnostics.issueCodes) {
    const idCode = /^(?:outside-active-set|invalid-serial-weight|invalid-serial-type|invalid-basket-type|invalid-role-type):(.+)$/.exec(code);
    if (!idCode) continue;
    const id = idCode[1]!;
    if (!dependencyCoverage.some((row) => row.upstreamAssetId === id && row.reason === code)) {
      const relationship = meta?.dependencies?.find((dependency) => dependency.id === id);
      addCoverage(id, id, relationship?.weight ?? null, code, true);
    }
  }
  for (const relationship of meta?.dependencies ?? []) {
    const code = asset.dependencies.diagnostics.issueCodes.find((issue) =>
      issue === "collateral-weight-exceeds-one" || (issue === "self-dependency" && relationship.id === asset.assetId),
    );
    if (code && !dependencyCoverage.some((row) => row.upstreamAssetId === relationship.id && row.reason === code)) {
      addCoverage(relationship.id, relationship.id, relationship.weight, code, true);
    }
  }
  dependencyCoverage.sort((left, right) => compareText(`${left.upstreamLabel}:${left.reason}`, `${right.upstreamLabel}:${right.reason}`));
  const supplyKnown = asset.supply.status.observationState === "known" && asset.supply.circulatingUsd !== null;
  const supplySource = Object.values(factSet.sourceFingerprints).find((identity) => identity.generationId === asset.supply.sourceGenerationId);
  const provenance = fixedInput.liveReserveProvenanceMap[asset.assetId];
  return {
    supply: {
      circulatingUsdAtEvaluation: supplyKnown ? asset.supply.circulatingUsd : null,
      asOfSec: supplyKnown ? supplySource?.observedAtSec ?? null : null,
      generationId: supplyKnown ? asset.supply.sourceGenerationId : null,
    },
    sharedBookId: provenance?.balanceSheetScope && provenance.sharedBookAssetIds?.includes(asset.assetId)
      ? SHARED_BOOK_ID_BY_SCOPE[provenance.balanceSheetScope] ?? null
      : null,
    dependencyProvenance,
    dependencyTypes: new Map(asset.dependencies.edges
      .filter((edge) => edge.economicRole === "serial-claim" || edge.economicRole === "basket-exposure")
      .map((edge) => [`${edge.economicRole === "serial-claim" ? "serial" : "basket"}:${edge.upstreamAssetId}`, edge.dependencyType] as const)),
    dependencyCoverage,
  };
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
    fixedInput: normalizeSafetyScoreV9CompilerInput(input.fixedInput, input.registry?.metaById
      ? new Set([...input.registry.metaById].filter(([, meta]) => meta.flags?.navToken === true).map(([id]) => id))
      : undefined),
  });
}

/** Trusted runtime entrypoint for an already normalized exact input. */
function buildSafetyScoreV9CandidateFromNormalizedInput(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
): Readonly<SafetyScoreV9CandidatePipelineResult> {
  return deepFreeze(buildSafetyScoreV9CandidatePipeline(input, true));
}

/**
 * Compact runtime projection for the canonical publisher. Full pipeline state is
 * retained only by replay and verification callers.
 */
export function buildSafetyScoreV9PublicationFromNormalizedInput(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
): Readonly<SafetyScoreV9PublicationResult> {
  return deepFreeze(buildSafetyScoreV9CandidatePipeline(input, false));
}

function buildSafetyScoreV9CandidatePipeline(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
  retainIntermediates: true,
): SafetyScoreV9CandidatePipelineResult;
function buildSafetyScoreV9CandidatePipeline(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
  retainIntermediates: false,
): SafetyScoreV9PublicationResult;
function buildSafetyScoreV9CandidatePipeline(
  input: BuildSafetyScoreV9CandidateFromNormalizedInput,
  retainIntermediates: boolean,
): SafetyScoreV9CandidatePipelineResult | SafetyScoreV9PublicationResult {
  if (!Number.isInteger(input.publishedAtSec) || input.publishedAtSec < 0) {
    throw new Error("Safety Score v9 publication time must be a non-negative integer");
  }

  const fixedInput = input.fixedInput;
  if (
    fixedInput.captureKind !== "native-v9-inputs" &&
    fixedInput.captureKind !== "exact-publication-inputs"
  ) {
    throw new Error("Safety Score v9 publication evaluation requires exact publication inputs");
  }
  if (input.publishedAtSec < fixedInput.clockSec) {
    throw new Error("Safety Score v9 publication cannot predate its evidence clock");
  }

  const policy = input.policy ?? loadV9CandidateMethodologyPolicy(fixedInput.clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  const policyVersion = v9PolicyVersion(policy);
  let extension: SafetyScoreV9FactSetExtensionV2 | null = materializeSafetyScoreV9FactSetExtension(
    fixedInput,
    input.extension ??
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(
        fixedInput,
        {
          ...input.registry,
          ...(input.allowRegistryMismatch === true ? { allowRegistryMismatch: true } : {}),
          transferMaterialityGeneration: input.transferMaterialityGeneration ?? null,
        },
      ),
  );
  // Read the DEX lane bound off the materialized extension so the card can
  // never drift from the bound the exit evidence itself was judged against;
  // the extension graph is released below.
  const dexExitRouteMaxAgeSec = extension.routeFreshness.dexMaxAgeSec;
  let compilation =
    compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
      fixedInput,
      extension,
    );
  let compiledFacts: CompiledV9FactSetV3 | null = compilation.factSet;
  const evaluationFailures = new Map<string, string>();
  let evaluatedSet: Readonly<V9EvaluatedSet>;
  while (true) {
    try {
      evaluatedSet = evaluateValidatedV9FactSet(compiledFacts, policy);
      break;
    } catch (error) {
      if (
        !(error instanceof V9AssetEvaluationError) ||
        evaluationFailures.has(error.assetId)
      ) {
        throw error;
      }
      evaluationFailures.set(error.assetId, error.message);
      compilation =
        compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
          fixedInput,
          extension,
          evaluationFailures,
        );
      compiledFacts = compilation.factSet;
    }
  }
  const affectedAssetIds = quarantineAffectedAssetIds(
    compiledFacts,
    compilation.quarantines,
  );
  const bridgeJoinDiagnostics = extension.assets
    .flatMap((asset) => {
      const diagnostics = asset.economicControlReview?.bridge.diagnostics;
      return diagnostics === undefined
        ? []
        : [{ assetId: asset.assetId, ...diagnostics }];
    })
    .sort((left, right) => compareText(left.assetId, right.assetId));
  const compilerIdentity = compilerFactSchemaIdentity(fixedInput, extension, compiledFacts);
  const compilerFactSchemaDigest = computeSafetyScoreV9CompilerFactSchemaDigest(compilerIdentity);
  const capabilityIdentity = producerCapabilityIdentity(fixedInput, extension);
  const producerCapabilityDigest = computeSafetyScoreV9ProducerCapabilityDigest(capabilityIdentity);
  const displayByAssetId = new Map(
    compiledFacts.assets.map((asset) => [asset.assetId, publicDisplayMetadata(asset)]),
  );
  const scoreGradeLiveReserveIds = new Set(
    compiledFacts.assets
      .filter((asset) => asset.reserveExposures.some((exposure) => exposure.provenance === "live"))
      .map((asset) => asset.assetId),
  );
  const dependencyMetadataByAssetId = new Map(compiledFacts.assets.map((asset) => [
    asset.assetId,
    publicDependencyMetadata(asset, compiledFacts!, fixedInput, (input.registry?.metaById ?? ACTIVE_META_BY_ID).get(asset.assetId)),
  ]));

  // The published response does not expose replay intermediates. Release each
  // large graph as soon as its compact projection has been captured; replay and
  // verification callers keep the same graphs through `retained`.
  const retained = retainIntermediates ? { extension, compiledFacts } : null;
  extension = null;
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
  const publicationGenerationId = `report-cards:v9:v1:${domainDigest("safety-score-v9.publication.v1", {
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
    commonModeGroups: evaluatedSet.dependencyPlan.commonModeGroups,
    results: evaluatedSet.assets.map((asset) => ({
      trace: asset.trace,
      backingFromLiveReserves: scoreGradeLiveReserveIds.has(asset.assetId),
      ...dependencyMetadataByAssetId.get(asset.assetId),
      scoreInput: asset.scoreInput,
      access: asset.access,
      dependencyInputs: asset.dependencyInputs,
      policy,
      backing: asset.backing,
      exit: asset.exit,
      control: asset.control,
      display: displayByAssetId.get(asset.assetId),
      freshness: {
        exit: exitPillarFreshnessFromDexInput(fixedInput, asset.assetId, dexExitRouteMaxAgeSec),
      },
    })),
  });

  if (retained === null) {
    return {
      candidate,
      compilerFactSchemaDigest,
      producerCapabilityDigest,
      quarantines: compilation.quarantines,
      quarantineAffectedAssetIds: affectedAssetIds,
      bridgeJoinDiagnostics,
    };
  }

  return {
    fixedInput,
    extension: retained.extension,
    compiledFacts: retained.compiledFacts,
    evaluatedSet,
    candidate,
    compilerFactSchemaIdentity: compilerIdentity,
    compilerFactSchemaDigest,
    producerCapabilityIdentity: capabilityIdentity,
    producerCapabilityDigest,
    candidateIdentity,
    quarantines: compilation.quarantines,
    quarantineAffectedAssetIds: affectedAssetIds,
    bridgeJoinDiagnostics,
  };
}
