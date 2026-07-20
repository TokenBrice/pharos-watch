import {
  V9EvidenceGapQueueCoreV1Schema,
  V9EvidenceGapQueueV1Schema,
  type V9EvidenceGapAction,
  type V9EvidenceGapMaterialityV1,
  type V9EvidenceGapPolicyBindingIssue,
  type V9EvidenceGapQueueCoreV1,
  type V9EvidenceGapQueueEntryV1,
  type V9EvidenceGapQueueV1,
  type V9EvidenceGapSupplyWeightV1,
} from "../../types/safety-score-v9-evidence-queue";
import {
  isUsdDenominatedSupplyKind,
  type CompiledV9FactSetV2,
  type V9AssetFactsV2,
  type V9FactGapV2,
  type V9FactStatusV2,
} from "../../types/safety-score-v9-facts";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { parseCompiledV9FactSetV2 } from "./facts";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";

const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN = "safety-score-v9.evidence-gap-queue.v1";
const V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN = "safety-score-v9.evidence-gap-key.v1";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function statusesForAsset(asset: V9AssetFactsV2): V9FactStatusV2[] {
  const mechanismStatuses = asset.mechanismRiskReview.review
    ? Object.values(asset.mechanismRiskReview.review).flatMap((value) =>
        value !== null && typeof value === "object" && "status" in value
          ? [(value as { status: V9FactStatusV2 }).status]
          : [],
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

function gapApplicability(asset: V9AssetFactsV2, gap: V9FactGapV2): "required" | "unresolved" {
  const references = statusesForAsset(asset).filter((status) => status.gapIds.includes(gap.gapId));
  if (references.length === 0) throw new Error(`Safety Score v9 gap ${gap.gapId} is not referenced by a fact status`);
  const states = [...new Set(references.map((status) => status.applicability.state))];
  if (states.includes("not-applicable")) {
    throw new Error(`Safety Score v9 gap ${gap.gapId} is attached to a reviewed not-applicable fact`);
  }
  return states.includes("unresolved") ? "unresolved" : "required";
}

function materialityForGap(asset: V9AssetFactsV2, gap: V9FactGapV2): V9EvidenceGapMaterialityV1 {
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
  asset: V9AssetFactsV2,
  materiality: V9EvidenceGapMaterialityV1,
): V9EvidenceGapSupplyWeightV1 {
  const canonicalUsd = asset.supply.circulatingUsd;
  const evidenceById = new Map(asset.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const currentEvidence = asset.supply.status.evidenceRefIds.every((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    return evidence?.disposition !== "rejected" && evidence?.freshness.state === "current";
  });
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
  gap: V9FactGapV2,
  applicability: "required" | "unresolved",
  policyBindingIssues: readonly V9EvidenceGapPolicyBindingIssue[],
): V9EvidenceGapAction {
  if (policyBindingIssues.length > 0) return "reconcile-policy-binding";
  if (gap.path.kind === "methodology" || gap.ownerDomain === "methodology") return "resolve-methodology-decision";
  if (applicability === "unresolved") return "resolve-applicability";
  if (gap.observationState === "missing") return "collect-evidence";
  if (gap.observationState === "stale") return "refresh-evidence";
  if (gap.observationState === "unsupported") return "implement-producer-capability";
  return "adjudicate-bounded-unknown";
}

function queueKey(asset: V9AssetFactsV2, gap: V9FactGapV2): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN,
      gap: {
        assetId: asset.assetId,
        gapId: gap.gapId,
        reasonCode: gap.reasonCode,
        ownerDomain: gap.ownerDomain,
        policyRuleId: gap.policyRuleId,
        path: gap.path,
      },
    }),
  );
}

function severityRank(value: V9EvidenceGapQueueEntryV1["releaseSeverity"]): number {
  return value === "release-blocker" ? 0 : value === "review-required" ? 1 : 2;
}

function priorityWeight(entry: Omit<V9EvidenceGapQueueEntryV1, "priority">): number {
  return entry.supplyWeight.materialityWeightedUsd ?? entry.supplyWeight.canonicalUsd ?? -1;
}

function comparePriority(
  left: Omit<V9EvidenceGapQueueEntryV1, "priority">,
  right: Omit<V9EvidenceGapQueueEntryV1, "priority">,
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

function computeV9EvidenceGapQueueDigest(core: V9EvidenceGapQueueCoreV1): string {
  const parsed = V9EvidenceGapQueueCoreV1Schema.parse(core);
  return sha256Hex(stableJsonStringifyV1({ domain: V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN, queue: parsed }));
}

export function parseV9EvidenceGapQueue(input: unknown): V9EvidenceGapQueueV1 {
  const parsed = V9EvidenceGapQueueV1Schema.parse(input);
  const { queueDigest, ...core } = parsed;
  const expected = computeV9EvidenceGapQueueDigest(core);
  if (queueDigest !== expected) {
    throw new Error(`Safety Score v9 evidence-gap queue digest ${queueDigest} does not match ${expected}`);
  }
  return parsed;
}

/** Build a policy-backed work queue directly from normalized V2 gap records. */
export function buildV9EvidenceGapQueue(args: {
  factSet: CompiledV9FactSetV2;
  policy: V9ValidatedPolicyEnvelope;
}): Readonly<V9EvidenceGapQueueV1> {
  const factSet = parseCompiledV9FactSetV2(args.factSet);
  assertV9ValidatedPolicyEnvelope(args.policy);
  const unordered = factSet.assets.flatMap((asset) =>
    asset.gaps.map((gap) => {
      const reasonPolicy = resolveV9ReasonPolicy(args.policy, gap.reasonCode);
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
      const applicability = gapApplicability(asset, gap);
      const materiality = materialityForGap(asset, gap);
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
        supplyWeight: supplyWeightForGap(asset, materiality),
        action: actionForGap(gap, applicability, policyBindingIssues),
        releaseSeverity: reasonPolicy.reason.releaseSeverity,
        auditClassification: reasonPolicy.reason.auditClassification,
        treatment: reasonPolicy.reason.defaultTreatment,
        critical: reasonPolicy.critical,
        publicLabel: reasonPolicy.reason.publicLabel,
        message: gap.message,
        evidenceRefIds: gap.evidenceRefIds,
      } satisfies Omit<V9EvidenceGapQueueEntryV1, "priority">;
      return entry;
    }),
  );
  const entries = unordered.sort(comparePriority).map((entry, index) => ({ ...entry, priority: index + 1 }));
  const domainCounts = countBy(entries.map((entry) => entry.ownerDomain)).map(({ key, count }) => ({
    domain: key,
    count,
  }));
  const actionCounts = countBy(entries.map((entry) => entry.action)).map(({ key, count }) => ({
    action: key,
    count,
  }));
  const core = V9EvidenceGapQueueCoreV1Schema.parse({
    schemaVersion: 1,
    purpose: "evidence-work-queue-not-release-gate",
    status: entries.length === 0 ? "clear" : "work-required",
    facts: {
      factSetDigest: factSet.v9FactSetDigest,
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
    },
    entries,
  });
  return deepFreeze(parseV9EvidenceGapQueue({ ...core, queueDigest: computeV9EvidenceGapQueueDigest(core) }));
}
