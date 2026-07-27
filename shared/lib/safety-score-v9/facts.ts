import {
  CompiledV9FactSetV2Schema,
  CompiledV9FactSetV3Schema,
  V9FactSetCoreV2Schema,
  V9FactSetCoreV3Schema,
  V9PublicFactSetProjectionV2Schema,
  type CompiledV9FactSetV2,
  type CompiledV9FactSetV3,
  type V9EvidenceResponsibility,
  type V9AssetFactsV2,
  type V9FactGapV2,
  type V9FactSetCoreV2,
  type V9FactSetCoreV3,
  type V9FactStatusV2,
  type V9PublicFactSetProjectionV2,
} from "../../types/safety-score-v9-facts";
import type { DependencyType, V9DependencyEconomicRole } from "../../types/dependency-types";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9WrapperLocalFacts,
  type V9WrapperLocalFactKey,
} from "../../types/safety-score-v9-wrapper";
import { V9_REASON_CODES, type V9ReasonCode } from "../../types/safety-score-v9";
import { sha256HexFromUtf8Chunks } from "../sha256";
import { stableJsonStringifyChunksV1 } from "../stable-json";

const V9_FACT_SET_DIGEST_DOMAINS = {
  2: "safety-score-v9.normalized-facts.v2",
  3: "safety-score-v9.normalized-facts.v3",
} as const;

/**
 * Producer contract for the pooled route key that carries exact supply observed
 * under raw provider chain labels which fail canonical resolution. The pool is
 * one conservative row per asset so aliases cannot each receive an independent
 * subthreshold exemption. Both the worker producer
 * (safety-score-v9-extension-supply.ts) and the pure evaluator key off this
 * prefix; keep them in sync.
 */
export const V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX = "unmatched-chain-label-pool:";

export function isV9UncanonicalizedChainPoolRoute(deploymentRouteKey: string): boolean {
  return deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX);
}

/**
 * Exact supply held behind one reviewed lock/mint representation whose
 * destination distribution is not observed. The row carries one bounded
 * group share and must never be expanded into inferred per-destination shares.
 */
export const V9_REPRESENTATION_GROUP_ROUTE_PREFIX = "representation-group:";

export function v9RepresentationGroupRouteKey(
  assetId: string,
  representationId: string,
): string {
  return `${V9_REPRESENTATION_GROUP_ROUTE_PREFIX}${assetId}:${representationId}`;
}

export function isV9RepresentationGroupRoute(deploymentRouteKey: string): boolean {
  return deploymentRouteKey.startsWith(V9_REPRESENTATION_GROUP_ROUTE_PREFIX);
}

export function canonicalV9DependencyEdgeKey(
  dependencyType: DependencyType,
  upstreamAssetId: string,
  economicRole?: V9DependencyEconomicRole,
): string {
  return economicRole
    ? `${economicRole}:${dependencyType}:${upstreamAssetId}`
    : `${dependencyType}:${upstreamAssetId}`;
}

export function canonicalV9RouteKey(lane: "dex" | "redemption", sourceGenerationId: string, routeId: string): string {
  return `${lane}:${sourceGenerationId}:${routeId}`;
}

type V9FactSetCore = V9FactSetCoreV2 | V9FactSetCoreV3;
type CompiledV9FactSet = CompiledV9FactSetV2 | CompiledV9FactSetV3;

function parseV9FactSetDigestInput(input: V9FactSetCore | CompiledV9FactSet): V9FactSetCore | CompiledV9FactSet {
  return (
    input.schemaVersion === 2
      ? "v9FactSetDigest" in input
        ? CompiledV9FactSetV2Schema.parse(input)
        : V9FactSetCoreV2Schema.parse(input)
      : "v9FactSetDigest" in input
        ? CompiledV9FactSetV3Schema.parse(input)
        : V9FactSetCoreV3Schema.parse(input)
  );
}

function projectValidatedV9FactSetDigestPayload(input: V9FactSetCore | CompiledV9FactSet) {
  return {
    schemaVersion: input.schemaVersion,
    baseInputGenerationId: input.baseInputGenerationId,
    asOfSec: input.asOfSec,
    sourceFingerprints: input.sourceFingerprints,
    activeAssetIds: input.activeAssetIds,
    assets: input.assets,
  };
}

/** Hash a schema-validated fact set without cloning its full object graph. */
export function computeValidatedV9FactSetDigest(input: V9FactSetCore | CompiledV9FactSet): string {
  return sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1({
      domain: V9_FACT_SET_DIGEST_DOMAINS[input.schemaVersion],
      factSet: projectValidatedV9FactSetDigestPayload(input),
    }),
  );
}

export function computeV9FactSetDigest(input: V9FactSetCore | CompiledV9FactSet): string {
  return computeValidatedV9FactSetDigest(parseV9FactSetDigestInput(input));
}

function assertV9FactSetDigest(factSet: CompiledV9FactSet): void {
  const expected = computeValidatedV9FactSetDigest(factSet);
  if (factSet.v9FactSetDigest !== expected) {
    throw new Error(`Safety Score v9 fact-set digest ${factSet.v9FactSetDigest} does not match ${expected}`);
  }
}

export function parseCompiledV9FactSetV2(input: unknown): CompiledV9FactSetV2 {
  const factSet = CompiledV9FactSetV2Schema.parse(input);
  assertV9FactSetDigest(factSet);
  return factSet;
}

export function parseCompiledV9FactSetV3(input: unknown): CompiledV9FactSetV3 {
  const factSet = CompiledV9FactSetV3Schema.parse(input);
  assertV9FactSetDigest(factSet);
  return factSet;
}

export const V9_LEGACY_RESPONSIBILITY_BY_REASON = {
  "bounded-mechanism-review": "integration-missing",
  "bounded-unknown-reserve-exposure": "integration-missing",
  "correlated-exit-routes": "measured-adverse",
  "critical-unresolved": "method-unsupported",
  "future-dated-input-fact": "producer-failed",
  "historical-critical-input": "integration-missing",
  "immaterial-unrecognized-chain-pool": "producer-failed",
  "implementation-parent-cycle": "method-unsupported",
  "incomparable-route-requests": "method-unsupported",
  "incomplete-dex-route-coverage": "producer-failed",
  "incomplete-oracle-liquidation-branch": "integration-missing",
  "inherited-access-exposure": "measured-adverse",
  "peg-supply-floor-withheld": "measured-adverse",
  "insufficient-evidence": "integration-missing",
  "material-bridge-supply-unmatched": "producer-failed",
  "material-dependency-unavailable": "integration-missing",
  "material-reserve-slice-unstructured": "integration-missing",
  "material-unknown-reserve-exposure": "issuer-undisclosed",
  "mint-control-question": "issuer-undisclosed",
  "missing-applicable-peg": "integration-missing",
  "missing-archetype": "method-unsupported",
  "missing-bridge-route-rows": "producer-failed",
  "missing-bridge-routes": "integration-missing",
  "missing-custody-profile": "issuer-undisclosed",
  "missing-implementation-date": "integration-missing",
  "missing-latest-assurance-report": "issuer-undisclosed",
  "missing-mint-authority": "issuer-undisclosed",
  "missing-oracle-profile": "issuer-undisclosed",
  "missing-parent-score": "integration-missing",
  "missing-peg-input": "producer-failed",
  "missing-pillar": "integration-missing",
  "missing-access-review": "integration-missing",
  "missing-pillar-evidence": "integration-missing",
  "missing-required-oracle-branches": "issuer-undisclosed",
  "missing-reserve-composition": "issuer-undisclosed",
  "missing-runtime-route-evidence": "producer-failed",
  "missing-same-notional-route": "producer-failed",
  "missing-upgrade-control": "issuer-undisclosed",
  "missing-upgradeability-review": "integration-missing",
  "nonmaterial-dependency-unavailable": "integration-missing",
  // Retained V2 cannot distinguish a measured zero-exit outcome from producer
  // or integration absence. Only native V3 facts may author measured-adverse.
  "no-viable-exit-path": "method-unsupported",
  "parent-cycle": "method-unsupported",
  "partial-reserve-review": "issuer-undisclosed",
  "runtime-bridge-materiality-unavailable": "integration-missing",
  "selected-bridge-route-missing": "producer-failed",
  "selected-bridge-route-unresolved": "integration-missing",
  "unknown-control-cap-authority": "issuer-undisclosed",
  "unknown-control-mint-ability": "issuer-undisclosed",
  "unknown-upgrade-authority": "issuer-undisclosed",
  "unresolved-control-identity": "issuer-undisclosed",
  "unresolved-exit-output": "integration-missing",
  "unresolved-mint-authority": "issuer-undisclosed",
  "unresolved-oracle-branch-applicability": "issuer-undisclosed",
  "unsupported-same-notional-route": "method-unsupported",
  "unreviewed-dependency-relationships": "integration-missing",
  "unreviewed-oracle-profile": "integration-missing",
  "unreviewed-reserve-envelope": "issuer-undisclosed",
} as const satisfies Record<V9ReasonCode, V9EvidenceResponsibility>;

if (Object.keys(V9_LEGACY_RESPONSIBILITY_BY_REASON).length !== V9_REASON_CODES.length) {
  throw new Error("Safety Score v9 legacy responsibility map is not exhaustive");
}

export function upgradeV9FactGapV2(gap: V9FactGapV2) {
  const responsibility: V9EvidenceResponsibility =
    gap.observationState === "stale"
      ? "producer-failed"
      : gap.observationState === "unsupported"
        ? "method-unsupported"
        : V9_LEGACY_RESPONSIBILITY_BY_REASON[gap.reasonCode];
  return { ...gap, responsibility };
}

function legacyWrapperLocalFacts(asset: V9AssetFactsV2): V9WrapperLocalFacts {
  const wrapperEdge = asset.dependencies.edges.find(
    (edge) => edge.pathKind === "serial-dependency" && edge.dependencyType === "wrapper",
  );
  const form =
    asset.variantKind === "pure-wrapper"
      ? "pure"
      : asset.variantKind === "savings-passthrough" || asset.variantKind === "risk-absorption"
        ? "native-staked"
        : asset.variantKind === "strategy-vault" || wrapperEdge !== undefined
          ? "strategy-vault"
          : null;
  const classificationEvidenceRefIds = [
    ...new Set([
      ...asset.implementation.status.evidenceRefIds,
      ...asset.dependencies.status.evidenceRefIds,
      ...(wrapperEdge?.evidenceRefIds ?? []),
    ]),
  ].sort();
  if (form === null) {
    return {
      schemaVersion: 1,
      applicability: "not-wrapper",
      evidenceRefIds: classificationEvidenceRefIds,
    };
  }
  const unavailableFact = (factKey: V9WrapperLocalFactKey) => ({
    disposition: "integration-missing" as const,
    assessment: null,
    signals: [`legacy-v2-wrapper-local-fact-not-compiled:${factKey}`],
    evidenceRefIds: [],
  });
  return {
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: classificationEvidenceRefIds.length > 0 ? "reviewed" : "integration-missing",
    formSignals: [`legacy-v2-wrapper-form:${form}`],
    formEvidenceRefIds: classificationEvidenceRefIds,
    facts: Object.fromEntries(
      V9_WRAPPER_LOCAL_FACT_KEYS.map((factKey) => [factKey, unavailableFact(factKey)]),
    ) as Record<V9WrapperLocalFactKey, ReturnType<typeof unavailableFact>>,
    riskTransfer: {
      disposition: "integration-missing",
      mechanism: "unknown",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["legacy-v2-risk-transfer-not-compiled"],
      evidenceRefIds: [],
    },
  };
}

/** Upgrade retained V2 bytes into the responsibility-bearing V3 evaluator contract. */
export function upgradeCompiledV9FactSetV2(input: unknown): CompiledV9FactSetV3 {
  const retained = parseCompiledV9FactSetV2(input);
  const { v9FactSetDigest: _retainedDigest, ...retainedCore } = retained;
  const core = V9FactSetCoreV3Schema.parse({
    ...retainedCore,
    schemaVersion: 3,
    assets: retained.assets.map((asset) => ({
      ...asset,
      dependencies: {
        ...asset.dependencies,
        edges: asset.dependencies.edges.map((edge) => ({
          ...edge,
          edgeKey: canonicalV9DependencyEdgeKey(edge.dependencyType, edge.upstreamAssetId, edge.economicRole),
        })),
      },
      wrapperLocalFacts: asset.wrapperLocalFacts ?? legacyWrapperLocalFacts(asset),
      gaps: asset.gaps.map(upgradeV9FactGapV2),
    })),
  });
  return parseCompiledV9FactSetV3({
    ...core,
    v9FactSetDigest: computeV9FactSetDigest(core),
  });
}

export interface V9EvaluationFactSetRead {
  sourceSchemaVersion: 2 | 3;
  sourceFactSetDigest: string;
  factSet: CompiledV9FactSetV3;
}

/** Strict dual reader: retained V2 is validated before explicit V3 upgrade. */
export function readCompiledV9FactSetForEvaluation(input: unknown): V9EvaluationFactSetRead {
  const schemaVersion =
    input !== null && typeof input === "object" ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (schemaVersion === 2) {
    const retained = parseCompiledV9FactSetV2(input);
    return {
      sourceSchemaVersion: 2,
      sourceFactSetDigest: retained.v9FactSetDigest,
      factSet: upgradeCompiledV9FactSetV2(retained),
    };
  }
  if (schemaVersion === 3) {
    const factSet = parseCompiledV9FactSetV3(input);
    return { sourceSchemaVersion: 3, sourceFactSetDigest: factSet.v9FactSetDigest, factSet };
  }
  throw new Error(`Unsupported Safety Score v9 fact-set schema version: ${String(schemaVersion)}`);
}

function statusesForProjection(asset: V9AssetFactsV2): readonly V9FactStatusV2[] {
  const mechanismStatuses = asset.mechanismRiskReview.review
    ? Object.values(asset.mechanismRiskReview.review).flatMap((value) =>
        value !== null && typeof value === "object" && "status" in value ? [value.status as V9FactStatusV2] : [],
      )
    : [];
  return [
    asset.implementation.status,
    asset.mechanismRiskReview.status,
    ...mechanismStatuses,
    asset.dependencies.status,
    asset.reserveStatus,
    ...asset.reserveExposures.map((exposure) => exposure.status),
    asset.exitStatus,
    ...asset.exitRoutes.flatMap((route) => [route.status, route.output.status]),
    asset.controlStatus,
    ...asset.controls.map((control) => control.status),
    asset.economicControlReview.mint.status,
    asset.economicControlReview.oracle.status,
    ...asset.economicControlReview.oracle.branches.map((branch) => branch.status),
    asset.economicControlReview.bridge.status,
    asset.accessReview.transfer.status,
    asset.accessReview.freeze.status,
    ...asset.accessReview.freeze.reviews.map((review) => review.status),
    asset.peg.status,
    asset.supply.status,
  ];
}

function stateCounts(asset: V9AssetFactsV2) {
  const counts = {
    known: 0,
    missing: 0,
    stale: 0,
    unsupported: 0,
    boundedUnknown: 0,
    notApplicable: 0,
    applicabilityUnresolved: 0,
  };
  for (const status of statusesForProjection(asset)) {
    if (status.observationState === "known") counts.known += 1;
    else if (status.observationState === "missing") counts.missing += 1;
    else if (status.observationState === "stale") counts.stale += 1;
    else if (status.observationState === "unsupported") counts.unsupported += 1;
    else counts.boundedUnknown += 1;
    if (status.applicability.state === "not-applicable") counts.notApplicable += 1;
    if (status.applicability.state === "unresolved") counts.applicabilityUnresolved += 1;
  }
  return counts;
}

/** Compact projection excludes full evidence, private messages, controls, and reserve classifications. */
export function projectPublicV9FactSetV2(input: CompiledV9FactSetV2): V9PublicFactSetProjectionV2 {
  const factSet = parseCompiledV9FactSetV2(input);
  return V9PublicFactSetProjectionV2Schema.parse({
    schemaVersion: 2,
    baseInputGenerationId: factSet.baseInputGenerationId,
    v9FactSetDigest: factSet.v9FactSetDigest,
    asOfSec: factSet.asOfSec,
    activeAssetIds: factSet.activeAssetIds,
    assets: factSet.assets.map((asset) => ({
      assetId: asset.assetId,
      archetype: asset.archetype,
      stateCounts: stateCounts(asset),
      dependencies: asset.dependencies.edges.map((edge) => ({
        upstreamAssetId: edge.upstreamAssetId,
        dependencyType: edge.dependencyType,
        pathKind: edge.pathKind,
        economicRole: edge.economicRole,
        weight: edge.weight,
      })),
      exitRoutes: asset.exitRoutes.map((route) => ({
        routeKey: route.routeKey,
        lane: route.lane,
        observationState: route.status.observationState,
        scoreEligible: route.scoreEligible,
      })),
      supply: {
        observationState: asset.supply.status.observationState,
        circulatingUsd: asset.supply.circulatingUsd,
        selectedRouteSupplyShare: asset.supply.selectedRouteSupplyShare,
        unknownRouteSupplyShare: asset.supply.unknownRouteSupplyShare,
        unreviewedRouteSupplyShare: asset.supply.unreviewedRouteSupplyShare,
      },
      gaps: asset.gaps.map((gap) => ({
        gapId: gap.gapId,
        reasonCode: gap.reasonCode,
        ownerDomain: gap.ownerDomain,
        policyRuleId: gap.policyRuleId,
        observationState: gap.observationState,
        pathKind: gap.path.kind,
      })),
    })),
  });
}
