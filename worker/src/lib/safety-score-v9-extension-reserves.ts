import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { V9_SCORE_BEARING_GATES_POLICY_V923 } from "@shared/lib/safety-score-v9/score-bearing-gates-policy";
import {
  RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT,
  validateReserveCompositionTotal,
  type ReserveSlice,
} from "@shared/types/reserves";
import { computeSafetyScoreV9ReserveExposureKey } from "./safety-score-v9-fact-set";
import {
  confidenceForResearch,
  conservativeDateEndSec,
  type ExtensionAsset,
  type ReserveClassification,
  type ReviewEvidenceBuilder,
  type V9ExtensionRegistryMeta,
} from "./safety-score-v9-extension-shared";

const REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC =
  V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry.reviewedReserveClassificationMaxAgeSec;

export function buildSafetyScoreV9ReserveClassifications(slices: readonly ReserveSlice[]) {
  const byKey = new Map<string, ReserveSlice>();
  for (const slice of slices) {
    const key = computeSafetyScoreV9ReserveExposureKey(slice);
    if (!byKey.has(key)) byKey.set(key, slice);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([exposureKey, slice]) => {
      const issuerOrObligorKey = slice.issuerOrObligor ?? (slice.coinId ? `asset:${slice.coinId}` : null);
      return {
        exposureKey,
        classificationKey: `source-native:${exposureKey}`,
        assetClass: slice.assetClass ?? (slice.coinId ? ("stablecoin" as const) : null),
        issuerOrObligorKey,
        riskFactors: [...(slice.riskFactors ?? [])].sort(compareText),
        liquidityHorizon: slice.liquidityHorizon ?? null,
        maturityDaysMax: slice.maturityDaysMax ?? null,
        failureDomains: issuerOrObligorKey ? [{ kind: "reserve-issuer" as const, key: issuerOrObligorKey }] : [],
        trackedAssetId: slice.coinId ?? null,
      };
    });
}

function normalizedReserveName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function reserveSlicesMatch(live: ReserveSlice, reviewed: ReserveSlice): boolean {
  if (live.sourceKey) return reviewed.sourceKey === live.sourceKey;
  const normalizedName = normalizedReserveName(live.name);
  return normalizedName.length > 0 && normalizedName === normalizedReserveName(reviewed.name);
}

function overlayReviewedReserveClassification(
  classification: ReserveClassification,
  live: ReserveSlice,
  reviewed: ReserveSlice,
  reviewKey: string,
  reviewedNonLink: boolean,
): ReserveClassification {
  const assetClass = live.assetClass ?? reviewed.assetClass ?? null;
  const issuerOrObligorKey =
    live.issuerOrObligor ?? reviewed.issuerOrObligor ?? (reviewed.coinId ? `asset:${reviewed.coinId}` : null);
  const riskFactors = live.riskFactors?.length ? [...live.riskFactors] : [...(reviewed.riskFactors ?? [])];
  const liquidityHorizon = live.liquidityHorizon ?? reviewed.liquidityHorizon ?? null;
  const maturityDaysMax = live.maturityDaysMax ?? reviewed.maturityDaysMax ?? null;
  const trackedAssetId = live.coinId ?? reviewed.coinId ?? null;
  const usesReviewedMetadata =
    (live.assetClass == null && reviewed.assetClass != null) ||
    (live.issuerOrObligor == null && (reviewed.issuerOrObligor != null || reviewed.coinId != null)) ||
    (live.coinId == null && reviewed.coinId != null) ||
    (!live.riskFactors?.length && Boolean(reviewed.riskFactors?.length)) ||
    (live.liquidityHorizon == null && reviewed.liquidityHorizon != null) ||
    (live.maturityDaysMax == null && reviewed.maturityDaysMax != null);

  if (!usesReviewedMetadata && !reviewedNonLink) return classification;
  return {
    ...classification,
    classificationKey: `registry-reviewed:${classification.exposureKey}:${reviewKey}`,
    assetClass,
    issuerOrObligorKey,
    riskFactors: [...new Set(riskFactors)].sort(compareText),
    liquidityHorizon,
    maturityDaysMax,
    ...(reviewedNonLink
      ? { trackedAssetId: null }
      : trackedAssetId
        ? { trackedAssetId }
        : {}),
    ...(reviewedNonLink ? { trackedAssetDisposition: "reviewed-non-link" as const } : {}),
    failureDomains: issuerOrObligorKey
      ? [{ kind: "reserve-issuer", key: issuerOrObligorKey }]
      : classification.failureDomains,
  };
}

interface ReviewedReserveMatch {
  liveIndex: number;
  reviewedIndex: number;
  reviewed: ReserveSlice;
}

function reviewedReserveMatches(
  liveReserves: readonly ReserveSlice[],
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  classificationMaxAgeSec = REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC,
): ReviewedReserveMatch[] {
  const reviewedReserves = meta.reserves ?? [];
  const review = meta.reserveReview;
  const reviewedAtSec = review ? Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1_000 : Number.NaN;
  const compositionAsOfSec = review?.compositionAsOf
    ? Date.parse(`${review.compositionAsOf}T00:00:00.000Z`) / 1_000
    : null;
  if (
    reviewedReserves.length === 0 ||
    review?.scope !== "full-composition" ||
    review.confidence === "unknown" ||
    !Number.isFinite(reviewedAtSec) ||
    reviewedAtSec > clockSec ||
    clockSec - reviewedAtSec > classificationMaxAgeSec ||
    (compositionAsOfSec !== null && (!Number.isFinite(compositionAsOfSec) || compositionAsOfSec > clockSec))
  ) {
    return [];
  }
  const reviewedCandidatesByLive = liveReserves.map((live) =>
    reviewedReserves
      .map((reviewed, reviewedIndex) => ({ reviewed, reviewedIndex }))
      .filter(({ reviewed }) => reserveSlicesMatch(live, reviewed)),
  );
  const liveCandidateCountByReviewed = reviewedReserves.map((reviewed) =>
    liveReserves.filter((live) => reserveSlicesMatch(live, reviewed)).length,
  );
  return reviewedCandidatesByLive.flatMap((candidates, liveIndex) => {
    if (candidates.length !== 1) return [];
    const candidate = candidates[0]!;
    return liveCandidateCountByReviewed[candidate.reviewedIndex] === 1
      ? [{ liveIndex, reviewedIndex: candidate.reviewedIndex, reviewed: candidate.reviewed }]
      : [];
  });
}

export function dependencyReserveSlices(
  liveReserves: readonly ReserveSlice[],
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): ReserveSlice[] {
  const reviewedMatches = reviewedReserveMatches(liveReserves, meta, clockSec);
  const reviewedByLiveIndex = new Map(
    reviewedMatches.map((match) => [match.liveIndex, match.reviewed]),
  );
  const nonLinkReviewedIndexes = new Set(
    meta.reserveReview?.nonLinkDispositions?.map((disposition) => disposition.reserveIndex) ?? [],
  );
  const nonLinkLiveIndexes = new Set(
    reviewedMatches
      .filter((match) => nonLinkReviewedIndexes.has(match.reviewedIndex))
      .map((match) => match.liveIndex),
  );
  return liveReserves.map((slice, liveIndex) => {
    if (nonLinkLiveIndexes.has(liveIndex)) {
      const { coinId: _coinId, depType: _depType, ...unlinked } = slice;
      return unlinked;
    }
    const reviewed = reviewedByLiveIndex.get(liveIndex);
    if (!reviewed?.coinId || slice.coinId) return slice;
    return {
      ...slice,
      coinId: reviewed.coinId,
      ...(reviewed.depType ? { depType: reviewed.depType } : {}),
    };
  });
}

/**
 * Bridges reviewed registry classifications onto live reserve identities.
 * Explicit source keys match exactly and fail closed; historical unkeyed rows
 * use a unique normalized-name match. Percentage weights are never identity.
 */
export function buildReviewedReserveClassifications(
  liveReserves: readonly ReserveSlice[],
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  classificationMaxAgeSec = REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC,
): ReserveClassification[] {
  const classifications = buildSafetyScoreV9ReserveClassifications(liveReserves);
  const review = meta.reserveReview;
  if (!review) return classifications;
  const nonLinkReviewedIndexes = new Set(
    review.nonLinkDispositions?.map((disposition) => disposition.reserveIndex) ?? [],
  );
  const reviewedByExposureKey = new Map<string, { reviewed: ReserveSlice; reviewedNonLink: boolean }>();
  const liveByExposureKey = new Map(liveReserves.map((live) => [computeSafetyScoreV9ReserveExposureKey(live), live]));

  for (const match of reviewedReserveMatches(liveReserves, meta, clockSec, classificationMaxAgeSec)) {
    const exposureKey = computeSafetyScoreV9ReserveExposureKey(liveReserves[match.liveIndex]!);
    reviewedByExposureKey.set(exposureKey, {
      reviewed: match.reviewed,
      reviewedNonLink: nonLinkReviewedIndexes.has(match.reviewedIndex),
    });
  }

  const reviewKey = domainDigest("safety-score-v9.reserve-classification-review.v1", review).slice(0, 16);
  return classifications.map((classification) => {
    const live = liveByExposureKey.get(classification.exposureKey);
    const match = reviewedByExposureKey.get(classification.exposureKey);
    return live && match
      ? overlayReviewedReserveClassification(
          classification,
          live,
          match.reviewed,
          reviewKey,
          match.reviewedNonLink,
        )
      : classification;
  });
}

type ReviewedStaticReserveRows = NonNullable<ExtensionAsset["reviewedStaticReserveRows"]>;

const CORROBORATING_ASSURANCE_METHODS = new Set([
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
]);
const DIRECT_RESERVE_ASSURANCE_METHODS = new Set(["audit", "examination"]);
const ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC =
  V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry.issuerAttestedReserveMaxAgeSec;
const REVIEWED_RESERVE_COMPOSITION_MAX_AGE_SEC =
  V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry.reviewedReserveCompositionMaxAgeSec;
const REVIEWED_RESERVE_COMPOSITION_GRACE_SEC =
  V9_SCORE_BEARING_GATES_POLICY_V923.evidenceExpiry.reviewedReserveCompositionGraceSec;
// Monthly reports commonly land in the first week after month-end. The grace
// covers that publication lag without extending composition into a second cycle.
const REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC =
  REVIEWED_RESERVE_COMPOSITION_MAX_AGE_SEC + REVIEWED_RESERVE_COMPOSITION_GRACE_SEC;
const UNRESOLVED_CURATED_RESERVE_DISPOSITIONS = new Set(["basket-needs-split", "insufficient-evidence"]);

function normalizeReviewedStaticReserveRows(rows: readonly ReserveSlice[]): ReserveSlice[] {
  const sorted = [...rows].sort(
    (left, right) =>
      compareText(computeSafetyScoreV9ReserveExposureKey(left), computeSafetyScoreV9ReserveExposureKey(right)) ||
      compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right)),
  );
  const totalPct = sorted.reduce((sum, row) => sum + row.pct, 0);
  if (totalPct === 100) return sorted;
  if (Math.abs(totalPct - 100) > RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT) {
    throw new Error("Issuer-attested reserve normalization exceeded the approved composition tolerance");
  }
  const scale = 100 / totalPct;
  let normalizedPct = 0;
  return sorted.map((row, index) => {
    const pct = index === sorted.length - 1 ? 100 - normalizedPct : row.pct * scale;
    normalizedPct += pct;
    return { ...row, pct };
  });
}

function hasDirectIndependentReserveAssurance(meta: V9ExtensionRegistryMeta): boolean {
  const review = meta.reserveReview;
  const report = meta.proofOfReserves?.latestReport;
  if (!review || !report) return false;
  const reportSourceUrls = new Set(report.sources.map((source) => source.url));
  const transparencyIndexUrl = meta.proofOfReserves?.url;
  return (
    review.confidence === "verified" &&
    report.confidence === "verified" &&
    DIRECT_RESERVE_ASSURANCE_METHODS.has(report.assuranceMethod) &&
    report.scope === "assets-and-liabilities" &&
    report.liabilityReconciliation === "full" &&
    review.sources.some(
      (source) =>
        reportSourceUrls.has(source.url) &&
        source.url !== transparencyIndexUrl,
    )
  );
}

/**
 * D6: admit reviewed static rows only when an independent attestor corroborates
 * a prudential issuer. Rows directly reconciled by a verified audit or
 * examination retain independent evidence strength; corroborated issuer rows
 * keep the candidate policy's confidence haircut.
 */
export function buildSafetyScoreV9ReviewedStaticReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): ReviewedStaticReserveRows | null {
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const proof = meta.proofOfReserves;
  const report = proof?.latestReport;
  const attestorIndependent =
    proof?.attestorTier === "big4" || proof?.attestorTier === "regional" || proof?.attestorTier === "niche";
  const reviewAtSec = review ? conservativeDateEndSec(review.reviewedAt, clockSec) : null;
  const compositionAtSec = conservativeDateEndSec(review?.compositionAsOf, clockSec);
  const reportAtSec = report ? conservativeDateEndSec(report.publishedAt, clockSec) : null;
  const periodEndSec = report ? conservativeDateEndSec(report.periodEnd, clockSec) : null;
  if (
    rows.length === 0 ||
    review?.scope !== "full-composition" ||
    review.confidence === "unknown" ||
    review.sources.length === 0 ||
    reviewAtSec === null ||
    compositionAtSec === null ||
    !validateReserveCompositionTotal(rows, "full") ||
    meta.mintAuthority?.supervision !== "prudential" ||
    proof?.type !== "independent-audit" ||
    !attestorIndependent ||
    !proof.provider?.trim() ||
    report === undefined ||
    report.confidence === "unknown" ||
    report.sources.length === 0 ||
    reportAtSec === null ||
    periodEndSec === null ||
    compositionAtSec !== periodEndSec ||
    reportAtSec < periodEndSec ||
    clockSec - compositionAtSec > ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC ||
    !CORROBORATING_ASSURANCE_METHODS.has(report.assuranceMethod)
  ) {
    return null;
  }
  const evidenceClass = hasDirectIndependentReserveAssurance(meta) ? "independent" : "issuer-attested";
  return {
    rows: normalizeReviewedStaticReserveRows(rows),
    evidenceClass,
    provenance: "curated",
  };
}

/**
 * Validate a reviewed registry composition shared by the fallback and
 * standalone admission paths. This is weaker than direct assurance and
 * therefore retains the policy's static-evidence confidence discount.
 */
function buildSafetyScoreV9ReviewedCuratedReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  provenance: "curated" | "curated-fallback",
): ReviewedStaticReserveRows | null {
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const reviewedAtSec = conservativeDateEndSec(review?.reviewedAt, clockSec);
  const compositionAtSec = conservativeDateEndSec(review?.compositionAsOf, clockSec);
  if (
    rows.length === 0 ||
    review?.scope !== "full-composition" ||
    review.confidence !== "verified" ||
    review.knownUnknownExposurePct !== 0 ||
    review.nonLinkDispositions?.some((disposition) =>
      UNRESOLVED_CURATED_RESERVE_DISPOSITIONS.has(disposition.disposition),
    ) === true ||
    review.sources.length === 0 ||
    reviewedAtSec === null ||
    compositionAtSec === null ||
    reviewedAtSec < compositionAtSec ||
    clockSec - compositionAtSec > REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC ||
    !validateReserveCompositionTotal(rows, "full")
  ) {
    return null;
  }
  return {
    rows: normalizeReviewedStaticReserveRows(rows),
    evidenceClass: "static-validated",
    provenance,
  };
}

export function buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): ReviewedStaticReserveRows | null {
  if (meta.liveReservesConfig == null) return null;
  return buildSafetyScoreV9ReviewedCuratedReserveRows(meta, clockSec, "curated-fallback");
}

/**
 * Assets without a live-reserve producer may use the same tightly bounded
 * reviewed composition as a static input. Wrappers remain parent-inherited so
 * a child cannot duplicate or replace the parent's backing facts.
 */
export function buildSafetyScoreV9ReviewedStandaloneReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
): ReviewedStaticReserveRows | null {
  if (meta.liveReservesConfig != null || meta.variantOf != null) return null;
  return buildSafetyScoreV9ReviewedCuratedReserveRows(meta, clockSec, "curated");
}

export function addReviewedStaticReserveEvidence(
  meta: V9ExtensionRegistryMeta,
  admitted: ReviewedStaticReserveRows | null,
  evidence: ReviewEvidenceBuilder,
): void {
  const review = meta.reserveReview;
  if (!admitted || !review) return;
  if (admitted.evidenceClass === "static-validated") {
    evidence.add({
      componentKeys: [
        "reviewed-static-reserves",
        ...admitted.rows.map((row) => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}`),
      ],
      sourceId:
        admitted.provenance === "curated-fallback"
          ? "stablecoin-meta.reviewed-curated-fallback-reserves"
          : "stablecoin-meta.reviewed-standalone-reserves",
      reviewedAt: review.compositionAsOf!,
      confidence: confidenceForResearch(review.confidence),
      sources: review.sources,
      payload: {
        reserveReview: review,
        reserves: admitted.rows,
        evidenceClass: admitted.evidenceClass,
        provenance: admitted.provenance,
      },
      maxAgeSec: REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC,
    });
    return;
  }
  const report = meta.proofOfReserves?.latestReport;
  if (!report) return;
  const sources = [...review.sources, ...report.sources].filter(
    (source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index,
  );
  evidence.add({
    componentKeys: [
      "reviewed-static-reserves",
      ...admitted.rows.map((row) => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}`),
    ],
    sourceId: "stablecoin-meta.reviewed-static-reserves",
    reviewedAt: report.periodEnd,
    confidence: confidenceForResearch(report.confidence),
    sources,
    payload: {
      reserveReview: review,
      reserves: admitted.rows,
      proofOfReserves: meta.proofOfReserves,
      evidenceClass: admitted.evidenceClass,
      provenance: admitted.provenance,
    },
    maxAgeSec: ISSUER_ATTESTED_RESERVE_MAX_AGE_SEC,
  });
}

export function addReserveClassificationEvidence(
  meta: V9ExtensionRegistryMeta,
  classifications: readonly ReserveClassification[],
  evidence: ReviewEvidenceBuilder,
): void {
  const review = meta.reserveReview;
  const reviewed = classifications.filter((classification) =>
    classification.classificationKey.startsWith("registry-reviewed:"),
  );
  if (!review || reviewed.length === 0) return;
  evidence.add({
    componentKeys: reviewed.map((classification) => `reserve-classification:${classification.exposureKey}`),
    sourceId: "stablecoin-meta.reserve-review",
    reviewedAt: review.reviewedAt,
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: { reserveReview: review, reserves: meta.reserves ?? [] },
    maxAgeSec: REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC,
  });
}
