import {
  CompiledV9FactSetV2Schema,
  V9FactSetCoreV2Schema,
  V9PublicFactSetProjectionV2Schema,
  type CompiledV9FactSetV2,
  type V9AssetFactsV2,
  type V9FactSetCoreV2,
  type V9FactStatusV2,
  type V9PublicFactSetProjectionV2,
} from "../../types/safety-score-v9-facts";
import type { DependencyType } from "../../types/dependency-types";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

const V9_FACT_SET_DIGEST_DOMAIN = "safety-score-v9.normalized-facts.v2";

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

export function canonicalV9DependencyEdgeKey(dependencyType: DependencyType, upstreamAssetId: string): string {
  return `${dependencyType}:${upstreamAssetId}`;
}

export function canonicalV9RouteKey(lane: "dex" | "redemption", sourceGenerationId: string, routeId: string): string {
  return `${lane}:${sourceGenerationId}:${routeId}`;
}

function projectV9FactSetDigestPayload(input: V9FactSetCoreV2 | CompiledV9FactSetV2) {
  const normalized =
    "v9FactSetDigest" in input ? CompiledV9FactSetV2Schema.parse(input) : V9FactSetCoreV2Schema.parse(input);
  return {
    schemaVersion: normalized.schemaVersion,
    baseInputGenerationId: normalized.baseInputGenerationId,
    asOfSec: normalized.asOfSec,
    sourceFingerprints: normalized.sourceFingerprints,
    activeAssetIds: normalized.activeAssetIds,
    assets: normalized.assets,
  };
}

export function computeV9FactSetDigest(input: V9FactSetCoreV2 | CompiledV9FactSetV2): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_FACT_SET_DIGEST_DOMAIN,
      factSet: projectV9FactSetDigestPayload(input),
    }),
  );
}

function assertV9FactSetDigest(factSet: CompiledV9FactSetV2): void {
  const expected = computeV9FactSetDigest(factSet);
  if (factSet.v9FactSetDigest !== expected) {
    throw new Error(`Safety Score v9 fact-set digest ${factSet.v9FactSetDigest} does not match ${expected}`);
  }
}

export function parseCompiledV9FactSetV2(input: unknown): CompiledV9FactSetV2 {
  const factSet = CompiledV9FactSetV2Schema.parse(input);
  assertV9FactSetDigest(factSet);
  return factSet;
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
