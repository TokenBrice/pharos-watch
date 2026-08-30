import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { readCompiledV9FactSetForEvaluation } from "@shared/lib/safety-score-v9/facts";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import {
  V9EvidenceGapQueueV2Schema,
  type V9EvidenceGapQueueEntryV2,
} from "@shared/types/safety-score-v9-evidence-queue";
import { SafetyScoreV9ResponseSchema, type SafetyScoreV9Card } from "@shared/types/safety-score-v9-public";
import { loadPerCoinStablecoinEntries, type StablecoinSourceEntry } from "../lib/stablecoin-catalog-sources";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeJsonOutput,
} from "../lib/cli-args.mjs";
import {
  descriptorForReason,
  V9_MISSING_DATA_WORK_TYPES,
  workTypeForDescriptor,
  type ResolutionMode,
  type WorkType,
  type WorkTypeDefinition,
} from "../lib/safety-score-v9-missing-data-work-types";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-missing-data-registry.ts [options]

Options:
  --replay <path>         Exact Safety Score v9 replay JSON (required)
  --policy <path>         Explicit V9 methodology policy JSON (required)
  --output <path>         Agent-oriented missing-data registry JSON (required)
  -h, --help              Show this help`;

const ReplayArtifactSchema = z
  .object({
    pipeline: z
      .object({
        candidate: SafetyScoreV9ResponseSchema,
        compiledFacts: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

export type V9MissingDataWorkType = WorkType;
export type V9MissingDataResolutionMode = ResolutionMode;
export type { WorkTypeDefinition };

const WORK_TYPES = V9_MISSING_DATA_WORK_TYPES;


export function workTypeDefinition(workType: V9MissingDataWorkType): Readonly<WorkTypeDefinition> {
  const {
    title,
    stream,
    instructions,
    completionCriteria,
    recommendedSkill,
    likelyRepoAreas,
    cautions,
  } = WORK_TYPES[workType];
  return { title, stream, instructions, completionCriteria, recommendedSkill, likelyRepoAreas, cautions };
}

const WORK_TYPE_DEFINITIONS: Record<V9MissingDataWorkType, WorkTypeDefinition> = Object.fromEntries(
  (Object.keys(WORK_TYPES) as V9MissingDataWorkType[]).map((workType) => [workType, workTypeDefinition(workType)]),
) as Record<V9MissingDataWorkType, WorkTypeDefinition>;

export function classifyV9MissingDataWorkType(
  entry: Pick<V9EvidenceGapQueueEntryV2, "reasonCode" | "path">,
): V9MissingDataWorkType {
  return workTypeForDescriptor(descriptorForReason(entry.reasonCode, entry.path));
}

export function classifyV9ScoreProjectionWorkType(reasonCode: string): V9MissingDataWorkType | null {
  try {
    return workTypeForDescriptor(descriptorForReason(reasonCode));
  } catch {
    return null;
  }
}

/**
 * Archetypes whose mechanism components are curated directly from issuer
 * disclosure under the ratified strict evidence standard, rather than waiting
 * on a measured-metric producer capability.
 */
const DIRECT_CURATION_MECHANISM_ARCHETYPES: ReadonlySet<string> = new Set([
  "fiat-cash",
  "tbill",
  "commodity-claim",
]);

export function mechanismResolutionMode(
  entry: Pick<V9EvidenceGapQueueEntryV2, "archetype" | "path">,
): V9MissingDataResolutionMode {
  // Wave-7 D3 ratified direct overlay curation for every fiat-cash and
  // T-bill mechanism component under the strict evidence standard. v9.14 adds
  // commodity-claim, whose components are curated from the same class of
  // issuer disclosure (bar lists, vault terms, redemption terms).
  if (DIRECT_CURATION_MECHANISM_ARCHETYPES.has(entry.archetype)) return "agent-curation";
  return "issuer-or-onchain-evidence";
}

function resolutionModeFor(
  workType: V9MissingDataWorkType,
  entry: V9EvidenceGapQueueEntryV2,
  context: unknown,
): V9MissingDataResolutionMode {
  // Mechanism review resists a static default: ratified disclosure-backed
  // archetypes intentionally take the direct-curation lane.
  if (workType === "MECHANISM_REVIEW") return mechanismResolutionMode(entry);
  if (workType === "EXIT_OUTPUT") {
    const lane = typeof context === "object" && context !== null && "lane" in context ? context.lane : null;
    return lane === "dex" ? "producer-runtime" : "agent-curation";
  }
  return WORK_TYPES[workType].defaultResolutionMode;
}

function evidenceAction(entry: V9EvidenceGapQueueEntryV2, mode: V9MissingDataResolutionMode): string {
  if (entry.responsibility === "issuer-undisclosed") return "obtain-issuer-or-onchain-disclosure";
  if (entry.responsibility === "integration-missing") return "repair-fact-integration";
  if (entry.responsibility === "producer-failed") return "repair-or-refresh-producer";
  if (entry.responsibility === "method-unsupported") return "define-reviewed-methodology-capability";
  if (entry.responsibility === "measured-adverse") return "adjudicate-measured-adverse-evidence";
  if (mode === "producer-runtime") return "implement-or-refresh-producer-capability";
  if (mode === "mixed-curation-and-runtime") return "reconcile-metadata-then-refresh-producer";
  if (mode === "methodology-capability") return "define-reviewed-methodology-capability";
  if (mode === "issuer-or-onchain-evidence") return "obtain-measured-source-evidence-then-curate";
  if (entry.observationState === "missing") return "collect-and-curate-evidence";
  if (entry.observationState === "stale") return "refresh-and-curate-evidence";
  if (entry.observationState === "unsupported") return "implement-supported-evidence-path";
  return "adjudicate-and-curate-bounded-unknown";
}

export function scoreProjectionResolutionMode(
  workType: V9MissingDataWorkType,
  archetype: V9EvidenceGapQueueEntryV2["archetype"],
): V9MissingDataResolutionMode {
  // See resolutionModeFor: mechanism review is the one archetype-dependent
  // resolution policy in this taxonomy.
  if (workType === "MECHANISM_REVIEW") {
    return DIRECT_CURATION_MECHANISM_ARCHETYPES.has(archetype) ? "agent-curation" : "issuer-or-onchain-evidence";
  }
  return WORK_TYPES[workType].defaultResolutionMode;
}

function scoreProjectionAction(mode: V9MissingDataResolutionMode): string {
  if (mode === "producer-runtime") return "implement-or-refresh-producer-capability";
  if (mode === "mixed-curation-and-runtime") return "reconcile-metadata-then-refresh-producer";
  if (mode === "methodology-capability") return "define-reviewed-methodology-capability";
  if (mode === "issuer-or-onchain-evidence") return "obtain-measured-source-evidence-then-curate";
  return "adjudicate-and-curate-score-projection";
}


function collectEvidenceRefIds(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectEvidenceRefIds(entry, output);
    return output;
  }
  if (typeof value !== "object" || value === null) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidenceRefIds" && Array.isArray(entry)) {
      for (const evidenceRefId of entry) if (typeof evidenceRefId === "string") output.add(evidenceRefId);
      continue;
    }
    collectEvidenceRefIds(entry, output);
  }
  return output;
}

interface ScoreProjectionReason {
  reasonCode: string;
  message: string;
  path: string | null;
  source: string;
  workType: V9MissingDataWorkType;
}

function scoreProjectionReasons(card: SafetyScoreV9Card): ScoreProjectionReason[] {
  const reasons: ScoreProjectionReason[] = [];
  for (const pillar of ["backing", "exit", "control"] as const) {
    for (const reason of card.pillars[pillar].reasons) {
      const workType = classifyV9ScoreProjectionWorkType(reason.code);
      if (workType) reasons.push({ ...reason, reasonCode: reason.code, source: `pillar:${pillar}`, workType });
    }
  }
  for (const reason of card.nrReasons) {
    const workType = classifyV9ScoreProjectionWorkType(reason.code);
    if (workType) {
      reasons.push({
        reasonCode: reason.code,
        message: reason.message,
        path: reason.field,
        source: "nr-reason",
        workType,
      });
    }
  }
  const detailedCodes = new Set(reasons.map((reason) => reason.reasonCode));
  for (const reasonCode of card.reasonCodes) {
    const workType = classifyV9ScoreProjectionWorkType(reasonCode);
    if (!workType || detailedCodes.has(reasonCode)) continue;
    const cap = card.caps.find((entry) => entry.kind === `reason:${reasonCode}`);
    reasons.push({
      reasonCode,
      message: cap?.reason ?? reasonCode,
      path: null,
      source: "card-aggregate",
      workType,
    });
  }
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.reasonCode}|${reason.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreProjectionObservationState(reasonCode: string): string {
  if (reasonCode.startsWith("missing") || reasonCode === "insufficient-evidence") return "missing";
  if (reasonCode.startsWith("unsupported")) return "unsupported";
  return "bounded-unknown";
}

function scoreProjectionTaskDigest(assetId: string, reason: ScoreProjectionReason): string {
  return createHash("sha256")
    .update(JSON.stringify({ assetId, reasonCode: reason.reasonCode, path: reason.path }))
    .digest("hex");
}

function priorityBand(critical: boolean, supplyUsd: number | null): string {
  if (critical || (supplyUsd ?? 0) >= 1_000_000_000) return "P0";
  if ((supplyUsd ?? 0) >= 100_000_000) return "P1";
  if ((supplyUsd ?? 0) >= 10_000_000) return "P2";
  return "P3";
}

export function likelyTouchpoints(
  workType: V9MissingDataWorkType,
  source: Pick<StablecoinSourceEntry, "file" | "sidecarFiles">,
  context: unknown,
): string[] {
  return [...WORK_TYPES[workType].touchpoints(source, context)];
}

function countBy<T>(values: readonly T[], keyOf: (value: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function cardScoreProjection(card: SafetyScoreV9Card) {
  return {
    grade: card.grade,
    score: card.score,
    qualityScore: card.qualityScore,
    pegMultiplier: card.pegMultiplier,
    pegAdjustedScore: card.pegAdjustedScore,
    weakestPillar: card.weakestPillar,
    pillars: card.pillars,
    aggregateReasonCodes: card.reasonCodes,
    nrReasons: card.nrReasons,
    evidence: card.evidence,
    evidenceCaps: card.caps.filter((cap) => cap.source === "evidence"),
    bindingCap: card.bindingCap,
  };
}

export interface GenerateV9MissingDataRegistryInput {
  replay: unknown;
  policy: unknown;
  catalogEntries: StablecoinSourceEntry[];
}

export function generateV9MissingDataRegistry(input: GenerateV9MissingDataRegistryInput) {
  const replay = ReplayArtifactSchema.parse(input.replay).pipeline;
  const factSetRead = readCompiledV9FactSetForEvaluation(replay.compiledFacts);
  const facts = factSetRead.factSet;
  const queue = V9EvidenceGapQueueV2Schema.parse(
    buildV9EvidenceGapQueue({ factSet: replay.compiledFacts, policy: loadV9MethodologyPolicy(input.policy) }),
  );
  const candidate = replay.candidate;
  const candidateFactSetDigest = facts.v9FactSetDigest;
  if (
    candidate.factSetDigest !== candidateFactSetDigest ||
    candidate.baseInputGenerationId !== facts.baseInputGenerationId ||
    candidate.policy.id !== queue.policy.policyId ||
    candidate.policy.semanticDigest !== queue.policy.semanticDigest
  ) {
    throw new Error("Replay candidate, compiled facts, and policy do not share the same immutable bindings");
  }

  const factById = new Map(facts.assets.map((asset) => [asset.assetId, asset]));
  const cardById = new Map(candidate.cards.map((card) => [card.id, card]));
  const sourceById = new Map(input.catalogEntries.map((entry) => [entry.id, entry]));
  const entriesById = new Map<string, V9EvidenceGapQueueEntryV2[]>();
  for (const entry of queue.entries) {
    const existing = entriesById.get(entry.assetId) ?? [];
    existing.push(entry);
    entriesById.set(entry.assetId, existing);
  }

  const allItems: Array<{
    workType: V9MissingDataWorkType;
    resolutionMode: V9MissingDataResolutionMode;
    claimGroupId: string;
    taskSource: "compiled-fact-gap" | "score-projection-gap";
  }> = [];
  const stablecoins = facts.activeAssetIds.map((assetId) => {
    const asset = factById.get(assetId);
    const card = cardById.get(assetId);
    const source = sourceById.get(assetId);
    if (!asset || !card || !source)
      throw new Error(`Missing fact, card, or catalog source for active asset ${assetId}`);
    const openEntries = entriesById.get(assetId) ?? [];
    const supplyUsd = asset.supply.circulatingUsd;
    const factItems = openEntries.map((entry) => {
      const descriptor = descriptorForReason(entry.reasonCode, entry.path);
      const workType = workTypeForDescriptor(descriptor);
      const context = descriptor.context(asset);
      const resolutionMode = resolutionModeFor(workType, entry, context);
      const claimGroupId = `${workType}:${assetId}`;
      allItems.push({ workType, resolutionMode, claimGroupId, taskSource: "compiled-fact-gap" });
      const existingEvidence = entry.evidenceRefIds.map(
        (evidenceRefId) =>
          asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId) ?? {
            evidenceId: evidenceRefId,
            unresolvedReference: true,
          },
      );
      return {
        taskSource: "compiled-fact-gap" as const,
        taskId: `V9G-${entry.queueKey.slice(0, 16)}`,
        claimGroupId,
        status: "open",
        globalPriority: entry.priority,
        priorityBand: priorityBand(entry.critical, entry.supplyWeight.canonicalUsd),
        workType,
        resolutionMode,
        recommendedEvidenceAction: evidenceAction(entry, resolutionMode),
        gapId: entry.gapId,
        queueKey: entry.queueKey,
        reasonCode: entry.reasonCode,
        message: entry.message,
        publicLabel: entry.publicLabel,
        ownerDomain: entry.ownerDomain,
        factOwnerDomain: entry.factOwnerDomain,
        policyRuleId: entry.policyRuleId,
        responsibility: entry.responsibility,
        applicability: entry.applicability,
        observationState: entry.observationState,
        path: entry.path,
        materiality: entry.materiality,
        supplyWeight: entry.supplyWeight,
        releaseSeverity: entry.releaseSeverity,
        treatment: entry.treatment,
        critical: entry.critical,
        likelyTouchpoints: likelyTouchpoints(workType, source, context),
        currentFactContext: context,
        existingEvidence,
        policyBinding: {
          queueAction: entry.action,
          issues: entry.policyBindingIssues,
          coordinatorReviewRequired: entry.policyBindingIssues.length > 0,
          note:
            entry.policyBindingIssues.length > 0
              ? "This queue-contract mismatch is separate from the evidence task; complete the recommendedEvidenceAction and route the binding issue to the v9 policy maintainer."
              : null,
        },
        doneWhenGapIdAbsent: entry.gapId,
        doneWhenScoreReasonAbsent: null,
      };
    });
    const projections = scoreProjectionReasons(card);
    const factStreams = new Set(factItems.map((item) => WORK_TYPES[item.workType].stream));
    const supplementalItems = projections
      .filter((reason) => !factStreams.has(WORK_TYPES[reason.workType].stream))
      .map((reason) => {
        const workType = reason.workType;
        const descriptor = WORK_TYPES[workType];
        const context = descriptor.context(asset);
        const resolutionMode = scoreProjectionResolutionMode(workType, asset.archetype);
        // A card-aggregate reason exposes no component identity (wave-7
        // anomaly class: krwq/eur0): curation lanes cannot act on it without
        // inventing a component, so it routes to the coordinator instead.
        const componentIdentityUnavailable = reason.source === "card-aggregate" && reason.path === null;
        const claimGroupId = `${workType}:${assetId}`;
        const digest = scoreProjectionTaskDigest(assetId, reason);
        const evidenceRefIds = [...collectEvidenceRefIds(context)].sort((left, right) => left.localeCompare(right));
        const existingEvidence = evidenceRefIds.map(
          (evidenceRefId) =>
            asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId) ?? {
              evidenceId: evidenceRefId,
              unresolvedReference: true,
            },
        );
        allItems.push({ workType, resolutionMode, claimGroupId, taskSource: "score-projection-gap" });
        return {
          taskSource: "score-projection-gap" as const,
          taskId: `V9S-${digest.slice(0, 16)}`,
          claimGroupId,
          status: "open",
          globalPriority: null,
          priorityBand: priorityBand(false, supplyUsd),
          workType,
          resolutionMode,
          recommendedEvidenceAction: scoreProjectionAction(resolutionMode),
          gapId: null,
          queueKey: null,
          reasonCode: reason.reasonCode,
          message: reason.message,
          publicLabel: reason.message,
          ownerDomain: descriptor.ownerDomain,
          factOwnerDomain: descriptor.ownerDomain,
          policyRuleId: null,
          responsibility: null,
          applicability: "required",
          observationState: scoreProjectionObservationState(reason.reasonCode),
          path: { kind: "score-projection", scorePath: reason.path },
          materiality: { basis: "asset-wide", fractionOfAsset: 1 },
          supplyWeight: {
            state: supplyUsd === null ? "unavailable" : "current-valid",
            canonicalUsd: supplyUsd,
            materialityWeightedUsd: supplyUsd,
            sourceGenerationId: asset.supply.sourceGenerationId,
          },
          releaseSeverity: null,
          treatment: "score-projection",
          critical: false,
          likelyTouchpoints: likelyTouchpoints(workType, source, context),
          currentFactContext: context,
          existingEvidence,
          policyBinding: {
            queueAction: null,
            issues: [],
            coordinatorReviewRequired: componentIdentityUnavailable,
            note: componentIdentityUnavailable
              ? "Card-aggregate bounded reason without a component identity: the coordinator resolves it against the compiled facts; curation lanes must not invent a component."
              : "The score exposes this bounded reason without a corresponding compiled fact-gap row.",
          },
          doneWhenGapIdAbsent: null,
          doneWhenScoreReasonAbsent: { reasonCode: reason.reasonCode, path: reason.path },
        };
      });
    const items = [...factItems, ...supplementalItems];
    const scoreProjectionGaps = projections.map((reason) => {
      const stream = WORK_TYPES[reason.workType].stream;
      const coveredByTaskIds = items
        .filter((item) => WORK_TYPES[item.workType].stream === stream)
        .map((item) => item.taskId);
      if (coveredByTaskIds.length === 0) {
        throw new Error(`Score projection ${assetId}:${reason.reasonCode}:${reason.path ?? ""} has no agent task`);
      }
      const digest = scoreProjectionTaskDigest(assetId, reason);
      return {
        projectionId: `V9P-${digest.slice(0, 16)}`,
        source: reason.source,
        reasonCode: reason.reasonCode,
        message: reason.message,
        path: reason.path,
        workType: reason.workType,
        stream,
        coveredByTaskIds,
        requiresSupplementalTask: coveredByTaskIds.some((taskId) => taskId.startsWith("V9S-")),
      };
    });
    const claimGroups = new Set(items.map((item) => item.claimGroupId));
    const sourceFiles = [source.file, ...(source.sidecarFiles ?? [])];
    return {
      assetId,
      name: source.coin.name,
      symbol: source.coin.symbol,
      archetype: asset.archetype,
      priorityBand: priorityBand(
        items.some((item) => item.critical),
        supplyUsd,
      ),
      canonicalSupplyUsd: supplyUsd,
      sourceFiles,
      currentScore: cardScoreProjection(card),
      missingDataSummary: {
        openItemCount: items.length,
        claimGroupCount: claimGroups.size,
        criticalItemCount: items.filter((item) => item.critical).length,
        policyBindingReviewCount: items.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
        workTypeCounts: countBy(items, (item) => item.workType),
        reasonCounts: countBy(items, (item) => item.reasonCode),
        resolutionModeCounts: countBy(items, (item) => item.resolutionMode),
        taskSourceCounts: countBy(items, (item) => item.taskSource),
      },
      scoreProjectionGaps,
      missingItems: items,
    };
  });

  stablecoins.sort((left, right) => {
    const critical = right.missingDataSummary.criticalItemCount - left.missingDataSummary.criticalItemCount;
    if (critical !== 0) return critical;
    const supply = (right.canonicalSupplyUsd ?? -1) - (left.canonicalSupplyUsd ?? -1);
    return supply !== 0 ? supply : left.assetId.localeCompare(right.assetId);
  });

  const registryItems = stablecoins.flatMap((asset) => asset.missingItems);
  const projectionRows = stablecoins.flatMap((asset) => asset.scoreProjectionGaps);
  const taskIds = registryItems.map((item) => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("Generated missing-data task IDs are not unique");
  const claimGroupCount = new Set(allItems.map((item) => item.claimGroupId)).size;
  return {
    schemaVersion: 1,
    title: "Safety Score v9 missing-data registry",
    purpose: "agent-checklist-for-full-evidence-scoring",
    snapshot: {
      asOfSec: candidate.asOfSec,
      asOfIso: new Date(candidate.asOfSec * 1000).toISOString(),
      publishedAtSec: candidate.publishedAtSec,
      candidateId: candidate.candidateId,
      publicationGenerationId: candidate.publicationGenerationId,
      baseInputGenerationId: candidate.baseInputGenerationId,
      factSetDigest: candidate.factSetDigest,
      sourceFactSetSchemaVersion: factSetRead.sourceSchemaVersion,
      sourceFactSetDigest: factSetRead.sourceFactSetDigest,
      evaluationFactSetDigest: facts.v9FactSetDigest,
      resultDigest: candidate.resultDigest,
      queueDigest: queue.queueDigest,
      policyId: candidate.policy.id,
      policyDigest: candidate.policy.semanticDigest,
      evaluationBuildDigest: candidate.evaluationBuildDigest,
    },
    interpretation: {
      fullEvidenceDefinition:
        "Full evidence means a fresh exact replay has no compiled v9 fact gaps or unbacked score-projection gaps for the asset. It does not mean a score of 100 or an A grade.",
      knownRiskWarning:
        "Known centralization, weak controls, poor exit capacity, reserve risk, dependencies, short history, and peg behavior continue to reduce the score after missing data is filled.",
      taskCompleteness:
        "Every compiled fact gap is represented exactly once. Every score-visible missing or bounded reason is listed under scoreProjectionGaps; a supplemental task is added when no compiled fact task covers its workstream.",
      policyBindingWarning:
        "Policy-binding issues are queue-contract defects, not substitutes for evidence work. Each affected item preserves the defect and supplies a separate evidence action.",
      responsibilityWarning:
        "Compiled fact tasks identify whether evidence is measured adverse, issuer-undisclosed, integration-missing, producer-failed, or method-unsupported. Score-projection-only tasks carry null because they have no compiled fact-gap responsibility.",
      pointInTimeWarning:
        "This registry is bound to one immutable production replay. Regenerate it after coordinated data batches; resolved task IDs disappear and new gaps receive new IDs.",
    },
    agentProtocol: {
      claim:
        "Claim the whole claimGroupId in agents/safety-score-v9/results/curation-swarm-session-*.md before work. Do not split one asset/workType group across agents.",
      collisionAvoidance:
        "Check git status immediately before editing every likelyTouchpoint. Skip files dirty from another lane and record the unresolved task IDs.",
      evidenceStandard:
        "Use primary sources, dated reviews, named reviewers, pinned explorer/RPC observations where practical, and explicit blocked findings. Never fabricate a value to clear a gap.",
      verification:
        "Run focused schema/tests for touched sources. The coordinator regenerates the catalog, captures exact inputs, replays v9, and regenerates this registry; an item is done only when its doneWhenGapIdAbsent or doneWhenScoreReasonAbsent condition is absent.",
      editPolicy:
        "Do not hand-edit generated task status. The swarm session tracks only current ownership and unresolved handoffs; durable evidence and blockers belong in reviewed source metadata. This file is regenerated from score facts.",
    },
    summary: {
      stablecoinCount: stablecoins.length,
      affectedStablecoinCount: stablecoins.filter((asset) => asset.missingItems.length > 0).length,
      rateableStablecoinCount: candidate.cards.filter((card) => card.grade !== "NR").length,
      notRatedStablecoinCount: candidate.cards.filter((card) => card.grade === "NR").length,
      openItemCount: registryItems.length,
      compiledFactItemCount: queue.entries.length,
      supplementalScoreItemCount: registryItems.filter((item) => item.taskSource === "score-projection-gap").length,
      scoreProjectionReasonCount: projectionRows.length,
      scoreProjectionReasonNeedingSupplementCount: projectionRows.filter((row) => row.requiresSupplementalTask).length,
      claimGroupCount,
      criticalItemCount: queue.entries.filter((entry) => entry.critical).length,
      policyBindingReviewCount: registryItems.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
      responsibilityCounts: queue.summary.responsibilityCounts,
      observationStateCounts: countBy(registryItems, (entry) => entry.observationState),
      gradeCounts: countBy(candidate.cards, (card) => card.grade),
      workTypeCounts: countBy(allItems, (item) => item.workType),
      reasonCounts: countBy(registryItems, (entry) => entry.reasonCode),
      resolutionModeCounts: countBy(allItems, (item) => item.resolutionMode),
      ownerDomainCounts: countBy(registryItems, (entry) => entry.ownerDomain),
      taskSourceCounts: countBy(allItems, (item) => item.taskSource),
    },
    workTypeDefinitions: WORK_TYPE_DEFINITIONS,
    stablecoins,
  };
}

interface RegistryIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: RegistryIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: writeJsonOutput,
  stdout: process.stdout,
};

export function runV9MissingDataRegistryCli(argv: readonly string[], io: RegistryIo = DEFAULT_IO) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      replay: { type: "string" },
      policy: { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  const replayPath = requireCliString(values.replay, "--replay");
  const policyPath = requireCliString(values.policy, "--policy");
  const outputPath = requireCliString(values.output, "--output");

  const registry = generateV9MissingDataRegistry({
    replay: io.readJson(replayPath),
    policy: io.readJson(policyPath),
    catalogEntries: loadPerCoinStablecoinEntries(),
  });
  io.writeText(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  io.stdout.write(
    `Wrote ${registry.summary.openItemCount} missing-data items for ${registry.summary.stablecoinCount} stablecoins to ${outputPath}\n`,
  );
  return registry;
}

runDirectCli(import.meta.url, () => runV9MissingDataRegistryCli(process.argv.slice(2)), {
  label: "safety-score-v9:missing-data-registry",
  usage: USAGE,
});
