import {
  V9EvidenceGapQueueCoreV1Schema,
  V9EvidenceGapQueueCoreV2Schema,
  V9EvidenceGapQueueV1Schema,
  V9EvidenceGapQueueV2Schema,
  type V9EvidenceGapAction,
  type V9EvidenceGapMaterialityV1,
  type V9EvidenceGapPolicyBindingIssue,
  type V9EvidenceGapQueueCoreV1,
  type V9EvidenceGapQueueCoreV2,
  type V9EvidenceGapQueueEntryV2,
  type V9EvidenceGapQueue,
  type V9EvidenceGapQueueV2,
  type V9EvidenceGapSupplyWeightV1,
} from "../../types/safety-score-v9-evidence-queue";
import {
  isUsdDenominatedSupplyKind,
  type V9AssetFactsV3,
  type V9FactGapV3,
  type V9FactStatusV2,
} from "../../types/safety-score-v9-facts";
import { V9EvidenceResponsibilitySchema } from "../../types/safety-score-v9-fact-primitives";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { readCompiledV9FactSetForEvaluation } from "./facts";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import { compareText, deepFreeze } from "./primitives";

const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V1 = "safety-score-v9.evidence-gap-queue.v1";
const V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V2 = "safety-score-v9.evidence-gap-queue.v2";
const V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN_V2 = "safety-score-v9.evidence-gap-key.v2";

function statusesForAsset(asset: V9AssetFactsV3): V9FactStatusV2[] {
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

function gapApplicability(asset: V9AssetFactsV3, gap: V9FactGapV3): "required" | "unresolved" {
  const references = statusesForAsset(asset).filter((status) => status.gapIds.includes(gap.gapId));
  if (references.length === 0) throw new Error(`Safety Score v9 gap ${gap.gapId} is not referenced by a fact status`);
  const states = [...new Set(references.map((status) => status.applicability.state))];
  if (states.includes("not-applicable")) {
    throw new Error(`Safety Score v9 gap ${gap.gapId} is attached to a reviewed not-applicable fact`);
  }
  return states.includes("unresolved") ? "unresolved" : "required";
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
  gap: V9FactGapV3,
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

function queueKey(asset: V9AssetFactsV3, gap: V9FactGapV3): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_EVIDENCE_GAP_QUEUE_KEY_DOMAIN_V2,
      gap: {
        assetId: asset.assetId,
        gapId: gap.gapId,
        reasonCode: gap.reasonCode,
        ownerDomain: gap.ownerDomain,
        policyRuleId: gap.policyRuleId,
        responsibility: gap.responsibility,
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
  return sha256Hex(stableJsonStringifyV1({ domain: V9_EVIDENCE_GAP_QUEUE_DIGEST_DOMAIN_V2, queue: parsed }));
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
  if (schemaVersion === 2) {
    const parsed = V9EvidenceGapQueueV2Schema.parse(input);
    const { queueDigest, ...core } = parsed;
    assertQueueDigest(queueDigest, computeV9EvidenceGapQueueV2Digest(core));
    return parsed;
  }
  throw new Error(`Unsupported Safety Score v9 evidence-gap queue schema version: ${String(schemaVersion)}`);
}

/** Build a policy-backed work queue from native V3 or explicitly upgraded retained V2 facts. */
export function buildV9EvidenceGapQueue(args: {
  factSet: unknown;
  policy: V9ValidatedPolicyEnvelope;
}): Readonly<V9EvidenceGapQueueV2> {
  const factSetRead = readCompiledV9FactSetForEvaluation(args.factSet);
  const factSet = factSetRead.factSet;
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
        responsibility: gap.responsibility,
      } satisfies Omit<V9EvidenceGapQueueEntryV2, "priority">;
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
  const responsibilityCounts = [...V9EvidenceResponsibilitySchema.options]
    .sort(compareText)
    .map((responsibility) => ({
      responsibility,
      count: entries.filter((entry) => entry.responsibility === responsibility).length,
    }));
  const core = V9EvidenceGapQueueCoreV2Schema.parse({
    schemaVersion: 2,
    purpose: "evidence-work-queue-not-release-gate",
    status: entries.length === 0 ? "clear" : "work-required",
    facts: {
      sourceSchemaVersion: factSetRead.sourceSchemaVersion,
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
    },
    entries,
  });
  return deepFreeze(
    V9EvidenceGapQueueV2Schema.parse({ ...core, queueDigest: computeV9EvidenceGapQueueV2Digest(core) }),
  );
}
