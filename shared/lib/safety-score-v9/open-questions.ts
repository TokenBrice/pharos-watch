import type { V9DocumentationReason, V9ReasonCode } from "../../types/safety-score-v9";
import {
  v9RouteQuestionIdentity,
  type V9EvidenceCause,
  type V9EvidenceCauseScope,
} from "../../types/safety-score-v9-causes";
import type { V9EvidenceResponsibility, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import {
  V9_OPEN_EVIDENCE_MIXED_OWNER,
  V9_OPEN_EVIDENCE_SEMANTICS,
  type V9OpenEvidence,
  type V9OpenEvidenceByCard,
  type V9OpenEvidenceTotals,
  type V9OpenQuestionBucket,
  type V9QuestionKey,
} from "../../types/safety-score-v9-open-evidence";
import { V9_PUBLIC_EVIDENCE_RESPONSIBILITIES } from "../../types/safety-score-v9-vocabulary";
import { compareText } from "./primitives";

/**
 * The single open-evidence counting authority (PLAN §2.1–2.2, ImplCounting §3).
 *
 * One question is counted once, at its root asset: the root is the prefix before
 * `:gap:` of the obligation's gap id, else the carrying card. The three published
 * numbers partition the questions (documentation > issuer > open); obligations
 * stay per card and reconcile to `evidenceResponsibility` through the same
 * deduplication `countV9EvidenceObligations` applies.
 *
 * Measured-adverse (`cause: "D"`) facts are not open evidence: they record a
 * measured negative finding, not an absence of data, so they never open a
 * question and are excluded from the published obligation total. This matches
 * the `/coverage/` owner list, which excludes `measured-adverse` by definition.
 *
 * Derived at publication build time, never stored: the same gap always yields the
 * same key, and the question set is order-independent.
 */

const GAP_ID_SEPARATOR = ":gap:";

/**
 * 3f residual identity: sub-0.01% reserve dust merges per root into one visible
 * documentation question instead of one question per exposure row.
 */
export const V9_RESERVE_RESIDUAL_QUESTION_IDENTITY = "reserve-residual:sub-0.01pct";

/**
 * Documentation class of a compiled gap: its policy reason, or null when the gap
 * stays counted. T1 passes `() => null`, which counts every obligation.
 */
export type V9DocumentationGapClassifier = (gap: V9FactGapV3) => V9DocumentationReason | null;

/** Columns needed to resolve an open question from a compiled gap. */
export type V9OpenEvidenceGap = Pick<V9FactGapV3, "gapId" | "causeScope"> & {
  causeProof: { cause: "C"; reviewedAt: string } | { cause: Exclude<V9EvidenceCause, "C"> };
};

export function projectV9OpenEvidenceGap(gap: V9FactGapV3): V9OpenEvidenceGap {
  const { causeProof, gapId, causeScope } = gap;
  return { gapId, causeScope, causeProof: causeProof.cause === "C"
    ? { cause: "C", reviewedAt: causeProof.reviewedAt } : { cause: causeProof.cause } };
}

/** One obligation of a question, as the public fact row carries it. */
export interface V9OpenQuestionObligation<Gap extends V9OpenEvidenceGap = V9FactGapV3> {
  /** Compiled gap behind the obligation; null when the fact names no resolvable gap. */
  readonly gap: Gap | null;
  readonly reasonCode: V9ReasonCode;
  readonly cause: V9EvidenceCause;
  readonly responsibility: V9EvidenceResponsibility;
}

/** The per-fact columns open-evidence counting reads (`V9UnresolvedFact` satisfies it). */
export interface V9OpenQuestionFact {
  readonly code: V9ReasonCode;
  readonly critical: boolean;
  readonly responsibility: V9EvidenceResponsibility;
  readonly cause?: V9EvidenceCause;
  readonly sourceGapId?: string | null;
  readonly causeGapIds?: readonly string[];
}

/** An evaluated asset: the trace facts a card carries. */
export interface V9OpenEvidenceEvaluatedAsset {
  readonly assetId: string;
  readonly trace: { readonly unresolvedFacts: readonly V9OpenQuestionFact[] };
}

/** Authored control identity IR-0 emits on bridge control facts. */
export interface V9OpenQuestionControlIdentity {
  readonly controlKey: string;
  readonly deploymentKey: string;
  readonly authoredControlId?: string;
}

/** A compiled asset: every gap the cohort can resolve, plus control identities. */
export interface V9OpenEvidenceAsset<Gap extends V9OpenEvidenceGap = V9FactGapV3> {
  readonly assetId: string;
  readonly gaps: readonly Gap[];
  readonly controls?: readonly V9OpenQuestionControlIdentity[];
}

export interface V9OpenEvidenceInput {
  readonly assets: readonly V9OpenEvidenceAsset[];
  readonly evaluated: readonly V9OpenEvidenceEvaluatedAsset[];
  readonly isDocumentationGap: V9DocumentationGapClassifier;
}

export interface V9OpenEvidenceCounter {
  /** Accumulate one evaluated card. Each asset may be added once. */
  add(asset: V9OpenEvidenceEvaluatedAsset): void;
  /** Publish the block. The counter is sealed afterwards. */
  finish(): V9OpenEvidence;
}

/** One reason-code tally behind a projected card question. */
export interface V9CardOpenQuestionCode {
  readonly code: V9ReasonCode;
  readonly obligations: number;
  readonly documentation: boolean;
}

/** One question carried by a card, using the cohort bucket and root attribution. */
export interface V9CardOpenQuestion {
  readonly questionKey: V9QuestionKey;
  readonly bucket: V9OpenQuestionBucket;
  readonly inherited: boolean;
  readonly obligations: number;
  readonly codes: readonly V9CardOpenQuestionCode[];
}

/** Exact per-card open-evidence projection: the `byCard` row plus its question audit trail. */
export interface V9CardOpenEvidenceProjection {
  readonly card: V9OpenEvidenceByCard;
  readonly questions: readonly V9CardOpenQuestion[];
}

/** Root asset of a gap id: the prefix before `:gap:`, else null (the card is the root). */
export function v9QuestionRootAssetId(gapId: string | null | undefined): string | null {
  if (gapId === null || gapId === undefined) return null;
  const separator = gapId.indexOf(GAP_ID_SEPARATOR);
  return separator <= 0 ? null : gapId.slice(0, separator);
}

function questionIdentity(scope: V9EvidenceCauseScope, authoredControlScope: string | null): string {
  // A control datum can carry a deployment exposure (bridge-meta factors), so the
  // control dispatch must run before `reserve-exposure` (PLAN §2.2).
  if (scope.pillar === "control" && scope.componentKey.startsWith("control:")) {
    return `control|${authoredControlScope ?? scope.componentKey}`;
  }
  if (scope.routeKey !== null) return `route|${v9RouteQuestionIdentity(scope.routeKey)}`;
  if (scope.exposureId !== null) return `reserve-exposure|${scope.exposureId}`;
  return `component|${scope.componentKey}`;
}

/**
 * Question identity for one scope: `<rootAssetId>|<scopeKind>|<scopeIdentity>`.
 * Route identities keep their own `<lane>|<tail>` separator, so only the first
 * two separators are structural. `authoredControlScope` is the authored bridge
 * control identity (`authored:<assetId>|<routeId>|<controlId>`); it applies to
 * control scopes only and never changes a non-control question.
 */
export function questionKeyForScope(
  rootAssetId: string,
  scope: V9EvidenceCauseScope,
  authoredControlScope: string | null = null,
): V9QuestionKey {
  const identity = questionIdentity(scope, authoredControlScope);
  return `${rootAssetId}|${identity}`;
}

/** 3f residual question of a root asset (documentation-classed dust, one per root). */
export function residualQuestionKey(rootAssetId: string): V9QuestionKey {
  return `${rootAssetId}|reserve-exposure|${V9_RESERVE_RESIDUAL_QUESTION_IDENTITY}`;
}

/**
 * Question identity of one compiled gap. `cardId` is the card carrying the
 * obligation and only roots the key when the gap id names no asset (a local,
 * non-`gap` identity). A gap without a `causeScope` keeps the gapless
 * `path|<code>` identity, like a fact that resolves to no gap.
 */
export function questionKeyForGap(
  gap: Pick<V9FactGapV3, "gapId" | "reasonCode" | "causeScope">,
  cardId: string,
  authoredControlScope: string | null = null,
): V9QuestionKey {
  const root = v9QuestionRootAssetId(gap.gapId) ?? cardId;
  if (gap.causeScope === undefined) return `${root}|path|${gap.reasonCode}`;
  return questionKeyForScope(root, gap.causeScope, authoredControlScope);
}

function bucketFor(
  obligations: number,
  documentationObligations: number,
  hasIssuerCause: boolean,
): V9OpenQuestionBucket {
  if (obligations > 0 && documentationObligations === obligations) return "documentation";
  return hasIssuerCause ? "issuer" : "open";
}

/**
 * Bucket of one question: documentation when every obligation is
 * documentation-classed, else issuer when any non-documentation obligation has
 * cause C, else open. Precedence is documentation > issuer > open.
 */
export function classifyV9OpenQuestion(
  obligations: readonly V9OpenQuestionObligation[],
  isDocumentationGap: V9DocumentationGapClassifier,
): V9OpenQuestionBucket {
  let documentationObligations = 0;
  let hasIssuerCause = false;
  for (const obligation of obligations) {
    if (obligation.gap !== null && isDocumentationGap(obligation.gap) !== null) {
      documentationObligations++;
    } else if (obligation.cause === "C") {
      hasIssuerCause = true;
    }
  }
  return bucketFor(obligations.length, documentationObligations, hasIssuerCause);
}

/**
 * The obligations one card carries, deduplicated exactly like
 * `countV9EvidenceObligations`: one obligation per distinct `sourceGapId` per
 * evidence owner, plus every source-less fact whose single causal root is not
 * already a source under that owner. `measured-adverse` facts are not evidence
 * gaps and never reach the open-evidence question set.
 */
function obligationsForCard<Gap extends V9OpenEvidenceGap>(
  facts: readonly V9OpenQuestionFact[],
  gapsById: ReadonlyMap<string, Gap>,
): V9OpenQuestionObligation<Gap>[] {
  const byOwner = new Map<V9EvidenceResponsibility, V9OpenQuestionFact[]>();
  for (const fact of facts) {
    if (fact.cause === "D") continue;
    const rows = byOwner.get(fact.responsibility);
    if (rows === undefined) byOwner.set(fact.responsibility, [fact]);
    else rows.push(fact);
  }
  const obligations: V9OpenQuestionObligation<Gap>[] = [];
  const obligationFor = (fact: V9OpenQuestionFact, gapId: string | null): V9OpenQuestionObligation<Gap> => {
    const gap = gapId === null ? undefined : gapsById.get(gapId);
    return {
      gap: gap ?? null,
      reasonCode: fact.code,
      cause: fact.cause ?? gap?.causeProof.cause ?? "U",
      responsibility: fact.responsibility,
    };
  };
  for (const rows of byOwner.values()) {
    // One obligation per distinct source; the lexicographically first reason code
    // names it, so the published reason inventory does not depend on fact order.
    const sources = new Map<string, V9OpenQuestionFact>();
    for (const fact of rows) {
      const source = fact.sourceGapId;
      if (source === null || source === undefined) continue;
      const known = sources.get(source);
      if (known === undefined || compareText(fact.code, known.code) < 0) sources.set(source, fact);
    }
    for (const fact of rows) {
      if (fact.sourceGapId !== null && fact.sourceGapId !== undefined) continue;
      const causeGapIds = fact.causeGapIds ?? [];
      const single = causeGapIds.length === 1 ? causeGapIds[0]! : null;
      if (single !== null && sources.has(single)) continue;
      obligations.push(obligationFor(fact, single));
    }
    for (const [source, fact] of sources) obligations.push(obligationFor(fact, source));
  }
  return obligations;
}

interface QuestionAccumulator {
  obligations: number;
  documentationObligations: number;
  hasIssuerCause: boolean;
  readonly codes: Map<V9ReasonCode, number>;
  readonly responsibilities: Set<V9EvidenceResponsibility>;
  oldestReviewedAtSec: number | null;
  newestReviewedAtSec: number | null;
}

interface CardQuestionAccumulator {
  obligations: number;
  documentationObligations: number;
  issuerReviewedAtSec: number | null;
}

function reviewedAtSec(gap: V9OpenEvidenceGap | null): number | null {
  const proof = gap?.causeProof;
  if (proof === undefined || proof.cause !== "C") return null;
  const parsed = Date.parse(proof.reviewedAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function rootOfQuestionKey(questionKey: string): string {
  const end = questionKey.indexOf("|");
  return end < 0 ? questionKey : questionKey.slice(0, end);
}

function accumulateQuestion(
  questions: Map<string, QuestionAccumulator>,
  questionKey: string,
): QuestionAccumulator {
  const known = questions.get(questionKey);
  if (known !== undefined) return known;
  const created: QuestionAccumulator = {
    obligations: 0,
    documentationObligations: 0,
    hasIssuerCause: false,
    codes: new Map(),
    responsibilities: new Set(),
    oldestReviewedAtSec: null,
    newestReviewedAtSec: null,
  };
  questions.set(questionKey, created);
  return created;
}

function indexOpenEvidenceAssets<Gap extends V9OpenEvidenceGap>(assets: readonly V9OpenEvidenceAsset<Gap>[]): {
  gapsById: Map<string, Gap>;
  authoredControlScopeByKey: Map<string, string>;
} {
  const gapsById = new Map<string, Gap>();
  const authoredControlScopeByKey = new Map<string, string>();
  for (const asset of assets) {
    for (const gap of asset.gaps) gapsById.set(gap.gapId, gap);
    for (const control of asset.controls ?? []) {
      if (control.authoredControlId === undefined) continue;
      const scope = `control:${control.controlKey}`;
      const identity = `authored:${asset.assetId}|${control.deploymentKey}|${control.authoredControlId}`;
      authoredControlScopeByKey.set(`${asset.assetId}\u0000${scope}`, identity);
    }
  }
  return { gapsById, authoredControlScopeByKey };
}

function authoredControlScopeForGap(
  authoredControlScopeByKey: ReadonlyMap<string, string>,
  cardId: string,
  gap: V9OpenEvidenceGap,
): string | null {
  const scope = gap.causeScope;
  if (scope === undefined || scope.pillar !== "control" || !scope.componentKey.startsWith("control:")) return null;
  const root = v9QuestionRootAssetId(gap.gapId) ?? cardId;
  return authoredControlScopeByKey.get(`${root}\u0000${scope.componentKey}`) ?? null;
}

function resolveObligationQuestion<Gap extends V9OpenEvidenceGap>(
  cardId: string,
  obligation: V9OpenQuestionObligation<Gap>,
  authoredControlScopeByKey: ReadonlyMap<string, string>,
  isDocumentationGap: (gap: Gap) => V9DocumentationReason | null,
): {
  gap: Gap | null;
  documentationReason: V9DocumentationReason | null;
  questionKey: V9QuestionKey;
} {
  const gap = obligation.gap;
  const documentationReason = gap === null ? null : isDocumentationGap(gap);
  const authoredControlScope = gap === null ? null : authoredControlScopeForGap(authoredControlScopeByKey, cardId, gap);
  const root = v9QuestionRootAssetId(gap?.gapId) ?? cardId;
  const questionKey = documentationReason === "reserve-dust"
    ? residualQuestionKey(root)
    : gap === null || gap.causeScope === undefined
      ? `${root}|path|${obligation.reasonCode}`
      : questionKeyForScope(root, gap.causeScope, authoredControlScope);
  return { gap, documentationReason, questionKey };
}

class OpenEvidenceCounter<Gap extends V9OpenEvidenceGap> implements V9OpenEvidenceCounter {
  private readonly gapsById: Map<string, Gap>;
  private readonly authoredControlScopeByKey: Map<string, string>;
  private readonly isDocumentationGap: (gap: Gap) => V9DocumentationReason | null;
  private readonly questions = new Map<string, QuestionAccumulator>();
  private readonly cardQuestions = new Map<string, Map<string, CardQuestionAccumulator>>();
  private readonly documentationGapIds = new Set<string>();
  private readonly documentationReasonDatums = new Map<V9DocumentationReason, number>();
  private readonly cards = new Set<string>();
  private block: V9OpenEvidence | null = null;

  constructor(assets: readonly V9OpenEvidenceAsset<Gap>[], isDocumentationGap: (gap: Gap) => V9DocumentationReason | null) {
    this.isDocumentationGap = isDocumentationGap;
    const indexed = indexOpenEvidenceAssets(assets);
    this.gapsById = indexed.gapsById;
    this.authoredControlScopeByKey = indexed.authoredControlScopeByKey;
  }

  add(asset: V9OpenEvidenceEvaluatedAsset): void {
    if (this.block !== null) throw new Error("Open-evidence counting is sealed");
    if (this.cards.has(asset.assetId)) {
      throw new Error(`Open-evidence counting received ${asset.assetId} twice`);
    }
    this.cards.add(asset.assetId);
    const cardQuestions = new Map<string, CardQuestionAccumulator>();
    for (const obligation of obligationsForCard(asset.trace.unresolvedFacts, this.gapsById)) {
      const { gap, documentationReason, questionKey } = resolveObligationQuestion(
        asset.assetId,
        obligation,
        this.authoredControlScopeByKey,
        this.isDocumentationGap,
      );

      const question = accumulateQuestion(this.questions, questionKey);
      question.obligations++;
      question.codes.set(obligation.reasonCode, (question.codes.get(obligation.reasonCode) ?? 0) + 1);
      question.responsibilities.add(obligation.responsibility);
      const cardQuestion = cardQuestions.get(questionKey) ?? {
        obligations: 0,
        documentationObligations: 0,
        issuerReviewedAtSec: null,
      };
      cardQuestion.obligations++;
      if (documentationReason !== null) {
        question.documentationObligations++;
        cardQuestion.documentationObligations++;
        this.documentationReasonDatums.set(
          documentationReason, (this.documentationReasonDatums.get(documentationReason) ?? 0) + 1,
        );
        if (gap !== null) this.documentationGapIds.add(gap.gapId);
      } else if (obligation.cause === "C") {
        question.hasIssuerCause = true;
        const reviewed = reviewedAtSec(gap);
        if (reviewed !== null) {
          if (question.oldestReviewedAtSec === null || reviewed < question.oldestReviewedAtSec) {
            question.oldestReviewedAtSec = reviewed;
          }
          if (question.newestReviewedAtSec === null || reviewed > question.newestReviewedAtSec) {
            question.newestReviewedAtSec = reviewed;
          }
          if (cardQuestion.issuerReviewedAtSec === null || reviewed < cardQuestion.issuerReviewedAtSec) {
            cardQuestion.issuerReviewedAtSec = reviewed;
          }
        }
      }
      cardQuestions.set(questionKey, cardQuestion);
    }
    this.cardQuestions.set(asset.assetId, cardQuestions);
  }

  finish(): V9OpenEvidence {
    if (this.block !== null) return this.block;
    const buckets = new Map<string, V9OpenQuestionBucket>();
    for (const [questionKey, question] of this.questions) {
      buckets.set(
        questionKey,
        bucketFor(question.obligations, question.documentationObligations, question.hasIssuerCause),
      );
    }

    let obligations = 0;
    let openQuestions = 0;
    let issuerQuestions = 0;
    let documentationQuestions = 0;
    let issuerOldestReviewedAtSec: number | null = null;
    let issuerNewestReviewedAtSec: number | null = null;
    const issuerRoots = new Set<string>();
    const owners = new Map<
      V9EvidenceResponsibility | typeof V9_OPEN_EVIDENCE_MIXED_OWNER,
      { questions: number; obligations: number }
    >();
    const reasons = new Map<string, { code: V9ReasonCode; bucket: V9OpenQuestionBucket; questions: number; obligations: number }>();

    for (const [questionKey, question] of this.questions) {
      obligations += question.obligations;
      const bucket = buckets.get(questionKey)!;
      if (bucket === "documentation") {
        documentationQuestions++;
        continue;
      }
      if (bucket === "issuer") {
        issuerQuestions++;
        issuerRoots.add(rootOfQuestionKey(questionKey));
        if (question.oldestReviewedAtSec !== null &&
            (issuerOldestReviewedAtSec === null || question.oldestReviewedAtSec < issuerOldestReviewedAtSec)) {
          issuerOldestReviewedAtSec = question.oldestReviewedAtSec;
        }
        if (question.newestReviewedAtSec !== null &&
            (issuerNewestReviewedAtSec === null || question.newestReviewedAtSec > issuerNewestReviewedAtSec)) {
          issuerNewestReviewedAtSec = question.newestReviewedAtSec;
        }
      } else {
        openQuestions++;
        const responsibility = question.responsibilities.size === 1
          ? [...question.responsibilities][0]!
          : V9_OPEN_EVIDENCE_MIXED_OWNER;
        const owner = owners.get(responsibility) ?? { questions: 0, obligations: 0 };
        owner.questions++;
        owner.obligations += question.obligations;
        owners.set(responsibility, owner);
      }
      for (const [code, count] of question.codes) {
        const reasonKey = `${bucket}\u0000${code}`;
        const reason = reasons.get(reasonKey) ?? { code, bucket, questions: 0, obligations: 0 };
        reason.questions++;
        reason.obligations += count;
        reasons.set(reasonKey, reason);
      }
    }

    const ownerOrder: Record<string, number> = {
      ...Object.fromEntries(
        V9_PUBLIC_EVIDENCE_RESPONSIBILITIES.map((responsibility, index) => [responsibility, index]),
      ),
      [V9_OPEN_EVIDENCE_MIXED_OWNER]: V9_PUBLIC_EVIDENCE_RESPONSIBILITIES.length,
    };
    const ownerRows = [...owners.entries()]
      .filter(([, row]) => row.questions > 0)
      .sort(([left], [right]) => ownerOrder[left]! - ownerOrder[right]!)
      .map(([responsibility, row]) => ({
        responsibility,
        questions: row.questions,
        obligations: row.obligations,
      }));

    const byCard: V9OpenEvidenceByCard[] = [];
    for (const cardId of [...this.cardQuestions.keys()].sort(compareText)) {
      const cardQuestions = this.cardQuestions.get(cardId)!;
      let cardObligations = 0;
      let openBucketQuestionsCarried = 0;
      let inheritedOpenBucketQuestionsCarried = 0;
      let openBucketObligationsCarried = 0;
      let documentationObligationsCarried = 0;
      let issuerNondisclosureReviewedAtSec: number | null = null;
      for (const [questionKey, counts] of cardQuestions) {
        cardObligations += counts.obligations;
        const bucket = buckets.get(questionKey)!;
        if (bucket === "open") {
          openBucketQuestionsCarried++;
          openBucketObligationsCarried += counts.obligations;
          if (rootOfQuestionKey(questionKey) !== cardId) inheritedOpenBucketQuestionsCarried++;
        } else if (bucket === "issuer" && counts.issuerReviewedAtSec !== null) {
          if (issuerNondisclosureReviewedAtSec === null || counts.issuerReviewedAtSec < issuerNondisclosureReviewedAtSec) {
            issuerNondisclosureReviewedAtSec = counts.issuerReviewedAtSec;
          }
        }
        documentationObligationsCarried += counts.documentationObligations;
      }
      if (cardObligations === 0) continue;
      byCard.push({
        id: cardId,
        openBucketQuestionsCarried,
        inheritedOpenBucketQuestionsCarried,
        openBucketObligationsCarried,
        documentationObligationsCarried,
        ...(issuerNondisclosureReviewedAtSec === null ? {} : { issuerNondisclosureReviewedAtSec }),
      });
    }

    const totals: V9OpenEvidenceTotals = {
      questions: this.questions.size,
      open: openQuestions,
      issuer: issuerQuestions,
      documentation: documentationQuestions,
      obligations,
    };
    this.block = {
      semantics: V9_OPEN_EVIDENCE_SEMANTICS,
      totals,
      owners: ownerRows,
      reasons: [...reasons.values()]
        .sort((left, right) => compareText(left.bucket, right.bucket) || compareText(left.code, right.code)),
      documentation: {
        questions: documentationQuestions,
        datums: [...this.documentationReasonDatums.values()].reduce((sum, datums) => sum + datums, 0),
        facts: this.documentationGapIds.size,
        reasons: [...this.documentationReasonDatums.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([reason, datums]) => ({ reason, datums })),
      },
      issuer: {
        questions: issuerQuestions,
        assets: issuerRoots.size,
        oldestReviewedAtSec: issuerOldestReviewedAtSec,
        newestReviewedAtSec: issuerNewestReviewedAtSec,
      },
      byCard,
    };
    // finish seals the counter: only the cached public block is read afterward.
    // Drop both source lookups and accumulators before publication finalization.
    this.gapsById.clear();
    this.authoredControlScopeByKey.clear();
    this.questions.clear();
    this.cardQuestions.clear();
    this.documentationGapIds.clear();
    this.documentationReasonDatums.clear();
    this.cards.clear();
    return this.block;
  }
}

const QUESTION_BUCKET_ORDER: Readonly<Record<V9OpenQuestionBucket, number>> = {
  open: 0,
  issuer: 1,
  documentation: 2,
};

interface ProjectedCardQuestionAccumulator extends CardQuestionAccumulator {
  readonly codes: Map<string, { code: V9ReasonCode; obligations: number; documentation: boolean }>;
}

/**
 * Per-card open-evidence projection over the same cohort accounting
 * `countV9OpenEvidence` runs. Returns every evaluated card (including zero-
 * obligation cards with `questions: []`), using the cohort-wide question bucket
 * so `card` reconciles identically to `openEvidence.byCard` and `questions[]`
 * carries the exact per-datum documentation flag without mirroring
 * `obligationsForCard`.
 */
export function projectV9CardOpenEvidence(
  input: V9OpenEvidenceInput,
): ReadonlyMap<string, V9CardOpenEvidenceProjection> {
  const { gapsById, authoredControlScopeByKey } = indexOpenEvidenceAssets(input.assets);
  const cohortQuestions = new Map<V9QuestionKey, {
    obligations: number;
    documentationObligations: number;
    hasIssuerCause: boolean;
  }>();
  const cardQuestionsByAsset = new Map<string, Map<V9QuestionKey, ProjectedCardQuestionAccumulator>>();

  for (const asset of input.evaluated) {
    if (cardQuestionsByAsset.has(asset.assetId)) {
      throw new Error(`Open-evidence counting received ${asset.assetId} twice`);
    }
    const cardQuestions = new Map<V9QuestionKey, ProjectedCardQuestionAccumulator>();
    for (const obligation of obligationsForCard(asset.trace.unresolvedFacts, gapsById)) {
      const { gap, documentationReason, questionKey } = resolveObligationQuestion(
        asset.assetId,
        obligation,
        authoredControlScopeByKey,
        input.isDocumentationGap,
      );
      const cohortQuestion = cohortQuestions.get(questionKey) ?? {
        obligations: 0,
        documentationObligations: 0,
        hasIssuerCause: false,
      };
      cohortQuestion.obligations++;
      const cardQuestion: ProjectedCardQuestionAccumulator = cardQuestions.get(questionKey) ?? {
        obligations: 0,
        documentationObligations: 0,
        issuerReviewedAtSec: null,
        codes: new Map(),
      };
      cardQuestion.obligations++;
      const isDocumentation = documentationReason !== null;
      if (isDocumentation) {
        cohortQuestion.documentationObligations++;
        cardQuestion.documentationObligations++;
      } else if (obligation.cause === "C") {
        cohortQuestion.hasIssuerCause = true;
        const reviewed = reviewedAtSec(gap);
        if (reviewed !== null && (cardQuestion.issuerReviewedAtSec === null || reviewed < cardQuestion.issuerReviewedAtSec)) {
          cardQuestion.issuerReviewedAtSec = reviewed;
        }
      }
      const codeKey = `${obligation.reasonCode}\u0000${isDocumentation ? "1" : "0"}`;
      const existingCode = cardQuestion.codes.get(codeKey);
      if (existingCode === undefined) {
        cardQuestion.codes.set(codeKey, {
          code: obligation.reasonCode,
          obligations: 1,
          documentation: isDocumentation,
        });
      } else {
        existingCode.obligations++;
      }
      cohortQuestions.set(questionKey, cohortQuestion);
      cardQuestions.set(questionKey, cardQuestion);
    }
    cardQuestionsByAsset.set(asset.assetId, cardQuestions);
  }

  const buckets = new Map<V9QuestionKey, V9OpenQuestionBucket>();
  for (const [questionKey, question] of cohortQuestions) {
    buckets.set(
      questionKey,
      bucketFor(question.obligations, question.documentationObligations, question.hasIssuerCause),
    );
  }

  const projections = new Map<string, V9CardOpenEvidenceProjection>();
  for (const cardId of [...cardQuestionsByAsset.keys()].sort(compareText)) {
    const cardQuestions = cardQuestionsByAsset.get(cardId)!;
    let openBucketQuestionsCarried = 0;
    let inheritedOpenBucketQuestionsCarried = 0;
    let openBucketObligationsCarried = 0;
    let documentationObligationsCarried = 0;
    let issuerNondisclosureReviewedAtSec: number | null = null;
    const questions: V9CardOpenQuestion[] = [];

    for (const [questionKey, counts] of cardQuestions) {
      const bucket = buckets.get(questionKey)!;
      const inherited = rootOfQuestionKey(questionKey) !== cardId;
      if (bucket === "open") {
        openBucketQuestionsCarried++;
        openBucketObligationsCarried += counts.obligations;
        if (inherited) inheritedOpenBucketQuestionsCarried++;
      } else if (bucket === "issuer" && counts.issuerReviewedAtSec !== null) {
        if (issuerNondisclosureReviewedAtSec === null || counts.issuerReviewedAtSec < issuerNondisclosureReviewedAtSec) {
          issuerNondisclosureReviewedAtSec = counts.issuerReviewedAtSec;
        }
      }
      documentationObligationsCarried += counts.documentationObligations;
      questions.push({
        questionKey,
        bucket,
        inherited,
        obligations: counts.obligations,
        codes: [...counts.codes.values()].sort(
          (left, right) => compareText(left.code, right.code) || Number(left.documentation) - Number(right.documentation),
        ),
      });
    }
    questions.sort(
      (left, right) =>
        QUESTION_BUCKET_ORDER[left.bucket] - QUESTION_BUCKET_ORDER[right.bucket] ||
        compareText(left.questionKey, right.questionKey),
    );
    projections.set(cardId, {
      card: {
        id: cardId,
        openBucketQuestionsCarried,
        inheritedOpenBucketQuestionsCarried,
        openBucketObligationsCarried,
        documentationObligationsCarried,
        ...(issuerNondisclosureReviewedAtSec === null ? {} : { issuerNondisclosureReviewedAtSec }),
      },
      questions,
    });
  }
  return projections;
}

/**
 * Streaming counter for the publication build: the compact path can feed one
 * evaluated asset at a time and release it, while the compiled gap table stays
 * readable for the same cohort. `countV9OpenEvidence` is the batch wrapper.
 */
export function createV9OpenEvidenceCounter<Gap extends V9OpenEvidenceGap>(
  assets: readonly V9OpenEvidenceAsset<Gap>[],
  isDocumentationGap: (gap: Gap) => V9DocumentationReason | null,
): V9OpenEvidenceCounter {
  return new OpenEvidenceCounter(assets, isDocumentationGap);
}

/** Server-computed three-number block over a whole cohort (PLAN §2.1, ImplCounting §3.3). */
export function countV9OpenEvidence(input: V9OpenEvidenceInput): V9OpenEvidence {
  const counter = createV9OpenEvidenceCounter(input.assets, input.isDocumentationGap);
  for (const asset of input.evaluated) counter.add(asset);
  return counter.finish();
}
