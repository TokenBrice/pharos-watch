import {
  V9EvidenceGapQueueCoreV1Schema,
  V9EvidenceGapQueueCoreV2Schema,
  V9EvidenceGapQueueCoreV3Schema,
  V9EvidenceGapQueueV1Schema,
  V9EvidenceGapQueueV2Schema,
  V9EvidenceGapQueueV3Schema,
  type V9EvidenceGapAction,
  type V9EvidenceGapDocumentation,
  type V9EvidenceGapMaterialityV1,
  type V9EvidenceGapPolicyBindingIssue,
  type V9EvidenceGapQueueCoreV1,
  type V9EvidenceGapQueueCoreV2,
  type V9EvidenceGapQueueCoreV3,
  type V9EvidenceGapBridgeJoinV1,
  type V9EvidenceGapQueueEntryV2,
  type V9EvidenceGapQueueEntryV3,
  type V9EvidenceGapQueue,
  type V9EvidenceGapQueueV3,
  type V9EvidenceGapReviewState,
  type V9EvidenceGapSupplyWeightV1,
} from "../../types/safety-score-v9-evidence-queue";
import {
  isUsdDenominatedSupplyKind,
  factStatuses,
  type V9AssetFactsV3,
  type V9FactGapV3,
  type V9FactApplicability,
} from "../../types/safety-score-v9-facts";
import { V9EvidenceResponsibilitySchema } from "../../types/safety-score-v9-fact-primitives";
import { V9DocumentationReasonSchema, type V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { readCompiledV9FactSetForEvaluation } from "./facts";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonTreatment } from "./policy";
import { evaluateV9SubthresholdUnresolvedBridgeJoins } from "./control-bridge-join";
import { compareText } from "./primitives";
import { classifyV9DocumentationGap } from "./documentation";
import { deepFreeze } from "../../types/safety-score-v9-immutable";
import { parseIsoDateOrUtcInstantSec } from "../../types/date-primitives";

const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V1 = "safety-score-v9.evidence-gap-queue.v1";
const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V3 = "safety-score-v9.evidence-gap-queue.v3";
const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V4 = "safety-score-v9.evidence-gap-queue.v4";
const V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN_V3 = "safety-score-v9.evidence-gap-key.v3";

function gapApplicability(
  applicabilityByGap: ReadonlyMap<string, V9FactApplicability["state"]>,
  gap: V9FactGapV3,
): "required" | "unresolved" {
  const state = applicabilityByGap.get(gap.gapId);
  if (state === undefined) throw new Error(`Safety Score v9 gap ${gap.gapId} is not referenced by a fact status`);
  if (state === "not-applicable") {
    throw new Error(`Safety Score v9 gap ${gap.gapId} is attached to a reviewed not-applicable fact`);
  }
  return state;
}

function materialityForGap(asset: V9AssetFactsV3, gap: V9FactGapV3): V9EvidenceGapMaterialityV1 {
  const path = gap.path;
  if (path.kind === "serial-dependency") return { basis: "serial-claim", fractionOfAsset: 1 };
  if (path.kind === "collateral-exposure") {
    const exposure = asset.reserveExposures.find((candidate) => candidate.exposureKey === path.exposureKey);
    if (!exposure) throw new Error(`Safety Score v9 gap ${gap.gapId} references a missing reserve exposure`);
    return { basis: "collateral-exposure", fractionOfAsset: exposure.weight };
  }
  if (path.kind === "deployment-control") {
    const control = asset.controls.find((candidate) => candidate.controlKey === path.controlKey);
    if (!control) throw new Error(`Safety Score v9 gap ${gap.gapId} references a missing deployment control`);
    return control.materialSupplyShare === null
      ? { basis: "unresolved", fractionOfAsset: null }
      : { basis: "deployment-supply-share", fractionOfAsset: control.materialSupplyShare };
  }
  if (path.kind === "optional-exit") {
    const route = asset.exitRoutes.find((candidate) => candidate.routeKey === path.routeKey);
    if (!route) throw new Error(`Safety Score v9 gap ${gap.gapId} references a missing exit route`);
    return {
      basis: route.scoreEligible ? "score-eligible-exit-route" : "optional-exit-route",
      fractionOfAsset: null,
    };
  }
  if (path.kind === "methodology") return { basis: "methodology-decision", fractionOfAsset: null };
  return { basis: "asset-wide", fractionOfAsset: 1 };
}

function supplyWeightForGap(
  asset: V9AssetFactsV3,
  materiality: V9EvidenceGapMaterialityV1,
  currentEvidence: boolean,
): V9EvidenceGapSupplyWeightV1 {
  const canonicalUsd = asset.supply.circulatingUsd;
  if (
    asset.supply.status.observationState !== "known" ||
    !isUsdDenominatedSupplyKind(asset.supply.sourceKind) ||
    canonicalUsd === null ||
    !currentEvidence
  ) {
    return {
      state: "unavailable",
      canonicalUsd: null,
      materialityWeightedUsd: null,
      sourceGenerationId: asset.supply.sourceGenerationId,
    };
  }
  return {
    state: "current-valid",
    canonicalUsd,
    materialityWeightedUsd:
      materiality.fractionOfAsset === null ? null : canonicalUsd * materiality.fractionOfAsset,
    sourceGenerationId: asset.supply.sourceGenerationId,
  };
}

function actionForGap(
  gap: V9FactGapV3,
  applicability: "required" | "unresolved",
  policyBindingIssues: readonly V9EvidenceGapPolicyBindingIssue[],
): V9EvidenceGapAction {
  if (policyBindingIssues.length > 0) return "reconcile-policy-binding";
  if (gap.path.kind === "methodology" || gap.ownerDomain === "methodology") return "resolve-methodology-decision";
  if (applicability === "unresolved") return "resolve-applicability";
  if (gap.causeProof.cause === "A") return "implement-producer-capability";
  if (gap.causeProof.cause === "B" || gap.causeProof.cause === "U") return "collect-evidence";
  if (gap.observationState === "missing") return "collect-evidence";
  if (gap.observationState === "stale") return "refresh-evidence";
  if (gap.observationState === "unsupported") return "implement-producer-capability";
  return "adjudicate-bounded-unknown";
}

/**
 * ODR-D5a: the reason codes whose work item is a bridge-join question. The
 * richer missing-data registry already hands its `BRIDGE_MATERIALITY` /
 * `BRIDGE_ROUTE_REVIEW` items the whole bridge review verbatim; this terse
 * queue carried none of it, so a bridge gap named no row.
 */
const V9_BRIDGE_JOIN_REASON_CODES: ReadonlySet<V9FactGapV3["reasonCode"]> = new Set([
  "material-bridge-supply-unmatched",
  "missing-bridge-route-rows",
  "missing-bridge-routes",
  "nonmaterial-bridge-supply-unmatched",
  "runtime-bridge-materiality-unavailable",
  "selected-bridge-route-missing",
  "selected-bridge-route-unresolved",
]);

/**
 * A gap is bridge-scoped when its reason is one of the bridge codes, or when it
 * hangs off a deployment control the producer compiled as a bridge control
 * (`unresolved-control-identity` on a bridge row is the common case).
 */
function gapIsBridgeScoped(asset: V9AssetFactsV3, gap: V9FactGapV3): boolean {
  if (V9_BRIDGE_JOIN_REASON_CODES.has(gap.reasonCode)) return true;
  const path = gap.path;
  if (path.kind !== "deployment-control") return false;
  const control = asset.controls.find((candidate) => candidate.controlKey === path.controlKey);
  return control?.controlKind === "bridge";
}

function bridgeJoinForAsset(
  asset: V9AssetFactsV3,
  materialShareThreshold: number,
  commonModeShareThreshold: number,
  unresolvedFullCeilingShareThreshold: number,
): V9EvidenceGapBridgeJoinV1 {
  const bridge = asset.economicControlReview.bridge;
  const join = evaluateV9SubthresholdUnresolvedBridgeJoins(
    asset,
    asset.controls,
    bridge.routes,
    materialShareThreshold,
    commonModeShareThreshold,
    unresolvedFullCeilingShareThreshold,
  );
  return {
    diagnostics: bridge.diagnostics ?? null,
    subthresholdUnresolvedJoin: {
      complete: join.complete,
      cause: join.cause === null ? null : { ...join.cause, controlKeys: [...join.cause.controlKeys] },
    },
  };
}

/**
 * The documentation band, copied from the shared classifier. The class never
 * changes a score, a cause, a binding or a gap identity.
 */
function documentationForGap(
  policy: V9ValidatedPolicyEnvelope,
  asset: V9AssetFactsV3,
  gap: V9FactGapV3,
): V9EvidenceGapDocumentation | null {
  const classification = classifyV9DocumentationGap(policy, asset, gap);
  if (classification === null) return null;
  return {
    class: "documentation",
    reason: classification.reason,
    policyRef: classification.policyRef,
    threshold: classification.threshold,
  };
}

/**
 * The issuer researched-terminal band (PLAN §4.3). A cause-C proof records that
 * the issuer was researched and does not publish the datum, so the item leaves
 * the default drain for a dated recheck one research horizon later. No ledger is
 * read: the band is regenerated from the proof on every build.
 */
export function v9ResearchedTerminalReviewState(
  proof: V9FactGapV3["causeProof"],
  reviewedResearchMaxAgeSec: number,
): V9EvidenceGapReviewState | null {
  if (proof.cause !== "C" || proof.assertion !== "researched-nondisclosure") return null;
  const reviewedAtSec = Math.floor(parseIsoDateOrUtcInstantSec(proof.reviewedAt));
  if (!Number.isFinite(reviewedAtSec)) {
    throw new Error("A researched-nondisclosure proof must carry a parseable review date");
  }
  return {
    state: "researched-terminal",
    reviewedAtSec,
    recheckAtSec: reviewedAtSec + reviewedResearchMaxAgeSec,
    trigger: "cause-proof-expiry",
  };
}

function reviewStateForGap(
  gap: V9FactGapV3,
  policy: V9ValidatedPolicyEnvelope,
  documentation: V9EvidenceGapDocumentation | null,
): V9EvidenceGapReviewState | null {
  // Precedence documentation > issuer: a documentation datum never joins the
  // issuer band, so the two bands partition the queue.
  if (documentation !== null) return null;
  return v9ResearchedTerminalReviewState(
    gap.causeProof,
    policy.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec,
  );
}

function queueKey(asset: V9AssetFactsV3, gap: V9FactGapV3): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN_V3,
      gap: {
        assetId: asset.assetId,
        gapId: gap.gapId,
        reasonCode: gap.reasonCode,
        ownerDomain: gap.ownerDomain,
        policyRuleId: gap.policyRuleId,
        responsibility: gap.responsibility,
        cause: gap.causeProof.cause,
        causeScope: gap.causeScope ?? null,
        path: gap.path,
      },
    }),
  );
}

function severityRank(value: V9EvidenceGapQueueEntryV2["releaseSeverity"]): number {
  return value === "release-blocker" ? 0 : value === "review-required" ? 1 : 2;
}

function priorityWeight(entry: Omit<V9EvidenceGapQueueEntryV2, "priority">): number {
  return entry.supplyWeight.materialityWeightedUsd ?? entry.supplyWeight.canonicalUsd ?? -1;
}

function comparePriority(
  left: Omit<V9EvidenceGapQueueEntryV2, "priority">,
  right: Omit<V9EvidenceGapQueueEntryV2, "priority">,
): number {
  return (
    severityRank(left.releaseSeverity) - severityRank(right.releaseSeverity) ||
    priorityWeight(right) - priorityWeight(left) ||
    compareText(left.ownerDomain, right.ownerDomain) ||
    compareText(left.assetId, right.assetId) ||
    compareText(left.gapId, right.gapId)
  );
}

function countBy<T extends string>(values: readonly T[]): Array<{ key: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => compareText(left.key, right.key));
}

function computeV9EvidenceGapQueueV1Digest(core: V9EvidenceGapQueueCoreV1): string {
  const parsed = V9EvidenceGapQueueCoreV1Schema.parse(core);
  return sha256Hex(stableJsonStringifyV1({ domain: V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V1, queue: parsed }));
}

function computeV9EvidenceGapQueueV2Digest(core: V9EvidenceGapQueueCoreV2): string {
  const parsed = V9EvidenceGapQueueCoreV2Schema.parse(core);
  return sha256Hex(stableJsonStringifyV1({ domain: V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V3, queue: parsed }));
}

function computeV9EvidenceGapQueueV3Digest(core: V9EvidenceGapQueueCoreV3): string {
  const parsed = V9EvidenceGapQueueCoreV3Schema.parse(core);
  return sha256Hex(stableJsonStringifyV1({ domain: V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V4, queue: parsed }));
}

function assertQueueDigest(queueDigest: string, expected: string): void {
  if (queueDigest !== expected) {
    throw new Error(`Safety Score v9 evidence-gap queue digest ${queueDigest} does not match ${expected}`);
  }
}

export function parseV9EvidenceGapQueue(input: unknown): V9EvidenceGapQueue {
  const schemaVersion =
    input !== null && typeof input === "object" ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (schemaVersion === 1) {
    const parsed = V9EvidenceGapQueueV1Schema.parse(input);
    const { queueDigest, ...core } = parsed;
    assertQueueDigest(queueDigest, computeV9EvidenceGapQueueV1Digest(core));
    return parsed;
  }
  if (schemaVersion === 3) {
    const parsed = V9EvidenceGapQueueV2Schema.parse(input);
    const { queueDigest, ...core } = parsed;
    assertQueueDigest(queueDigest, computeV9EvidenceGapQueueV2Digest(core));
    return parsed;
  }
  if (schemaVersion === 4) {
    const parsed = V9EvidenceGapQueueV3Schema.parse(input);
    const { queueDigest, ...core } = parsed;
    assertQueueDigest(queueDigest, computeV9EvidenceGapQueueV3Digest(core));
    return parsed;
  }
  throw new Error(`Unsupported Safety Score v9 evidence-gap queue schema version: ${String(schemaVersion)}`);
}

/**
 * The default worklists and sweeps skip documentation work unless they opt in
 * (`--include-documentation`). The band is counted, never closable by the
 * default drain, and no entry is ever dropped from the queue.
 */
export function isV9DocumentationGapEntry(entry: V9EvidenceGapQueueEntryV3): boolean {
  return entry.documentation !== null;
}

/** The issuer researched-terminal band: dated rechecks, not open work. */
export function isV9ResearchedTerminalEntry(entry: V9EvidenceGapQueueEntryV3): boolean {
  return entry.reviewState !== null;
}

/** Build a proof-aware policy-backed work queue from schema-4 facts. */
export function buildV9EvidenceGapQueue(args: {
  factSet: unknown;
  policy: V9ValidatedPolicyEnvelope;
}): Readonly<V9EvidenceGapQueueV3> {
  const factSetRead = readCompiledV9FactSetForEvaluation(args.factSet);
  const factSet = factSetRead.factSet;
  assertV9ValidatedPolicyEnvelope(args.policy);
  const materiality = args.policy.policy.semantic.materiality;
  const materialShareThreshold = materiality.deploymentMaterialSharePct / 100;
  const unordered = factSet.assets.flatMap((asset) => {
    const applicabilityByGap = new Map<string, V9FactApplicability["state"]>();
    for (const { status } of factStatuses(asset)) {
      for (const gapId of status.gapIds) {
        const previous = applicabilityByGap.get(gapId);
        const state = status.applicability.state;
        applicabilityByGap.set(gapId,
          previous === "not-applicable" || state === "not-applicable" ? "not-applicable"
            : previous === "unresolved" || state === "unresolved" ? "unresolved" : "required");
      }
    }
    const evidenceById = new Map(asset.evidence.map((evidence) => [evidence.evidenceId, evidence]));
    const currentSupplyEvidence = asset.supply.status.evidenceRefIds.every((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      return evidence?.disposition !== "rejected" && evidence?.freshness.state === "current";
    });
    // One join evaluation per asset, shared by every bridge-scoped gap on it.
    let assetBridgeJoin: V9EvidenceGapBridgeJoinV1 | null = null;
    const bridgeJoin = (): V9EvidenceGapBridgeJoinV1 =>
      (assetBridgeJoin ??= bridgeJoinForAsset(
        asset, materialShareThreshold, materiality.commonModeShareThreshold,
        materiality.unresolvedDeploymentFullCeilingSharePct / 100,
      ));
    return asset.gaps.map((gap) => {
      const reasonPolicy = resolveV9ReasonTreatment(args.policy, gap.reasonCode, gap.causeProof.cause);
      const policyBindingIssues: V9EvidenceGapPolicyBindingIssue[] = [];
      if (reasonPolicy.reason.ownerDomain !== gap.ownerDomain) {
        policyBindingIssues.push("fact-owner-domain-mismatch");
      }
      if (
        !reasonPolicy.reason.pathKinds.includes("*") &&
        !reasonPolicy.reason.pathKinds.includes(gap.path.kind)
      ) {
        policyBindingIssues.push("path-kind-not-permitted");
      }
      if (
        asset.archetype !== "unresolved" &&
        !reasonPolicy.reason.archetypes.includes("*") &&
        !reasonPolicy.reason.archetypes.includes(asset.archetype)
      ) {
        policyBindingIssues.push("archetype-not-permitted");
      }
      policyBindingIssues.sort(compareText);
      const applicability = gapApplicability(applicabilityByGap, gap);
      const materiality = materialityForGap(asset, gap);
      const documentation = documentationForGap(args.policy, asset, gap);
      const entry = {
        queueKey: queueKey(asset, gap),
        assetId: asset.assetId,
        archetype: asset.archetype,
        gapId: gap.gapId,
        reasonCode: gap.reasonCode,
        ownerDomain: reasonPolicy.reason.ownerDomain,
        factOwnerDomain: gap.ownerDomain,
        policyBindingIssues,
        policyRuleId: gap.policyRuleId,
        applicability,
        observationState: gap.observationState,
        path: gap.path,
        materiality,
        supplyWeight: supplyWeightForGap(asset, materiality, currentSupplyEvidence),
        action: actionForGap(gap, applicability, policyBindingIssues),
        releaseSeverity: reasonPolicy.reason.releaseSeverity,
        auditClassification: reasonPolicy.reason.auditClassification,
        treatment: reasonPolicy.treatment,
        critical: reasonPolicy.critical,
        publicLabel: reasonPolicy.reason.publicLabel,
        message: gap.message,
        evidenceRefIds: gap.evidenceRefIds,
        responsibility: gap.responsibility,
        cause: gap.causeProof.cause,
        causeProof: gap.causeProof,
        causeScope: gap.causeScope ?? null,
        causeGapIds: [gap.gapId],
        bridgeJoin: gapIsBridgeScoped(asset, gap) ? bridgeJoin() : null,
        documentation,
        reviewState: reviewStateForGap(gap, args.policy, documentation),
      } satisfies Omit<V9EvidenceGapQueueEntryV3, "priority">;
      return entry;
    });
  });
  const entries = unordered.sort(comparePriority).map((entry, index) => ({ ...entry, priority: index + 1 }));
  const domainCounts = countBy(entries.map((entry) => entry.ownerDomain)).map(({ key, count }) => ({
    domain: key,
    count,
  }));
  const actionCounts = countBy(entries.map((entry) => entry.action)).map(({ key, count }) => ({
    action: key,
    count,
  }));
  const responsibilityCounts = [...V9EvidenceResponsibilitySchema.options]
    .sort(compareText)
    .map((responsibility) => ({
      responsibility,
      count: entries.filter((entry) => entry.responsibility === responsibility).length,
    }));
  const documentationReasonCounts = V9DocumentationReasonSchema.options.map((reason) => ({
    reason,
    count: entries.filter((entry) => entry.documentation?.reason === reason).length,
  }));
  const core = V9EvidenceGapQueueCoreV3Schema.parse({
    schemaVersion: 4,
    purpose: "evidence-work-queue-not-release-gate",
    status: entries.length === 0 ? "clear" : "work-required",
    facts: {
      sourceSchemaVersion: 4,
      sourceFactSetDigest: factSetRead.sourceFactSetDigest,
      evaluationFactSetDigest: factSet.v9FactSetDigest,
      baseInputGenerationId: factSet.baseInputGenerationId,
      asOfSec: factSet.asOfSec,
      compiledAtSec: factSet.compiledAtSec,
    },
    policy: { policyId: args.policy.policy.policyId, semanticDigest: args.policy.semanticDigest },
    summary: {
      activeAssetCount: factSet.activeAssetIds.length,
      affectedAssetCount: new Set(entries.map((entry) => entry.assetId)).size,
      gapCount: entries.length,
      criticalGapCount: entries.filter((entry) => entry.critical).length,
      releaseBlockerGapCount: entries.filter((entry) => entry.releaseSeverity === "release-blocker").length,
      reviewRequiredGapCount: entries.filter((entry) => entry.releaseSeverity === "review-required").length,
      diagnosticGapCount: entries.filter((entry) => entry.releaseSeverity === "diagnostic").length,
      policyBindingMismatchGapCount: entries.filter((entry) => entry.policyBindingIssues.length > 0).length,
      knownSupplyWeightGapCount: entries.filter((entry) => entry.supplyWeight.state === "current-valid").length,
      unavailableSupplyWeightGapCount: entries.filter((entry) => entry.supplyWeight.state === "unavailable").length,
      domainCounts,
      actionCounts,
      responsibilityCounts,
      documentationGapCount: entries.filter(isV9DocumentationGapEntry).length,
      researchedTerminalGapCount: entries.filter(isV9ResearchedTerminalEntry).length,
      documentationReasonCounts,
    },
    entries,
  });
  return deepFreeze(
    V9EvidenceGapQueueV3Schema.parse({ ...core, queueDigest: computeV9EvidenceGapQueueV3Digest(core) }),
  );
}
