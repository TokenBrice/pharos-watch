import type {
  ReportCardsV9CurrentResponse,
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";
import type { V9ReasonCode } from "@shared/types";
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-facts";
import {
  V9_OPEN_EVIDENCE_MIXED_OWNER,
  type V9OpenEvidence,
  type V9OpenQuestionBucket,
} from "@shared/types/safety-score-v9-public";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { formatProseList, formatShortDate } from "@shared/lib/format";

/**
 * Plain-English labels for the public V9 reason codes. The enum values are
 * evaluator identifiers, not reader-facing copy, so every code surfaced in the
 * data-coverage module carries an explicit label instead of a humanized slug.
 *
 * Retired codes keep their label. The static page bundle and the Worker that
 * serves the report cards deploy independently, so a client can be handed a
 * payload authored either side of a methodology bump; an unlabelled code would
 * render an empty inventory row. Completeness for live codes is enforced below.
 */
const REASON_CODE_LABELS = {
  // Neutral on cause, because the code carries two shapes: a component the
  // reviewer has not covered yet, and one the reviewer covered and found the
  // issuer does not publish (methodology 9.451). "Review incomplete" was false
  // for the second, which is most of them; the gap's own message now says which
  // shape it is, including the source checked and the date.
  "bounded-mechanism-review": "A mechanism detail is unresolved",
  "bounded-unknown-reserve-exposure": "Part of the reserve is unidentified",
  "correlated-exit-routes": "Exit routes share the same failure point",
  "critical-unresolved": "A rating-critical input is unresolved",
  "future-dated-input-fact": "An input is dated in the future",
  "historical-critical-input": "A rating-critical input is out of date",
  // Retired by methodology 9.04; label retained per the note above.
  "immaterial-unrecognized-chain-pool": "Small liquidity pool not recognized",
  "implementation-parent-cycle": "Circular dependency on a parent asset",
  "incomparable-route-requests": "Exit routes cannot be compared like for like",
  // Reads true for both shapes this code now covers: a partly covered surface,
  // and one with no reviewed pool at all because a deployment chain has no
  // registered discovery provider (v9.04 reclassification).
  "incomplete-dex-route-coverage": "DEX exit routes not fully covered",
  "incomplete-oracle-liquidation-branch": "Oracle liquidation path only partly reviewed",
  "inherited-access-exposure": "Freeze exposure inherited from a reviewed upstream asset",
  "reviewed-possible-access": "Freeze reach reviewed as possible, not proven",
  "insufficient-evidence": "Not enough evidence to rate this input",
  "material-bridge-supply-unmatched": "Bridged supply does not reconcile",
  "material-dependency-unavailable": "A material dependency could not be scored",
  "material-reserve-slice-unstructured": "Part of the reserve is not itemized",
  "material-unknown-reserve-exposure": "A material reserve holding is unidentified",
  "mint-control-question": "Open question about mint control",
  "missing-applicable-peg": "No applicable peg reference",
  "missing-archetype": "Mechanism archetype not classified",
  "missing-bridge-route-rows": "Bridge route data not available",
  "missing-bridge-routes": "Bridge routes not mapped",
  "missing-custody-profile": "Custody arrangements not published",
  "missing-implementation-date": "Implementation date unknown",
  "missing-latest-assurance-report": "No current attestation or audit",
  "missing-mint-authority": "Mint authority not identified",
  "missing-oracle-profile": "Oracle setup not documented",
  "missing-parent-score": "Parent asset has no score",
  "missing-peg-input": "Peg reference data missing",
  "peg-price-unavailable-adverse-history": "No usable price, and the peg record is adverse",
  "peg-supply-floor-withheld": "Peg deviation withheld below the $1M supply floor",
  "missing-pillar": "A scoring pillar has no inputs",
  "missing-access-review": "Transfer and freeze powers not reviewed",
  "missing-pillar-evidence": "A scoring pillar has no evidence",
  "missing-required-oracle-branches": "Required oracle paths not documented",
  "missing-reserve-composition": "Reserve composition not published",
  // Neutral on cause: the same code now covers a feed that did not deliver and
  // a chain Pharos has no discovery provider for. "No observation" is true of
  // both; "unavailable" implied a failure that did not always happen.
  "missing-runtime-route-evidence": "No live exit-route observation",
  "missing-same-notional-route": "No exit route at the tested size",
  "missing-upgrade-control": "Upgrade controls not identified",
  "missing-upgradeability-review": "Contract upgradeability not reviewed",
  "nonmaterial-bridge-supply-unmatched": "A trace of supply is not mapped to a bridge route",
  "nonmaterial-dependency-unavailable": "A minor dependency could not be scored",
  "no-viable-exit-path": "No viable exit path found",
  "oracle-topology-undisclosed": "The issuer has not disclosed the oracle topology",
  "parent-cycle": "Circular dependency between assets",
  // Neutral on cause: most carriers are wrappers whose inherited parent
  // exposure has no live verification, not reviews someone left unfinished;
  // the same code also covers a genuinely partial standalone review.
  "partial-reserve-review": "Reserve backing only partly verified",
  "runtime-bridge-materiality-unavailable": "Live bridge exposure unavailable",
  "scoped-control-question": "Reviewer-scoped control question open",
  "selected-bridge-route-missing": "Selected bridge route not found",
  "stale-audited-reserve-composition": "Audited reserve composition not current",
  "selected-bridge-route-unresolved": "Selected bridge route unresolved",
  "unknown-control-cap-authority": "Supply-cap authority unknown",
  "unknown-control-mint-ability": "Mint ability unknown",
  "unknown-upgrade-authority": "Upgrade authority unknown",
  "unresolved-control-identity": "Controlling entity not identified",
  "unresolved-exit-output": "Exit route payout asset unresolved",
  "unresolved-mint-authority": "Mint authority unresolved",
  "unresolved-oracle-branch-applicability": "Oracle path applicability unresolved",
  "unsupported-same-notional-route": "Exit route cannot be tested at size",
  "unproven-settlement-bound": "Settlement bound unproven",
  // The collateral identities are reviewed; what is absent is their
  // reconciliation against a measured reserve envelope, which for an asset with
  // no live-reserve adapter no method can produce at all.
  "unreviewed-dependency-relationships": "Dependency relationships not reconciled with reserves",
  "unreviewed-oracle-profile": "Oracle setup not reviewed",
  "unreviewed-reserve-envelope": "Reserve scope not reviewed",
  "partial-evidence-pipeline-gap": "Partial evidence",
  "single-pillar-pipeline-gap": "Only one pillar available — pipeline gap",
  "all-pillars-pipeline-gap": "No pillars available — pipeline gap",
  "f-without-measured-adverse": "Score below the F threshold without a measured adverse fact",
} satisfies Record<string, string>;

/** Compile-time guard: every live reason code must carry a label. */
const _liveReasonCodeLabels: Record<V9ReasonCode, string> = REASON_CODE_LABELS;

/** Reader-facing label for a stored reason code; archived payloads may carry unknown codes. */
export function formatV9ReasonCodeLabel(code: string): string {
  return (REASON_CODE_LABELS as Record<string, string>)[code] ?? code.replace(/-/g, " ");
}

/**
 * Documentation-reason labels are policy-owned (`semantic.evidence.documentation`
 * `reasons[].publicLabel`) so the classification and its public wording ship
 * together. The block is absent on a T1 tree and on a pre-T2 policy, so the
 * lookup stays nullable and the inventory degrades visibly instead of dropping
 * rows.
 */
const DOCUMENTATION_REASON_LABELS: Readonly<Record<string, string>> | null = (() => {
  const block = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.documentation;
  if (!block) return null;
  return Object.fromEntries(block.reasons.map((entry) => [entry.reason, entry.publicLabel]));
})();

/**
 * Reader-facing owner of a gap. `measured-adverse` is excluded from the module:
 * it records a measured negative finding, not an absence of data.
 */
const GAP_OWNERS = [
  {
    responsibility: "issuer-undisclosed",
    label: "Issuer does not disclose",
    detail: "Research found the issuer does not publish the required datum.",
  },
  {
    responsibility: "integration-missing",
    label: "Pharos has not integrated it yet",
    detail: "A source exists; wiring it into the pipeline is our work.",
  },
  {
    responsibility: "producer-failed",
    label: "A data feed failed",
    detail: "An upstream source we rely on did not deliver.",
  },
  {
    responsibility: "method-unsupported",
    label: "No supported method",
    detail: "No method can measure this input for this asset yet. Nothing upstream failed.",
  },
  {
    responsibility: "published-evidence-expired",
    label: "Published evidence is out of date",
    detail: "Freshness is separate from cause: an expired copy does not prove issuer non-disclosure.",
  },
  {
    responsibility: "unresearched",
    label: "Unresolved",
    detail: "No admissible evidence settles this input yet: it is unresearched or was researched without a conclusive source. This is not a claim of issuer silence.",
  },
  {
    responsibility: "public-data-uncurated",
    label: "Awaiting curation",
    detail: "The required datum is public but has not yet been curated.",
  },
] as const satisfies ReadonlyArray<{
  responsibility: V9EvidenceResponsibility;
  label: string;
  detail: string;
}>;

const GAP_OWNER_BY_RESPONSIBILITY = new Map<string, (typeof GAP_OWNERS)[number]>(
  GAP_OWNERS.map((owner) => [owner.responsibility, owner]),
);

/** Multi-owner remainder of the headline bucket; it is not a responsibility. */
const MIXED_OWNER = {
  responsibility: V9_OPEN_EVIDENCE_MIXED_OWNER,
  label: "Several owners",
  detail: "The inputs behind this question have different owners, so no single cause applies.",
} as const;

export interface DataCoverageGapOwner {
  responsibility: V9EvidenceResponsibility | typeof V9_OPEN_EVIDENCE_MIXED_OWNER;
  label: string;
  detail: string;
  /** Headline questions owned here; the owner rows partition the open bucket. */
  questions: number;
  obligations: number;
  /** Share of the open bucket, not of every published obligation. */
  share: number;
}

export interface DataCoverageReasonGap {
  code: string;
  bucket: V9OpenQuestionBucket;
  label: string;
  /** Questions carrying the reason; null for documentation rows (datums only). */
  questions: number | null;
  /** Datums (documentation) or questions (open/issuer) behind the row. */
  count: number;
  countUnit: "questions" | "datums";
}

/**
 * The server-computed three-number block, formatted for display. Every count is
 * copied from `openEvidence`; this module never re-derives one (R5).
 */
export interface DataCoverageOpenEvidence {
  semantics: V9OpenEvidence["semantics"];
  questions: number;
  open: number;
  issuer: number;
  documentation: number;
  obligations: number;
  documentationDatums: number;
  documentationFacts: number;
  /** Recorded review window behind the issuer bucket; null when nobody is dated. */
  issuerReview: { oldestReviewedAtSec: number; newestReviewedAtSec: number } | null;
}

export interface DataCoverageHold {
  heldSinceSec: number | null;
  /** One reader-facing sentence per distinct cause. */
  causes: string[];
}

export interface DataCoverageModel {
  assetCount: number;
  ratedCount: number;
  notRatedCount: number;
  pipelineGapCount: number;
  partialRatedCount: number;
  inputsEvaluated: number;
  inputsByPillar: Array<{ key: "backing" | "exit" | "control"; label: string; count: number }>;
  backingKnownCount: number;
  backingObservedCount: number;
  criticalGapCount: number;
  /**
   * Null when the payload predates schema 8 or a cached response omits the
   * block. Unavailable is not zero: the module says so instead of rendering 0.
   */
  openEvidence: DataCoverageOpenEvidence | null;
  gapOwners: DataCoverageGapOwner[];
  reasons: DataCoverageReasonGap[];
  hold: DataCoverageHold | null;
}

function assetLabel(assetId: string): string {
  return CLIENT_TRACKED_META_BY_ID.get(assetId)?.symbol ?? assetId;
}

function assetListLabel(assetIds: readonly string[]): string {
  // Deliberately un-Oxford: this label reads inline inside a sentence.
  return formatProseList(assetIds.map(assetLabel), { oxford: false });
}

/**
 * Collapses the publication hold reasons into reader-facing sentences. Producer
 * failures repeat per asset and per reason code, so they fold into a single
 * asset-scoped sentence. Assessment detail is never echoed: it carries internal
 * validation paths.
 */
export function describeDataCoverageHoldCauses(
  reasons: readonly V9PublicationHoldReason[],
): string[] {
  const causes: string[] = [];
  const producerAssetIds = [
    ...new Set(
      reasons.flatMap((reason) =>
        reason.code === "producer-failed-pipeline-gap"
          ? [reason.assetId]
          : [],
      ),
    ),
  ].sort();
  if (producerAssetIds.length > 0) {
    causes.push(
      `${producerAssetIds.length} ${producerAssetIds.length === 1 ? "asset" : "assets"} (${assetListLabel(producerAssetIds)}) rely on a data feed that did not deliver.`,
    );
  }
  for (const reason of reasons) {
    if (reason.code === "dex-stale") causes.push("DEX liquidity data is behind schedule.");
    if (reason.code === "dex-unavailable") causes.push("DEX liquidity data is unavailable.");
    if (reason.code === "redemption-stale") causes.push("Redemption data is behind schedule.");
    if (reason.code === "redemption-unavailable") causes.push("Redemption data is unavailable.");
    if (reason.code === "live-reserves-unavailable") causes.push("Live reserve data is unavailable.");
    if (reason.code === "live-reserves-coverage-below-floor") {
      causes.push("Live reserve coverage is below the publication floor.");
    }
    if (reason.code === "assessment-failed") causes.push("The latest ratings update could not be verified.");
    if (reason.code === "coverage-floor-failed") {
      causes.push(
        `Coverage fell below the required floor for ${reason.floorIds.length} ${reason.floorIds.length === 1 ? "check" : "checks"}.`,
      );
    }
  }
  return [...new Set(causes)];
}

const PILLAR_LABELS = [
  ["backing", "Backing"],
  ["exit", "Exit"],
  ["control", "Econ. control"],
] as const;

/** Keeps the reason inventory grouped by bucket, headline first, then by size. */
const REASON_BUCKET_ORDER: Record<V9OpenQuestionBucket, number> = {
  open: 0,
  issuer: 1,
  documentation: 2,
};

function buildOwners(evidence: V9OpenEvidence): DataCoverageGapOwner[] {
  const openTotal = evidence.totals.open;
  return evidence.owners
    .filter((owner) => owner.questions > 0)
    .map((owner) => {
      const descriptor = owner.responsibility === V9_OPEN_EVIDENCE_MIXED_OWNER
        ? MIXED_OWNER
        : GAP_OWNER_BY_RESPONSIBILITY.get(owner.responsibility);
      return {
        responsibility: owner.responsibility,
        label: descriptor?.label ?? "Owner not identified",
        detail: descriptor?.detail ?? "The publication did not name the owner of these inputs.",
        questions: owner.questions,
        obligations: owner.obligations,
        share: openTotal === 0 ? 0 : owner.questions / openTotal,
      };
    })
    .sort(
      (left, right) =>
        right.questions - left.questions ||
        left.responsibility.localeCompare(right.responsibility),
    );
}

function buildReasons(evidence: V9OpenEvidence): DataCoverageReasonGap[] {
  const rows: DataCoverageReasonGap[] = [
    ...evidence.reasons.map((row) => ({
      code: row.code,
      bucket: row.bucket,
      label: formatV9ReasonCodeLabel(row.code),
      questions: row.questions,
      count: row.questions,
      countUnit: "questions" as const,
    })),
    ...evidence.documentation.reasons.map((row) => {
      // Fallback only for a bundle older than the policy block that supplied the label.
      const words = row.reason.replace(/-/g, " ");
      return {
        code: row.reason,
        bucket: "documentation" as const,
        label: DOCUMENTATION_REASON_LABELS?.[row.reason]
          ?? `${words.charAt(0).toUpperCase()}${words.slice(1)}`,
        questions: null,
        count: row.datums,
        countUnit: "datums" as const,
      };
    }),
  ];
  return rows
    .filter((row) => row.count > 0)
    .sort(
      (left, right) =>
        REASON_BUCKET_ORDER[left.bucket] - REASON_BUCKET_ORDER[right.bucket] ||
        right.count - left.count ||
        left.code.localeCompare(right.code),
    );
}

function buildOpenEvidence(evidence: V9OpenEvidence): DataCoverageOpenEvidence {
  const issuerReview =
    evidence.issuer.oldestReviewedAtSec !== null && evidence.issuer.newestReviewedAtSec !== null
      ? {
          oldestReviewedAtSec: evidence.issuer.oldestReviewedAtSec,
          newestReviewedAtSec: evidence.issuer.newestReviewedAtSec,
        }
      : null;
  return {
    semantics: evidence.semantics,
    questions: evidence.totals.questions,
    open: evidence.totals.open,
    issuer: evidence.totals.issuer,
    documentation: evidence.totals.documentation,
    obligations: evidence.totals.obligations,
    documentationDatums: evidence.documentation.datums,
    documentationFacts: evidence.documentation.facts,
    issuerReview,
  };
}

/**
 * Dated, terminal issuer copy. Only recorded review dates are published, and an
 * undated bucket keeps the non-disclosure statement without a date (R2: a
 * failed or absent read never becomes a positive claim).
 */
export function describeIssuerReview(
  review: NonNullable<DataCoverageOpenEvidence["issuerReview"]>,
): string {
  const oldest = formatShortDate(new Date(review.oldestReviewedAtSec * 1000), { utc: true });
  const newest = formatShortDate(new Date(review.newestReviewedAtSec * 1000), { utc: true });
  const window = oldest === newest ? oldest : `${oldest} – ${newest}`;
  return `Reviewed ${window}; the issuer does not publish this datum.`;
}

export function buildDataCoverageModel(
  response: ReportCardsV9CurrentResponse | null | undefined,
): DataCoverageModel | null {
  if (!response) return null;

  const inputsByPillar = { backing: 0, exit: 0, control: 0 };
  let backingKnownCount = 0;
  let backingObservedCount = 0;
  let criticalGapCount = 0;

  for (const card of response.cards) {
    const responsibility = card.scoreTrace.evidenceResponsibility;
    for (const summary of responsibility.summaries) {
      criticalGapCount += summary.criticalFactCount ?? 0;
    }

    if (card.breakdowns === null) continue;
    inputsByPillar.backing += card.breakdowns.backing.components.length;
    inputsByPillar.exit += card.breakdowns.exit.primaryRoute?.components.length ?? 0;
    inputsByPillar.control += card.breakdowns.control.components.length;
    for (const component of card.breakdowns.backing.components) {
      backingObservedCount += 1;
      if (component.observationState === "known") backingKnownCount += 1;
    }
  }

  const openEvidence = response.openEvidence ? buildOpenEvidence(response.openEvidence) : null;

  return {
    assetCount: response.completeness.expectedCount,
    ratedCount: response.completeness.ratedCount,
    notRatedCount: response.completeness.notRatedCount,
    pipelineGapCount: response.completeness.pipelineGapCount,
    partialRatedCount: response.cards.filter((card) => card.ratingStatus === "rated" && card.partialEvidence !== null).length,
    inputsEvaluated: inputsByPillar.backing + inputsByPillar.exit + inputsByPillar.control,
    inputsByPillar: PILLAR_LABELS.map(([key, label]) => ({ key, label, count: inputsByPillar[key] })),
    backingKnownCount,
    backingObservedCount,
    criticalGapCount,
    openEvidence,
    gapOwners: response.openEvidence ? buildOwners(response.openEvidence) : [],
    reasons: response.openEvidence ? buildReasons(response.openEvidence) : [],
    hold:
      response.publicationHealth.status === "held"
        ? {
            heldSinceSec: response.publicationHealth.heldSinceSec,
            causes: describeDataCoverageHoldCauses(response.publicationHealth.reasons),
          }
        : null,
  };
}
