import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import {
  buildV9EvidenceGapQueue,
} from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { classifyV9DocumentationGap } from "@shared/lib/safety-score-v9/documentation";
import {
  questionKeyForGap,
  residualQuestionKey,
  v9QuestionRootAssetId,
} from "@shared/lib/safety-score-v9/open-questions";
import { readCompiledV9FactSetForEvaluation } from "@shared/lib/safety-score-v9/facts";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { reviewAdmissionSec } from "@shared/types/date-primitives";
import { V9DocumentationReasonSchema } from "@shared/types/safety-score-v9";
import {
  V9EvidenceGapQueueV3Schema,
  type V9EvidenceGapDocumentation,
  type V9EvidenceGapQueueEntryV3,
} from "@shared/types/safety-score-v9-evidence-queue";
import {
  SafetyScoreV9PreviousResponseSchema,
  SafetyScoreV9ResponseSchema,
  type SafetyScoreV9Card,
} from "@shared/types/safety-score-v9-public";
import { loadPerCoinStablecoinEntries, type StablecoinSourceEntry } from "../lib/stablecoin-catalog-sources";
import {
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeCliHelpIfRequested,
  writeJsonOutput,
} from "../lib/cli-args.mjs";
import {
  curationDispositionForReason,
  descriptorForReason,
  priorityBand,
  resolutionModeAction,
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

/**
 * The evaluated reasons the score published. DEB-4's supplement dedupe joins a
 * card projection back to its causal compiled task through `sourceGapId` /
 * `causeGapIds`; the registry build now fails closed on a replay that cannot
 * supply them (or on an evaluated asset missing from the candidate).
 */
const ReplayPillarReasonSchema = z
  .object({
    code: z.string().min(1),
    // The causal path is the public join key: the card path replaces only the
    // `:cause:` suffix with a table reference.
    path: z.string().optional(),
    cause: z.enum(["A", "B", "C", "U", "D"]).nullable().optional(),
    causeGapIds: z.array(z.string().min(1)).optional(),
    sourceGapId: z.string().min(1).optional(),
  })
  .passthrough();
type ReplayPillarReason = z.infer<typeof ReplayPillarReasonSchema>;

const ReplayPillarReasonsSchema = z
  .object({ reasons: z.array(ReplayPillarReasonSchema) })
  .passthrough();

const ReplayEvaluatedAssetSchema = z
  .object({
    assetId: z.string().min(1),
    scoreInput: z
      .object({
        pillars: z
          .object({
            backing: ReplayPillarReasonsSchema,
            exit: ReplayPillarReasonsSchema,
            control: ReplayPillarReasonsSchema,
          })
          .passthrough(),
      })
      .passthrough(),
    // The admitted Exit routes the documentation class's route-diagnostic veto reads.
    exit: z
      .object({
        routes: z.array(
          z
            .object({
              routeKey: z.string().min(1),
              scoringDisposition: z.string().min(1),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const ReplayArtifactSchema = z
  .object({
    pipeline: z
      .object({
        // A capture produced before the v7→v8 cutover stays readable: the
        // registry only reads card fields both envelopes share.
        candidate: z.union([SafetyScoreV9PreviousResponseSchema, SafetyScoreV9ResponseSchema]),
        compiledFacts: z.unknown(),
        evaluatedSet: z.object({ assets: z.array(ReplayEvaluatedAssetSchema) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Question identity comes from the single authority
 * (`shared/lib/safety-score-v9/open-questions.ts`, PLAN §2.2 / ImplCounting §3.1).
 * The registry only adds the dust-residual merge (PLAN §2.4, §10.5 U6) and the
 * queue-row shape.
 */
export function documentationResidualQuestionKey(rootAssetId: string): string {
  return residualQuestionKey(rootAssetId);
}

/** The queue columns the question identity reads. */
export type DocumentationQuestionEntry = Pick<
  V9EvidenceGapQueueEntryV3,
  "queueKey" | "assetId" | "gapId" | "reasonCode" | "causeScope" | "documentation"
>;

export function questionKeyForEntry(entry: DocumentationQuestionEntry): string {
  // One dust residual question per root replaces the per-datum dust questions.
  if (entry.documentation?.reason === "reserve-dust") {
    return residualQuestionKey(v9QuestionRootAssetId(entry.gapId) ?? entry.assetId);
  }
  return questionKeyForGap(
    { gapId: entry.gapId, reasonCode: entry.reasonCode, causeScope: entry.causeScope ?? undefined },
    entry.assetId,
  );
}

export interface DocumentationResidual {
  questionKey: string;
  rootAssetId: string;
  reason: "reserve-dust";
  bucket: "documentation" | "open";
  bookShare: number;
  bookSharePct: number;
  thresholdBookSharePct: number;
  exposureKeys: string[];
  datumGapIds: string[];
  datumTaskIds: string[];
  datumCount: number;
}

/**
 * Merge a root's sub-dust exposure rows into the single visible residual
 * question. The merged rows stay documentation only while their total stays
 * under `reserveDustResidualMaxBookSharePct`; above the bar the residual is an
 * open question (PLAN §2.4, §10.5 U6). The datum rows themselves never change.
 */
export function documentationResidualForRoot(
  rootAssetId: string,
  entries: readonly Pick<V9EvidenceGapQueueEntryV3, "gapId" | "path" | "materiality">[],
  taskIdByGapId: ReadonlyMap<string, string>,
  residualMaxBookSharePct: number,
): DocumentationResidual {
  let bookShare = 0;
  const exposureKeys = new Set<string>();
  const datumGapIds = new Set<string>();
  const datumTaskIds = new Set<string>();
  for (const entry of entries) {
    bookShare += entry.materiality.fractionOfAsset ?? 0;
    if (entry.path.kind === "collateral-exposure") exposureKeys.add(entry.path.exposureKey);
    datumGapIds.add(entry.gapId);
    const taskId = taskIdByGapId.get(entry.gapId);
    if (taskId !== undefined) datumTaskIds.add(taskId);
  }
  return {
    questionKey: documentationResidualQuestionKey(rootAssetId),
    rootAssetId,
    reason: "reserve-dust",
    bucket: bookShare < residualMaxBookSharePct / 100 ? "documentation" : "open",
    bookShare,
    bookSharePct: bookShare * 100,
    thresholdBookSharePct: residualMaxBookSharePct,
    exposureKeys: [...exposureKeys].sort((left, right) => left.localeCompare(right)),
    datumGapIds: [...datumGapIds].sort((left, right) => left.localeCompare(right)),
    datumTaskIds: [...datumTaskIds].sort((left, right) => left.localeCompare(right)),
    datumCount: entries.length,
  };
}

/**
 * Documentation-classed question keys per root asset. A question counts as
 * documentation only when every obligation under it is documentation-classed
 * (precedence documentation > issuer > open, PLAN §2.1); measured-adverse
 * (cause D) rows never open a question (open-questions.ts). `openResidualKeys`
 * names the 3f residuals whose merged dust total exceeds the bar: their datum
 * rows are documentation, but the merged question stays open.
 */
export function documentationQuestionKeysByRoot(
  entries: readonly (DocumentationQuestionEntry & Pick<V9EvidenceGapQueueEntryV3, "cause">)[],
  documentationOf: (entry: DocumentationQuestionEntry) => V9EvidenceGapDocumentation | null,
  openResidualKeys: Iterable<string> = [],
): Map<string, ReadonlySet<string>> {
  const byRoot = new Map<string, Map<string, boolean>>();
  for (const entry of entries) {
    if (entry.cause === "D") continue;
    const root = v9QuestionRootAssetId(entry.gapId) ?? entry.assetId;
    const questions = byRoot.get(root) ?? new Map<string, boolean>();
    const key = questionKeyForEntry(entry);
    questions.set(key, (questions.get(key) ?? true) && documentationOf(entry) !== null);
    byRoot.set(root, questions);
  }
  const openResiduals = new Set(openResidualKeys);
  const documented = new Map<string, ReadonlySet<string>>();
  for (const [root, questions] of byRoot) {
    for (const key of openResiduals) questions.set(key, false);
    const keys = new Set(
      [...questions].filter(([, everyObligationDocumented]) => everyObligationDocumented).map(([key]) => key),
    );
    if (keys.size > 0) documented.set(root, keys);
  }
  return documented;
}

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
  entry: Pick<V9EvidenceGapQueueEntryV3, "reasonCode" | "path">,
): V9MissingDataWorkType {
  return workTypeForDescriptor(descriptorForReason(entry.reasonCode, entry.path));
}

// missing-pillar-evidence routes only by its compiled fact-gap local-component
// path (see descriptorForReason). Card projections carry no such path; the
// compiled gap queue, including the asset-compilation quarantine gap, owns it.
const FACT_PATH_ROUTED_REASON = "missing-pillar-evidence";

export function classifyV9ScoreProjectionWorkType(reasonCode: string): V9MissingDataWorkType | null {
  if (reasonCode === FACT_PATH_ROUTED_REASON) return null;
  const disposition = curationDispositionForReason(reasonCode);
  if (disposition?.disposition === "non-curation") return null;
  return workTypeForDescriptor(descriptorForReason(reasonCode));
}

/** Sole routing source for the legacy markdown view of the typed registry. */
export function classifyV9CurationWorklistStream(reasonCode: string): string | null {
  if (reasonCode === FACT_PATH_ROUTED_REASON) return null;
  const disposition = curationDispositionForReason(reasonCode);
  if (!disposition) descriptorForReason(reasonCode);
  return disposition?.disposition === "routed" ? disposition.stream : null;
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
  entry: Pick<V9EvidenceGapQueueEntryV3, "archetype" | "path">,
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
  entry: V9EvidenceGapQueueEntryV3,
  context: unknown,
): V9MissingDataResolutionMode {
  if (entry.cause === "A") return "producer-runtime";
  if (entry.cause === "B") return "agent-curation";
  if (entry.cause === "C") return "issuer-or-onchain-evidence";
  // Mechanism review resists a static default: ratified disclosure-backed
  // archetypes intentionally take the direct-curation lane.
  if (workType === "MECHANISM_REVIEW") return mechanismResolutionMode(entry);
  if (workType === "EXIT_OUTPUT") {
    const lane = typeof context === "object" && context !== null && "lane" in context ? context.lane : null;
    return lane === "dex" ? "producer-runtime" : "agent-curation";
  }
  return WORK_TYPES[workType].defaultResolutionMode;
}

const EVIDENCE_ACTION_BY_CAUSE: Record<V9EvidenceGapQueueEntryV3["cause"], string> = {
  A: "repair-or-refresh-producer",
  B: "curate-proven-public-datum",
  C: "obtain-issuer-or-onchain-disclosure",
  U: "research-and-classify-required-datum",
  D: "adjudicate-measured-adverse-evidence",
};

export function scoreProjectionResolutionMode(
  workType: V9MissingDataWorkType,
  archetype: V9EvidenceGapQueueEntryV3["archetype"],
): V9MissingDataResolutionMode {
  // See resolutionModeFor: mechanism review is the one archetype-dependent
  // resolution policy in this taxonomy.
  if (workType === "MECHANISM_REVIEW") {
    return DIRECT_CURATION_MECHANISM_ARCHETYPES.has(archetype) ? "agent-curation" : "issuer-or-onchain-evidence";
  }
  return WORK_TYPES[workType].defaultResolutionMode;
}

function scoreProjectionAction(mode: V9MissingDataResolutionMode): string {
  return resolutionModeAction(mode, "adjudicate-and-curate-score-projection");
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
  /** The public card's interned `:cause:N` references for this reason. */
  causeGapRefs: number[];
}

function scoreProjectionReasons(card: SafetyScoreV9Card): ScoreProjectionReason[] {
  const reasons: ScoreProjectionReason[] = [];
  for (const pillar of ["backing", "exit", "control"] as const) {
    for (const reason of card.pillars[pillar].reasons) {
      const workType = classifyV9ScoreProjectionWorkType(reason.code);
      if (workType) {
        reasons.push({
          ...reason, reasonCode: reason.code, source: `pillar:${pillar}`, workType,
          causeGapRefs: [...(reason.causeGapRefs ?? [])],
        });
      }
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
        causeGapRefs: [...(reason.causeGapRefs ?? [])],
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
      causeGapRefs: [],
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

/** The causal path without its `:cause:<gap-or-ref>` suffix. */
function causalPathBase(path: string): string {
  const index = path.lastIndexOf(":cause:");
  return index < 0 ? path : path.slice(0, index);
}

type EvaluatedPillarReasons = {
  readonly backing: readonly ReplayPillarReason[];
  readonly exit: readonly ReplayPillarReason[];
  readonly control: readonly ReplayPillarReason[];
};

/**
 * PLAN §4.3 DEB-4: the compiled gaps a score projection's obligation resolves
 * to, by causal gap identity. The evaluated set is authoritative (same replay,
 * un-interned ids); the public card's interned `:cause:N` table is the fallback
 * for rows that never reached a pillar reason. An empty result means the row
 * exposes no causal gap identity, so coverage falls back to the exact work type
 * rather than assuming the work is covered.
 */
export function scoreProjectionCauseGapIds(args: {
  reason: ScoreProjectionReason;
  card: Pick<SafetyScoreV9Card, "id" | "localCauseGaps" | "foreignCauseGapRefs">;
  evaluated: EvaluatedPillarReasons | undefined;
  foreignCauseGaps: readonly string[];
}): string[] {
  const { reason } = args;
  const pillar = reason.source.startsWith("pillar:")
    ? (reason.source.slice("pillar:".length) as keyof EvaluatedPillarReasons)
    : null;
  if (pillar !== null) {
    const base = causalPathBase(reason.path ?? "");
    const evaluatedIds = (args.evaluated?.[pillar] ?? [])
      .filter((candidate) => candidate.code === reason.reasonCode &&
        causalPathBase(candidate.path ?? "") === base)
      .flatMap((candidate) => [
        ...(candidate.causeGapIds ?? []),
        ...(candidate.sourceGapId === undefined ? [] : [candidate.sourceGapId]),
      ]);
    if (evaluatedIds.length > 0) {
      return [...new Set(evaluatedIds)].sort((left, right) => left.localeCompare(right));
    }
  }
  const refs = [...reason.causeGapRefs];
  const suffix = reason.path === null ? null : /:cause:(\d+)$/u.exec(reason.path);
  if (suffix !== null) refs.push(Number(suffix[1]));
  if (refs.length === 0) return [];
  return [...new Set(refs.map((ref) =>
    resolveCauseGapId({ foreignCauseGaps: args.foreignCauseGaps }, args.card, ref)))
  ].sort((left, right) => left.localeCompare(right));
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

export function mechanismOverlayAdmissionWarnings(
  captureClockSec: number,
  overlays: readonly {
    assetId: string; reviewedAt: string; components: Record<string, { review?: { reviewedAt: string }; [field: string]: unknown } | undefined>;
  }[] = mechanismReviewOverlays.overlays,
): string[] {
  const warnings: string[] = [];
  for (const overlay of overlays) {
    const reviews = [
      { field: "reviewedAt", reviewedAt: overlay.reviewedAt },
      ...Object.entries(overlay.components).flatMap(([key, component]) =>
        component?.review ? [{ field: `components.${key}.review.reviewedAt`, reviewedAt: component.review.reviewedAt }] : []),
    ];
    for (const review of reviews) {
      const admissionSec = reviewAdmissionSec(review.reviewedAt);
      if (admissionSec > captureClockSec) {
        warnings.push(`${overlay.assetId}: mechanism ${review.field} ${review.reviewedAt} is inadmissible until ${new Date(admissionSec * 1_000).toISOString()} at this capture clock`);
      }
    }
  }
  return warnings.sort();
}

function cardScoreProjection(card: SafetyScoreV9Card) {
  return {
    grade: card.grade,
    ratingStatus: card.ratingStatus,
    partialEvidence: card.partialEvidence,
    score: card.score,
    qualityScore: card.qualityScore,
    pegMultiplier: card.pegMultiplier,
    pegAdjustedScore: card.pegAdjustedScore,
    weakestPillar: card.weakestPillar,
    pillars: card.pillars,
    aggregateReasonCodes: card.reasonCodes,
    nrReasons: card.nrReasons,
    evidence: card.evidence,
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
  const policyEnvelope = loadV9MethodologyPolicy(input.policy);
  const queue = V9EvidenceGapQueueV3Schema.parse(
    buildV9EvidenceGapQueue({ factSet: replay.compiledFacts, policy: policyEnvelope }),
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
  // Wire cards intern witness text; tasks must carry the readable scope.
  const cardById = new Map(candidate.cards.map((card) => [card.id, resolveV9PublicWitnessTexts(card)]));
  const sourceById = new Map(input.catalogEntries.map((entry) => [entry.id, entry]));
  const entriesById = new Map<string, V9EvidenceGapQueueEntryV3[]>();
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
  // Documentation band (PLAN §2.3–2.4): counting and routing only. The queue
  // carries the classifier's copy; the registry never re-classifies — except the
  // one rule that needs the evaluated set, below.
  const documentation = policyEnvelope.policy.semantic.evidence.documentation;
  const residualMaxBookSharePct = documentation?.reserveDustResidualMaxBookSharePct ?? null;
  const taskIdByGapId = new Map(
    queue.entries.map((entry) => [entry.gapId, `V9G-${entry.queueKey.slice(0, 16)}`]),
  );
  // Supplement dedupe (PLAN §4.3 DEB-4): a card reason joins its evaluated
  // pillar reason by code and causal path base, then every obligation it
  // carries resolves through the compiled `gapId -> taskId` table.
  const evaluatedReasonsByAsset = new Map<string, EvaluatedPillarReasons>(
    replay.evaluatedSet.assets.map((evaluated) => [
      evaluated.assetId,
      {
        backing: evaluated.scoreInput.pillars.backing.reasons,
        exit: evaluated.scoreInput.pillars.exit.reasons,
        control: evaluated.scoreInput.pillars.control.reasons,
      },
    ]),
  );
  const foreignCauseGaps = candidate.foreignCauseGaps;
  // The queue only sees compiled facts. DOC-1's route-diagnostic veto needs the
  // Exit routes the evaluation actually admitted, so the registry re-runs the
  // classifier for optional-exit diagnostics with those keys; a route that was
  // never admitted stays open. No other reason reads the evaluated set.
  const admittedExitRouteKeysByAsset = new Map(
    replay.evaluatedSet.assets.map((evaluated) => [
      evaluated.assetId,
      new Set(
        evaluated.exit.routes
          .filter((route) => route.scoringDisposition === "included")
          .map((route) => route.routeKey),
      ),
    ]),
  );
  const documentationByQueueKey = new Map<string, V9EvidenceGapDocumentation>();
  for (const entry of queue.entries) {
    if (entry.documentation !== null || entry.reviewState !== null) continue;
    if (entry.path.kind !== "optional-exit") continue;
    const asset = factById.get(entry.assetId);
    const gap = asset?.gaps.find((candidate) => candidate.gapId === entry.gapId);
    if (asset === undefined || gap === undefined) continue;
    const classification = classifyV9DocumentationGap(
      policyEnvelope,
      { ...asset, admittedExitRouteKeys: admittedExitRouteKeysByAsset.get(asset.assetId) ?? new Set() },
      gap,
    );
    if (classification === null) continue;
    documentationByQueueKey.set(entry.queueKey, {
      class: "documentation",
      reason: classification.reason,
      policyRef: classification.policyRef,
      threshold: classification.threshold,
    });
  }
  const documentationOf = (entry: DocumentationQuestionEntry): V9EvidenceGapDocumentation | null =>
    documentationByQueueKey.get(entry.queueKey) ?? entry.documentation;
  const entriesByRoot = new Map<string, V9EvidenceGapQueueEntryV3[]>();
  for (const entry of queue.entries) {
    const root = v9QuestionRootAssetId(entry.gapId) ?? entry.assetId;
    const existing = entriesByRoot.get(root) ?? [];
    existing.push(entry);
    entriesByRoot.set(root, existing);
  }
  // One visible 3f residual per root; the datum task IDs stay addressable.
  const documentationResidualsByRoot = new Map<string, DocumentationResidual>();
  if (residualMaxBookSharePct !== null) {
    const dustByRoot = new Map<string, V9EvidenceGapQueueEntryV3[]>();
    for (const entry of queue.entries) {
      if (documentationOf(entry)?.reason !== "reserve-dust") continue;
      const root = v9QuestionRootAssetId(entry.gapId) ?? entry.assetId;
      const existing = dustByRoot.get(root) ?? [];
      existing.push(entry);
      dustByRoot.set(root, existing);
    }
    for (const [root, dustEntries] of dustByRoot) {
      documentationResidualsByRoot.set(
        root,
        documentationResidualForRoot(root, dustEntries, taskIdByGapId, residualMaxBookSharePct),
      );
    }
  }
  // A question is documentation only when every obligation under it is
  // documentation-classed (precedence documentation > issuer > open, PLAN §2.1).
  // A residual whose merged total exceeds the bar keeps its datum rows counted
  // but its question open.
  const documentationQuestionsByRoot = documentationQuestionKeysByRoot(
    queue.entries,
    documentationOf,
    [...documentationResidualsByRoot.values()]
      .filter((residual) => residual.bucket === "open")
      .map((residual) => residual.questionKey),
  );
  const projectionDedupe = {
    workTypeFallback: 0,
    coveredByGapIdentity: 0,
    keptForUncoveredObligation: 0,
    supplementsRemoved: 0,
  };
  const stablecoins = facts.activeAssetIds.map((assetId) => {
    const asset = factById.get(assetId);
    const card = cardById.get(assetId);
    const source = sourceById.get(assetId);
    if (!asset || !card || !source)
      throw new Error(`Missing fact, card, or catalog source for active asset ${assetId}`);
    const openEntries = entriesById.get(assetId) ?? [];
    const supplyUsd = asset.supply.circulatingUsd;
    // Preserve path-scoped context, but serialize each distinct context once.
    // Repeating whole asset surfaces on every task makes output quadratic.
    const currentFactContexts: Record<string, unknown> = {};
    const contextRefsByScope = new Map<string, string>();
    const contextForTask = (scope: string, buildContext: () => unknown) => {
      let ref = contextRefsByScope.get(scope);
      if (ref === undefined) {
        const context = buildContext() ?? null;
        ref = `V9C-${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`;
        currentFactContexts[ref] = context;
        contextRefsByScope.set(scope, ref);
      }
      return { context: currentFactContexts[ref], ref };
    };
    const factItems = openEntries.map((entry) => {
      const descriptor = descriptorForReason(entry.reasonCode, entry.path);
      const workType = workTypeForDescriptor(descriptor);
      const { context, ref: currentFactContextRef } = contextForTask(
        `fact:${JSON.stringify(entry.path)}`, () => descriptor.context(asset),
      );
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
        recommendedEvidenceAction: EVIDENCE_ACTION_BY_CAUSE[entry.cause],
        gapId: entry.gapId,
        queueKey: entry.queueKey,
        reasonCode: entry.reasonCode,
        message: entry.message,
        publicLabel: entry.publicLabel,
        ownerDomain: entry.ownerDomain,
        factOwnerDomain: entry.factOwnerDomain,
        policyRuleId: entry.policyRuleId,
        responsibility: entry.responsibility,
        cause: entry.cause,
        causeProof: entry.causeProof,
        causeScope: entry.causeScope,
        causeGapIds: entry.causeGapIds,
        applicability: entry.applicability,
        observationState: entry.observationState,
        path: entry.path,
        materiality: entry.materiality,
        supplyWeight: entry.supplyWeight,
        releaseSeverity: entry.releaseSeverity,
        treatment: entry.treatment,
        critical: entry.critical,
        // Copied from the evidence-gap queue, plus the registry's
        // evaluated-set classifier pass; the issuer recheck band and the
        // root-scoped question key. A measured-adverse row is a finding, not
        // open evidence: no question.
        documentation: documentationOf(entry),
        reviewState: entry.reviewState,
        questionKey: entry.cause === "D" ? null : questionKeyForEntry(entry),
        likelyTouchpoints: likelyTouchpoints(workType, source, context),
        currentFactContextRef,
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
    const compiledWorkTypes = new Set(factItems.map((item) => item.workType));
    // PLAN §4.3 DEB-4 all-obligations rule: a projection needs a supplemental
    // task only when at least one obligation it carries has no compiled task.
    // A cross-work-type compiled task that carries the same gap satisfies it;
    // no compiled task is ever credited by reason code alone. A row whose
    // causal identity cannot be resolved falls back to exact-work-type
    // coverage, never to an assumption of coverage.
    const projectionGapIds = projections.map((reason) => scoreProjectionCauseGapIds({
      reason,
      card,
      evaluated: evaluatedReasonsByAsset.get(assetId),
      foreignCauseGaps,
    }));
    const supplementTaskIdByProjection = new Map<number, string>();
    const supplementalItems = projections
      .flatMap((reason, index) => {
        const gapIds = projectionGapIds[index]!;
        const uncoveredCauseGapIds = gapIds.filter((gapId) => !taskIdByGapId.has(gapId));
        const needsSupplement = gapIds.length === 0
          ? !compiledWorkTypes.has(reason.workType)
          : uncoveredCauseGapIds.length > 0;
        if (gapIds.length === 0) {
          projectionDedupe.workTypeFallback += 1;
        } else if (uncoveredCauseGapIds.length === 0) {
          projectionDedupe.coveredByGapIdentity += 1;
        } else {
          projectionDedupe.keptForUncoveredObligation += 1;
        }
        if (!compiledWorkTypes.has(reason.workType) && !needsSupplement) {
          projectionDedupe.supplementsRemoved += 1;
        }
        if (!needsSupplement) return [];
        const workType = reason.workType;
        const descriptor = WORK_TYPES[workType];
        const { context, ref: currentFactContextRef } = contextForTask(
          `score:${workType}`, () => descriptor.context(asset),
        );
        const resolutionMode = scoreProjectionResolutionMode(workType, asset.archetype);
        // A card-aggregate reason exposes no component identity (wave-7
        // anomaly class: krwq/eur0): curation lanes cannot act on it without
        // inventing a component, so it routes to the coordinator instead.
        const componentIdentityUnavailable = reason.source === "card-aggregate" && reason.path === null;
        const claimGroupId = `${workType}:${assetId}`;
        const digest = scoreProjectionTaskDigest(assetId, reason);
        const taskId = `V9S-${digest.slice(0, 16)}`;
        supplementTaskIdByProjection.set(index, taskId);
        const evidenceRefIds = [...collectEvidenceRefIds(context)].sort((left, right) => left.localeCompare(right));
        const existingEvidence = evidenceRefIds.map(
          (evidenceRefId) =>
            asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId) ?? {
              evidenceId: evidenceRefId,
              unresolvedReference: true,
            },
        );
        allItems.push({ workType, resolutionMode, claimGroupId, taskSource: "score-projection-gap" });
        return [{
          taskSource: "score-projection-gap" as const,
          taskId,
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
          // A score-projection row exposes no compiled gap, so it owns no
          // documentation decision, issuer recheck band or question key.
          documentation: null,
          reviewState: null,
          questionKey: null,
          likelyTouchpoints: likelyTouchpoints(workType, source, context),
          currentFactContextRef,
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
        }];
      });
    const items = [...factItems, ...supplementalItems];
    const scoreProjectionGaps = projections.map((reason, index) => {
      const gapIds = projectionGapIds[index]!;
      const uncoveredCauseGapIds = gapIds.filter((gapId) => !taskIdByGapId.has(gapId));
      const supplementalTaskId = supplementTaskIdByProjection.get(index) ?? null;
      // Coverage is gap identity, not work type: a compiled task of another
      // work type that carries the same causal gap covers the projection. Only
      // a row without a resolvable identity falls back to the exact work type,
      // so a mixed obligation set keeps its supplemental task.
      const coveredByTaskIds = gapIds.length === 0
        ? items.filter((item) => item.workType === reason.workType).map((item) => item.taskId)
        : [...new Set([
          ...gapIds.flatMap((gapId) => {
            const taskId = taskIdByGapId.get(gapId);
            return taskId === undefined ? [] : [taskId];
          }),
          ...(supplementalTaskId === null ? [] : [supplementalTaskId]),
        ])].sort((left, right) => left.localeCompare(right));
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
        stream: WORK_TYPES[reason.workType].stream,
        causalGapIds: gapIds,
        uncoveredCauseGapIds,
        coverageBasis: gapIds.length === 0 ? "work-type" as const : "causal-gaps" as const,
        coveredByTaskIds,
        supplementalTaskId,
        requiresSupplementalTask: supplementalTaskId !== null,
      };
    });
    const claimGroups = new Set(items.map((item) => item.claimGroupId));
    const sourceFiles = [source.file, ...(source.sidecarFiles ?? [])];
    const documentationItems = factItems.filter((item) => item.documentation !== null);
    const residual = documentationResidualsByRoot.get(assetId);
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
      currentFactContexts,
      missingDataSummary: {
        openItemCount: items.length,
        // The band is counted, never closable by the default drain: every
        // documentation datum keeps its item and its taskId.
        documentationItemCount: documentationItems.length,
        documentationDatumCount: documentationItems.filter((item) => item.taskSource === "compiled-fact-gap").length,
        // Questions live at the root asset; the per-root view is attributed to
        // the card that owns them, so the registry total partitions by root.
        documentationQuestionCount: documentationQuestionsByRoot.get(assetId)?.size ?? 0,
        researchedTerminalItemCount: factItems.filter((item) => item.reviewState !== null).length,
        claimGroupCount: claimGroups.size,
        criticalItemCount: items.filter((item) => item.critical).length,
        policyBindingReviewCount: items.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
        workTypeCounts: countBy(items, (item) => item.workType),
        reasonCounts: countBy(items, (item) => item.reasonCode),
        resolutionModeCounts: countBy(items, (item) => item.resolutionMode),
        taskSourceCounts: countBy(items, (item) => item.taskSource),
      },
      documentationResiduals: residual === undefined ? [] : [residual],
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
  const documentationResidualRows = stablecoins.flatMap((asset) => asset.documentationResiduals);
  const taskIds = registryItems.map((item) => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("Generated missing-data task IDs are not unique");
  const claimGroupCount = new Set(allItems.map((item) => item.claimGroupId)).size;
  const warnings = mechanismOverlayAdmissionWarnings(candidate.asOfSec);
  return {
    schemaVersion: 3,
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
        "Every compiled fact gap is represented exactly once. Every score-visible missing or bounded reason is listed under scoreProjectionGaps with the causal gap ids it carries; a supplemental task is added only when at least one of those obligations has no compiled task, or, for a reason that exposes no causal gap identity, when no compiled fact task of its exact work type exists.",
      supplementDedupe:
        "coverageBasis causal-gaps means every obligation under the projection resolves to a compiled task, possibly of another work type; work-type is the fail-closed fallback for a reason with no resolvable causal gap identity. uncoveredCauseGapIds lists the obligations that forced a supplemental task, so a deduplicated row never hides independent work. A mixed cause set always keeps its supplemental task.",
      policyBindingWarning:
        "Policy-binding issues are queue-contract defects, not substitutes for evidence work. Each affected item preserves the defect and supplies a separate evidence action.",
      responsibilityWarning:
        "Compiled fact tasks identify whether evidence is measured adverse, issuer-undisclosed, integration-missing, producer-failed, or method-unsupported. Score-projection-only tasks carry null because they have no compiled fact-gap responsibility.",
      pointInTimeWarning:
        "This registry is bound to one immutable production replay. Regenerate it after coordinated data batches; resolved task IDs disappear and new gaps receive new IDs.",
      documentationBand:
        "Items whose documentation field is non-null are classified by policy semantic.evidence.documentation as unable to move a published score. They stay counted, listed and addressable; default sweeps and worklists skip them unless the worklist is run with --include-documentation. documentationQuestionCount dedupes root-scoped questionKey values, so it is smaller than documentationItemCount whenever several datums answer one question.",
      documentationResiduals:
        "documentationResiduals merges a root's sub-dust reserve exposures into one visible residual question. The datum rows keep their own taskIds; the residual counts as documentation only while the merged weight stays under reserveDustResidualMaxBookSharePct, otherwise it is an open question.",
      researchedTerminalBand:
        "An item with reviewState researched-terminal records an issuer that was researched and does not publish the datum. It leaves the default drain for a dated recheck at recheckAtSec; the original reviewedAt is preserved and never re-dated.",
      factContextBinding:
        "Resolve each task's currentFactContextRef in its stablecoin's currentFactContexts table. Distinct path-scoped contexts are stored once by content digest; task routing and claim groups do not change.",
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
      rateableStablecoinCount: candidate.completeness.ratedCount,
      notRatedStablecoinCount: candidate.completeness.notRatedCount,
      pipelineGapStablecoinCount: candidate.completeness.pipelineGapCount,
      openItemCount: registryItems.length,
      compiledFactItemCount: queue.entries.length,
      supplementalScoreItemCount: registryItems.filter((item) => item.taskSource === "score-projection-gap").length,
      // Documentation band: counted once per datum and once per root question.
      // `openItemCount` keeps every datum; the band never subtracts work.
      documentationItemCount: registryItems.filter((item) => item.documentation !== null).length,
      documentationDatumCount: queue.entries.filter((entry) => documentationOf(entry) !== null).length,
      documentationQuestionCount: [...documentationQuestionsByRoot.values()].reduce((total, keys) => total + keys.size, 0),
      documentationReasonCounts: V9DocumentationReasonSchema.options.map((reason) => ({
        reason,
        count: registryItems.filter((item) => item.documentation?.reason === reason).length,
      })),
      documentationResidualCount: documentationResidualRows.length,
      documentationResidualDatumCount: documentationResidualRows.reduce((total, row) => total + row.datumCount, 0),
      documentationOpenResidualCount: documentationResidualRows.filter((row) => row.bucket === "open").length,
      researchedTerminalItemCount: registryItems.filter((item) => item.reviewState !== null).length,
      scoreProjectionReasonCount: projectionRows.length,
      scoreProjectionReasonNeedingSupplementCount: projectionRows.filter((row) => row.requiresSupplementalTask).length,
      // Supplement dedupe (PLAN §4.3 DEB-4): rows covered by causal gap
      // identity, the fail-closed work-type fallback, and the two ways a
      // supplement survives.
      scoreProjectionCauseGapCount: projectionDedupe.coveredByGapIdentity,
      scoreProjectionWorkTypeFallbackCount: projectionDedupe.workTypeFallback,
      scoreProjectionSupplementRemovedCount: projectionDedupe.supplementsRemoved,
      scoreProjectionSupplementKeptForUncoveredCount: projectionDedupe.keptForUncoveredObligation,
      claimGroupCount,
      criticalItemCount: queue.entries.filter((entry) => entry.critical).length,
      policyBindingReviewCount: registryItems.filter((item) => item.policyBinding.coordinatorReviewRequired).length,
      responsibilityCounts: queue.summary.responsibilityCounts,
      observationStateCounts: countBy(registryItems, (entry) => entry.observationState),
      gradeCounts: countBy(candidate.cards.filter(card => card.grade !== null), (card) => card.grade!),
      ratingStatusCounts: countBy(candidate.cards, card => card.ratingStatus),
      workTypeCounts: countBy(allItems, (item) => item.workType),
      reasonCounts: countBy(registryItems, (entry) => entry.reasonCode),
      resolutionModeCounts: countBy(allItems, (item) => item.resolutionMode),
      ownerDomainCounts: countBy(registryItems, (entry) => entry.ownerDomain),
      taskSourceCounts: countBy(allItems, (item) => item.taskSource),
      warnings,
    },
    workTypeDefinitions: WORK_TYPE_DEFINITIONS,
    stablecoins,
  };
}

interface RegistryIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const DEFAULT_IO: RegistryIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: writeJsonOutput,
  stderr: process.stderr,
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
  for (const warning of registry.summary.warnings) io.stderr.write(`Warning: ${warning}\n`);
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
