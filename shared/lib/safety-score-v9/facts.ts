import {
  CompiledV9FactSetV2Schema,
  CompiledV9FactSetV3Schema,
  V9FactSetCoreV2Schema,
  V9FactSetCoreV3Schema,
  type CompiledV9FactSetV2,
  type CompiledV9FactSetV3,
  type V9EvidenceResponsibility,
  type V9FactGapV2,
  type V9FactSetCoreV2,
  type V9FactSetCoreV3,
} from "../../types/safety-score-v9-facts";
import type { DependencyType, V9DependencyEconomicRole } from "../../types/dependency-types";
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

// Test seam (keep exported): parse-then-hash over an unvalidated fact set.
// `computeValidatedV9FactSetDigest` (the production entry) assumes a validated
// input, so the tamper-detection assertions need this form.
export function computeV9FactSetDigest(input: V9FactSetCore | CompiledV9FactSet): string {
  return computeValidatedV9FactSetDigest(parseV9FactSetDigestInput(input));
}

function assertV9FactSetDigest(factSet: CompiledV9FactSet): void {
  const expected = computeValidatedV9FactSetDigest(factSet);
  if (factSet.v9FactSetDigest !== expected) {
    throw new Error(`Safety Score v9 fact-set digest ${factSet.v9FactSetDigest} does not match ${expected}`);
  }
}

// Test seam (keep exported): the only path returning the *retained V2 shape*.
// `readCompiledV9FactSetForEvaluation` upgrades V2 to V3, so the frozen-capture
// byte-stability round-trip and the digest-tamper refusal have no public route.
export function parseCompiledV9FactSetV2(input: unknown): CompiledV9FactSetV2 {
  const factSet = CompiledV9FactSetV2Schema.parse(input);
  assertV9FactSetDigest(factSet);
  return factSet;
}

// Test seam (keep exported): V3 digest-tamper refusal, paired with the V2 form.
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
  "implementation-parent-cycle": "method-unsupported",
  "incomparable-route-requests": "method-unsupported",
  "incomplete-dex-route-coverage": "producer-failed",
  "incomplete-oracle-liquidation-branch": "integration-missing",
  "inherited-access-exposure": "measured-adverse",
  "reviewed-possible-access": "measured-adverse",
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
  "peg-price-unavailable-adverse-history": "measured-adverse",
  "missing-pillar": "integration-missing",
  "missing-access-review": "integration-missing",
  "missing-pillar-evidence": "integration-missing",
  "missing-required-oracle-branches": "issuer-undisclosed",
  "missing-reserve-composition": "issuer-undisclosed",
  "missing-runtime-route-evidence": "producer-failed",
  "missing-same-notional-route": "producer-failed",
  "missing-upgrade-control": "issuer-undisclosed",
  "missing-upgradeability-review": "integration-missing",
  "nonmaterial-bridge-supply-unmatched": "producer-failed",
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

// Test seam (keep exported): per-gap V2->V3 responsibility mapping, asserted in
// isolation because a whole-fact-set upgrade cannot isolate one legacy reason.
export function upgradeV9FactGapV2(gap: V9FactGapV2) {
  const responsibility: V9EvidenceResponsibility =
    gap.observationState === "stale"
      ? "producer-failed"
      : gap.observationState === "unsupported"
        ? "method-unsupported"
        : V9_LEGACY_RESPONSIBILITY_BY_REASON[gap.reasonCode];
  return { ...gap, responsibility };
}

export interface V9EvaluationFactSetRead {
  sourceSchemaVersion: 3;
  sourceFactSetDigest: string;
  factSet: CompiledV9FactSetV3;
}

/** Strict V3 reader for the responsibility-bearing evaluator contract. */
export function readCompiledV9FactSetForEvaluation(input: unknown): V9EvaluationFactSetRead {
  const schemaVersion =
    input !== null && typeof input === "object" ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (schemaVersion !== 3) {
    throw new Error(`Unsupported Safety Score v9 fact-set schema version: ${String(schemaVersion)}; expected 3`);
  }
  const factSet = parseCompiledV9FactSetV3(input);
  return { sourceSchemaVersion: 3, sourceFactSetDigest: factSet.v9FactSetDigest, factSet };
}
