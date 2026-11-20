import type { DependencyRejectionReason } from "@shared/lib/dependency-derivation";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { hasIndependentLiveCompositionDates, hasIndependentReserveObservationDates } from "@shared/lib/report-card-policy";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapter-descriptors";
import { projectReserveCompositionReviewFacts, REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/reserve-admission";
import { admitV10ReserveReportScope, admitV10ReserveObservation, shouldApplyV10ReserveReportScope, resolveV10ReserveObservationDeploymentRefs } from "@shared/lib/safety-score-v9/reserve-scope";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import type { V9ReserveCompositionAdmission } from "@shared/types/safety-score-v9-public";
import type { ReserveObservationEnvelope, ReserveScopedAdmission } from "@shared/types/safety-score-v9-reserve-scope";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import {
  RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT,
  RESERVE_REVIEW_PCT_TOLERANCE,
  validateReserveCompositionTotal,
  type ReserveSlice,
} from "@shared/types/reserves";
import { computeSafetyScoreV9ReserveExposureKey } from "./fact-set-schema";
import {
  confidenceForResearch,
  conservativeDateEndSec,
  type ExtensionAsset,
  type ReserveClassification,
  type V9ExtensionRegistryMeta,
} from "./extension-shared";
import type { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";

const REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC =
  V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedReserveClassificationMaxAgeSec;

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
        ...(slice.unclassifiedResidual ? { unclassifiedResidual: true } : {}),
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
  // Metadata-only rows cannot use historical name matching.
  if (reviewed.pct === 0 && !live.sourceKey) return false;
  if (live.sourceKey) return reviewed.sourceKey === live.sourceKey;
  const normalizedName = normalizedReserveName(live.name);
  const sameName = normalizedName.length > 0 && normalizedName === normalizedReserveName(reviewed.name);
  // A native tracked id is not an identity by itself. For unkeyed rows it
  // corroborates the same reserve identity; explicit keys never fall back.
  return sameName && (!live.coinId || !reviewed.coinId || live.coinId === reviewed.coinId);
}

function overlayReviewedReserveClassification(
  classification: ReserveClassification,
  live: ReserveSlice,
  reviewed: ReserveSlice,
  reviewKey: string,
  nonLinkDisposition: ReserveClassification["trackedAssetDisposition"],
  reviewedLinkAllowed: boolean,
): ReserveClassification {
  const assetClass = live.assetClass ?? reviewed.assetClass ?? null;
  const issuerOrObligorKey =
    live.issuerOrObligor ?? reviewed.issuerOrObligor ?? (reviewed.coinId ? `asset:${reviewed.coinId}` : null);
  const riskFactors = live.riskFactors?.length ? [...live.riskFactors] : [...(reviewed.riskFactors ?? [])];
  const liquidityHorizon = live.liquidityHorizon ?? reviewed.liquidityHorizon ?? null;
  const maturityDaysMax = live.maturityDaysMax ?? reviewed.maturityDaysMax ?? null;
  const trackedAssetId = live.coinId ?? (reviewedLinkAllowed ? reviewed.coinId : null) ?? null;
  const usesReviewedMetadata =
    (live.assetClass == null && reviewed.assetClass != null) ||
    (live.issuerOrObligor == null && (reviewed.issuerOrObligor != null || reviewed.coinId != null)) ||
    (reviewedLinkAllowed && live.coinId == null && reviewed.coinId != null) ||
    (!live.riskFactors?.length && Boolean(reviewed.riskFactors?.length)) ||
    (live.liquidityHorizon == null && reviewed.liquidityHorizon != null) ||
    (live.maturityDaysMax == null && reviewed.maturityDaysMax != null);

  if (!usesReviewedMetadata && !nonLinkDisposition) return classification;
  return {
    ...classification,
    classificationKey: `registry-reviewed:${classification.exposureKey}:${reviewKey}`,
    assetClass,
    issuerOrObligorKey,
    riskFactors: [...new Set(riskFactors)].sort(compareText),
    liquidityHorizon,
    maturityDaysMax,
    ...(nonLinkDisposition
      ? { trackedAssetId: null }
      : trackedAssetId
        ? { trackedAssetId }
        : {}),
    ...(nonLinkDisposition ? { trackedAssetDisposition: nonLinkDisposition } : {}),
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
    !review ||
    (review.scope !== "full-composition" && review.scope !== "classification-only") ||
    review.confidence === "unknown" ||
    !Number.isFinite(reviewedAtSec) ||
    reviewedAtSec > clockSec ||
    clockSec - reviewedAtSec > classificationMaxAgeSec ||
    (compositionAsOfSec !== null && (!Number.isFinite(compositionAsOfSec) || compositionAsOfSec > clockSec))
  ) {
    return [];
  }
  const ownLiabilityIndexes = new Set(
    review.nonLinkDispositions?.filter((row) => row.ownLiability).map((row) => row.reserveIndex),
  );
  const matches = (live: ReserveSlice, reviewed: ReserveSlice, reviewedIndex: number) =>
    (Boolean(live.sourceKey) || (review.scope === "full-composition" && !ownLiabilityIndexes.has(reviewedIndex))) &&
    reserveSlicesMatch(live, reviewed);
  const reviewedCandidatesByLive = liveReserves.map((live) =>
    reviewedReserves
      .map((reviewed, reviewedIndex) => ({ reviewed, reviewedIndex }))
      .filter(({ reviewed, reviewedIndex }) => matches(live, reviewed, reviewedIndex)),
  );
  const liveCandidateCountByReviewed = reviewedReserves.map((reviewed, reviewedIndex) => {
    const candidates = liveReserves.filter(live => matches(live, reviewed, reviewedIndex));
    // The compiler combines identical keyed own-liability rows at their full weight.
    return ownLiabilityIndexes.has(reviewedIndex) && candidates.length > 1
      ? new Set(candidates.map(live => stableJsonStringifyV1({ ...live, pct: undefined }))).size
      : candidates.length;
  });
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
): { slices: ReserveSlice[]; rejectionReasons: DependencyRejectionReason[] } {
  const reviewedMatches = reviewedReserveMatches(liveReserves, meta, clockSec);
  const reviewedByLiveIndex = new Map(
    meta.reserveReview?.scope === "full-composition"
      ? reviewedMatches.map((match) => [match.liveIndex, match.reviewed])
      : [],
  );
  const nonLinkReviewedIndexes = new Set(
    meta.reserveReview?.nonLinkDispositions?.map((disposition) => disposition.reserveIndex) ?? [],
  );
  const nonLinkLiveIndexes = new Set(
    reviewedMatches
      .filter((match) => nonLinkReviewedIndexes.has(match.reviewedIndex))
      .map((match) => match.liveIndex),
  );
  const rejectionReasons: DependencyRejectionReason[] = [];
  const reviewedAtSec = meta.reserveReview
    ? Date.parse(`${meta.reserveReview.reviewedAt}T00:00:00.000Z`) / 1_000
    : Number.NaN;
  const expired = Number.isFinite(reviewedAtSec)
    && clockSec - reviewedAtSec > REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC;
  const slices = liveReserves.map((slice, liveIndex) => {
    if (slice.selfReferential || nonLinkLiveIndexes.has(liveIndex)) {
      rejectionReasons.push({ sliceIndex: liveIndex, reason: "non-link" });
      const { coinId: _coinId, depType: _depType, intermediary: _intermediary, ...unlinked } = slice;
      return unlinked;
    }
    const reviewed = reviewedByLiveIndex.get(liveIndex);
    if ((!slice.coinId && !reviewed?.coinId) || slice.coinId === meta.id) {
      rejectionReasons.push({
        sliceIndex: liveIndex,
        reason: expired && (meta.reserves ?? []).some((candidate) => reserveSlicesMatch(slice, candidate))
          ? "expired"
          : "no-match",
      });
    }
    if (!reviewed?.coinId) return slice;
    const identityConflict = !!slice.coinId && slice.coinId !== reviewed.coinId;
    const typeConflict = !!slice.depType && !!reviewed.depType && slice.depType !== reviewed.depType;
    if (identityConflict || typeConflict) {
      rejectionReasons.push({
        sliceIndex: liveIndex,
        reason: identityConflict ? "reviewed-dependency-identity-conflict" : "reviewed-dependency-type-conflict",
        ...(slice.coinId ? { upstreamAssetId: slice.coinId } : {}),
        reviewedUpstreamAssetId: reviewed.coinId,
      });
      const { coinId: _coinId, depType: _depType, intermediary: _intermediary, ...unlinked } = slice;
      return unlinked;
    }
    // Native coinId rows still need the reviewed relationship kind. A
    // matching native kind is retained, a missing kind inherits, and a
    // conflict above withholds the link rather than silently choosing.
    return {
      ...slice,
      coinId: reviewed.coinId,
      ...(reviewed.depType ? { depType: reviewed.depType } : {}),
      ...(!slice.intermediary && reviewed.intermediary ? { intermediary: reviewed.intermediary } : {}),
    };
  });
  return { slices, rejectionReasons };
}

function hasUnclassifiedResidualShape(row: ReserveSlice): boolean {
  return (row.assetClass == null || row.assetClass === "other") &&
    row.coinId == null && row.depType == null && row.risk !== "very-high";
}

/**
 * Binds admitted static rows to their authored review and overlays live identities.
 * Explicit source keys match exactly and fail closed; only full-composition
 * reviews admit historical unkeyed rows by unique normalized name, with exact
 * keys required for own-liability reviews. Weights are never identity.
 */
export function buildReviewedReserveClassifications(
  liveReserves: readonly ReserveSlice[],
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  classificationMaxAgeSec = REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC,
  reviewedStatic = false,
): ReserveClassification[] {
  const classifications: ReserveClassification[] = buildSafetyScoreV9ReserveClassifications(liveReserves).map(
    ({ unclassifiedResidual: _unclassifiedResidual, ...classification }) => classification,
  );
  const review = meta.reserveReview;
  if (!review) return classifications;
  const reviewedByExposureKey = new Map<string, {
    reviewed: ReserveSlice;
    nonLinkDisposition: ReserveClassification["trackedAssetDisposition"];
  }>();
  const liveByExposureKey = new Map(liveReserves.map((live) => [computeSafetyScoreV9ReserveExposureKey(live), live]));
  const unclassifiedExposureKeys = new Set<string>();

  // Admission validates authored indexes before sorting or reconciling static rows.
  const matches = reviewedStatic
    ? (meta.reserves ?? []).flatMap((reviewed, reviewedIndex) => {
        const key = computeSafetyScoreV9ReserveExposureKey(reviewed);
        const liveIndex = liveReserves.findIndex(row => computeSafetyScoreV9ReserveExposureKey(row) === key);
        return liveIndex === -1 ? [] : [{ liveIndex, reviewedIndex, reviewed }];
      })
    : reviewedReserveMatches(liveReserves, meta, clockSec, classificationMaxAgeSec);
  for (const match of matches) {
    const exposureKey = computeSafetyScoreV9ReserveExposureKey(liveReserves[match.liveIndex]!);
    const live = liveReserves[match.liveIndex]!;
    const dispositions = review.nonLinkDispositions?.filter(
      (row) => row.reserveIndex === match.reviewedIndex,
    ) ?? [];
    const [disposition] = dispositions;
    const ownLiability = dispositions.length === 1 && disposition?.ownLiability === true &&
      disposition.disposition === "self-reserve" && disposition.reserveName === match.reviewed.name &&
      Math.abs(disposition.pct - match.reviewed.pct) <= RESERVE_REVIEW_PCT_TOLERANCE;
    reviewedByExposureKey.set(exposureKey, {
      reviewed: match.reviewed,
      nonLinkDisposition: ownLiability ? "own-liability" : dispositions.length > 0 ? "reviewed-non-link" : undefined,
    });
    // Only a producer-declared unknown can become a live residual.
    if (live.unclassifiedResidual && live.residualReason === "insufficient-evidence" &&
      live.sourceKey && live.sourceKey === match.reviewed.sourceKey &&
      hasUnclassifiedResidualShape(live) && hasUnclassifiedResidualShape(match.reviewed) &&
      dispositions.length === 1 && dispositions[0]!.disposition === "insufficient-evidence" &&
      dispositions[0]!.reserveName === match.reviewed.name) {
      unclassifiedExposureKeys.add(exposureKey);
    }
  }

  const reviewKey = domainDigest("safety-score-v9.reserve-classification-review.v1", review).slice(0, 16);
  return classifications.map((classification) => {
    const live = liveByExposureKey.get(classification.exposureKey);
    const match = reviewedByExposureKey.get(classification.exposureKey);
    const reviewedClassification = live && match
      ? overlayReviewedReserveClassification(
          classification,
          live,
          match.reviewed,
          reviewKey,
          match.nonLinkDisposition,
          review.scope === "full-composition",
        )
      : classification;
    return unclassifiedExposureKeys.has(classification.exposureKey)
      ? {
          ...reviewedClassification,
          unclassifiedResidual: true,
          ...(review.scope === "full-composition" && match?.reviewed.publishedResidualCategory &&
            live?.name === match.reviewed.name && live.pct === match.reviewed.pct
            ? { publishedResidualCategory: true as const } : {}),
        }
      : reviewedClassification;
  });
}

type ReviewedStaticReserveRows = NonNullable<ExtensionAsset["reviewedStaticReserveRows"]>;
type OnReserveCompositionRejected = (diagnostic: V9ReserveCompositionAdmission) => void;

const CORROBORATING_ASSURANCE_METHODS = new Set([
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
]);
const DIRECT_RESERVE_ASSURANCE_METHODS = new Set(["audit", "examination"]);
const NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC =
  V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.namedFirmReserveReportMaxAgeSec;
const UNRESOLVED_CURATED_RESERVE_DISPOSITIONS = new Set(["basket-needs-split", "insufficient-evidence"]);

function normalizeReviewedStaticReserveRows(rows: readonly ReserveSlice[]): ReserveSlice[] {
  const sorted = [...rows].sort(
    (left, right) =>
      compareText(computeSafetyScoreV9ReserveExposureKey(left), computeSafetyScoreV9ReserveExposureKey(right)) ||
      compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right)),
  );
  const totalPct = sorted.reduce((sum, row) => sum + row.pct, 0);
  if (totalPct === 100) return sorted;
  if (Math.abs(totalPct - 100) > RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT || totalPct <= 0) {
    throw new Error("Reviewed reserve normalization exceeded the approved composition tolerance");
  }
  // Reconcile only rounding noise in one positive row; never erase a dust holding.
  const correction = 100 - totalPct;
  let last = sorted.length - 1;
  while (last >= 0 && (sorted[last]!.pct <= 0 || sorted[last]!.pct + correction <= 0)) last--;
  if (last < 0) throw new Error("Reviewed reserve rounding has no nonnegative reconciliation row");
  return sorted.map((row, index) => index === last ? { ...row, pct: row.pct + correction } : row);
}

function reportScopeApplies(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
): boolean {
  const report = meta.proofOfReserves?.latestReport;
  if (!report?.coverage) return false;
  const partition = fixedInput?.safetyScoreV9SupplyAttributionById[meta.id];
  return shouldApplyV10ReserveReportScope(report, admitV10ReserveReportScope({
    report, deploymentRefs: (meta.contracts ?? []).map(row => normalizeDeploymentId(`${row.chain}:${row.address}`)),
    clockSec, policy: V9_CANDIDATE_POLICY_V1.policy,
    currentPartition: partition?.model === "reviewed-economic-deployment-partition-v1" ? partition : null,
    baseInputGenerationId: fixedInput?.baseInputGenerationId,
  }));
}

function hasDirectIndependentReserveAssurance(meta: V9ExtensionRegistryMeta, clockSec: number, fixedInput?: Readonly<SafetyScoreV9CompilerInput>): boolean {
  const review = meta.reserveReview;
  const report = meta.proofOfReserves?.latestReport;
  if (!review || !report) return false;
  if (reportScopeApplies(meta, clockSec, fixedInput)) return false;
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

function hasNamedReportFirm(meta: V9ExtensionRegistryMeta): boolean {
  const proof = meta.proofOfReserves;
  const report = proof?.latestReport;
  const provider = proof?.provider?.trim();
  if (!provider || !report || !["attestation", "independent-audit", "agreed-upon-procedures"].includes(proof!.type) ||
    !["big4", "regional", "niche"].includes(proof!.attestorTier ?? "")) return false;
  const normalizeName = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "");
  // A provider may name the actual firm after an issuer-led assurance description.
  const describedFirmNames = Array.from(provider.matchAll(
    /(?:attestations?|audits?|assurance|examinations?)\s*\(([^)]+)\)/giu), match => match[1]!);
  const firmNames = describedFirmNames.length > 0 ? describedFirmNames : [provider];
  const firmPatterns = firmNames.flatMap(name => {
    const token = normalizeName(name.trim().split(/\s/, 1)[0]!).replace(/[;,]+$/u, "");
    // PwC's published brand and legal network name identify the same firm.
    // Do not infer aliases for other providers from a tier or acronym.
    const tokens = /^(?:pricewaterhousecoopers|pwc)$/iu.test(token)
      ? ["PricewaterhouseCoopers", "PwC"] : [token];
    return tokens.map(firmToken => {
      // eslint-disable-next-line security/detect-non-literal-regexp -- token comes from reviewed registry metadata and is escaped before interpolation.
      return new RegExp(`(?:^|[^\\p{L}\\p{N}])${firmToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "iu");
    });
  });
  return report.sources.some(source => {
    // A proof URL can itself be the signed report PDF, rather than an issuer index.
    const reportSource = source.url !== proof!.url || /\.pdf(?:[?#]|$)/i.test(source.url);
    return reportSource && firmPatterns.some(pattern =>
      pattern.test(normalizeName(source.label)) || pattern.test(normalizeName(report.reviewer ?? "")));
  });
}

interface IndependentlyAttestedCompositionAdmission {
  normalizedRows: ReserveSlice[];
  sourceRows: ReserveSlice[];
  review: NonNullable<V9ExtensionRegistryMeta["reserveReview"]>;
  proof: NonNullable<V9ExtensionRegistryMeta["proofOfReserves"]>;
  report: NonNullable<NonNullable<V9ExtensionRegistryMeta["proofOfReserves"]>["latestReport"]>;
  compositionAsOfSec: number;
  freshness: "fresh" | "expired";
}

/**
 * Shared admission result for an independently attested full composition.
 * Supervision is deliberately not part of it: an independent audit is evidence
 * about the *reserves*, prudential supervision is evidence about the *issuer*,
 * and the two decide different things. This policy controls both current
 * admission and expired-evidence emission; callers decide which rung applies.
 */
function independentlyAttestedComposition(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
): IndependentlyAttestedCompositionAdmission | null {
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const proof = meta.proofOfReserves;
  const report = proof?.latestReport;
  const compositionRows = compositionRowsWithUnknownResidual(meta);
  if (reportScopeApplies(meta, clockSec, fixedInput)) return null;
  const attestorIndependent = hasNamedReportFirm(meta);
  const reviewAtSec = review ? conservativeDateEndSec(review.reviewedAt, clockSec) : null;
  const compositionAtSec = conservativeDateEndSec(review?.compositionAsOf, clockSec);
  // Explicit publication and marked signed-date stand-ins share chronology/freshness gates.
  const reportAtSec = report ? conservativeDateEndSec(report.publishedAt, clockSec) : null;
  const periodEndSec = report ? conservativeDateEndSec(report.periodEnd, clockSec) : null;
  if (
    rows.length === 0 ||
    compositionRows === null ||
    review?.scope !== "full-composition" ||
    review.confidence === "unknown" ||
    review.sources.length === 0 ||
    reviewAtSec === null ||
    compositionAtSec === null ||
    reviewAtSec < compositionAtSec ||
    !validateReserveCompositionTotal(rows, "full") ||
    (proof?.type !== "independent-audit" && proof?.type !== "attestation" &&
      !(proof?.type === "agreed-upon-procedures" && report?.assuranceMethod === "agreed-upon-procedures")) ||
    !attestorIndependent ||
    !proof.provider?.trim() ||
    report === undefined ||
    report.confidence === "unknown" ||
    report.sources.length === 0 ||
    reportAtSec === null ||
    periodEndSec === null ||
    compositionAtSec !== periodEndSec ||
    reportAtSec < periodEndSec ||
    !CORROBORATING_ASSURANCE_METHODS.has(report.assuranceMethod)
  ) {
    return null;
  }
  const compositionAsOfSec = Date.parse(`${report.periodEnd}T00:00:00Z`) / 1_000;
  return {
    normalizedRows: normalizeReviewedStaticReserveRows(compositionRows),
    sourceRows: rows,
    review,
    proof,
    report,
    compositionAsOfSec,
    freshness:
      clockSec - compositionAsOfSec > NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC
        ? "expired"
        : "fresh",
  };
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
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
  namedAdmission?: IndependentlyAttestedCompositionAdmission | null,
): ReviewedStaticReserveRows | null {
  if (meta.mintAuthority?.supervision !== "prudential") return null;
  const admission = namedAdmission === undefined ? independentlyAttestedComposition(meta, clockSec, fixedInput) : namedAdmission;
  if (admission?.freshness !== "fresh") return null;
  return {
    rows: admission.normalizedRows,
    evidenceClass: admission.proof.type === "agreed-upon-procedures"
      ? "static-validated"
      : hasDirectIndependentReserveAssurance(meta, clockSec, fixedInput) ? "independent" : "issuer-attested",
    provenance: "curated",
  };
}

/**
 * The rung between full issuer-attested credit and nothing at all.
 *
 * An issuer without prudential supervision can still publish an independently
 * attested composition. Discarding it reported the asset as having no reserve
 * composition whatsoever, which is a worse claim than the evidence supports and
 * let a single stale upstream feed erase an entire backing pillar. It enters as
 * `static-validated`, one rung down, so it earns reduced credit under the
 * same report-period freshness window without promotion to audit-grade strength.
 *
 * Never returns `independent`: direct assurance describes the reserves and must
 * not lift an unsupervised issuer back to full strength through this path.
 * Independently reviewed registry evidence is admitted by its own source,
 * scope and age gates, not the captured live-producer fallback census.
 */
export function buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
  namedAdmission?: IndependentlyAttestedCompositionAdmission | null,
): ReviewedStaticReserveRows | null {
  if (meta.mintAuthority?.supervision === "prudential") return null;
  const admission = namedAdmission === undefined ? independentlyAttestedComposition(meta, clockSec, fixedInput) : namedAdmission;
  if (admission?.freshness !== "fresh") return null;
  return { rows: admission.normalizedRows, evidenceClass: "static-validated", provenance: "audited-fallback" };
}

/**
 * One whole-book admission retains original identified weights and separately
 * marked disjoint tails. The compiler resolves each tail's exact cause.
 */
function compositionRowsWithUnknownResidual(meta: V9ExtensionRegistryMeta): ReserveSlice[] | null {
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const residualPct = review?.knownUnknownExposurePct;
  if (!review || review.scope !== "full-composition" || review.confidence === "unknown" ||
    review.sources.length === 0 || residualPct == null || !Number.isFinite(residualPct) ||
    residualPct < 0 || residualPct > 100 || !validateReserveCompositionTotal(rows, "full") ||
    rows.some(row => !Number.isFinite(row.pct) || row.pct < 0)) return null;
  const identities = rows.map(computeSafetyScoreV9ReserveExposureKey);
  if (new Set(identities).size !== rows.length) return null;
  const residualIndexes = new Set<number>();
  const dispositionIndexes = new Set<number>();
  let recordedUnresolvedPct = 0;
  let unidentifiedPct = 0;
  for (const disposition of review.nonLinkDispositions ?? []) {
    const row = rows[disposition.reserveIndex];
    if (!row || dispositionIndexes.has(disposition.reserveIndex) ||
      row.name !== disposition.reserveName || Math.abs(row.pct - disposition.pct) > RESERVE_REVIEW_PCT_TOLERANCE) return null;
    dispositionIndexes.add(disposition.reserveIndex);
    if (!UNRESOLVED_CURATED_RESERVE_DISPOSITIONS.has(disposition.disposition)) continue;
    recordedUnresolvedPct += row.pct;
    // A known class stays identified even if its obligor/look-through is unknown.
    if (row.assetClass != null && !row.unclassifiedResidual) continue;
    if (!hasUnclassifiedResidualShape(row) || row.pct <= 0 || row.coinId != null || row.depType != null) return null;
    residualIndexes.add(disposition.reserveIndex);
    unidentifiedPct += row.pct;
  }
  if (Math.abs(recordedUnresolvedPct - residualPct) > 1e-9 && residualPct > 0) return null;
  if (unidentifiedPct > residualPct + 1e-9 || rows.some((row, index) => row.unclassifiedResidual && !residualIndexes.has(index))) return null;
  return rows.map((row, index) => {
    if (residualIndexes.has(index)) return { ...row, unclassifiedResidual: true, residualReason: "insufficient-evidence" as const };
    const disposition = review.nonLinkDispositions?.find(item => item.reserveIndex === index);
    if (disposition?.disposition === "basket-needs-split") {
      const { coinId: _coinId, depType: _depType, intermediary: _intermediary, ...classified } = row;
      return classified;
    }
    return row;
  });
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
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
  namedAdmission = independentlyAttestedComposition(meta, clockSec, fixedInput),
  onRejected?: OnReserveCompositionRejected,
): ReviewedStaticReserveRows | null {
  const reject = (...reasons: V9ReserveCompositionAdmission["reasons"]) => {
    onRejected?.({ reasons });
    return null;
  };
  const rows = meta.reserves ?? [];
  const review = meta.reserveReview;
  const rejectReview = (review: NonNullable<V9ExtensionRegistryMeta["reserveReview"]>) => {
    if (!onRejected) return null;
    const { blockers, compositionAtSec } = projectReserveCompositionReviewFacts(review);
    if (compositionAtSec !== null && compositionAtSec > clockSec) return reject(...blockers, "future-dated");
    return blockers.length ? reject(...blockers) : reject("invalid-review-chronology");
  };
  const curatedRows = compositionRowsWithUnknownResidual(meta);
  if (review?.observations?.some(row => (row.kind === "standing-structure" || row.kind === "portfolio-observation") &&
    row.obligations.some(obligation => obligation.disposition !== "included"))) {
    return reject("observation-obligations-unresolved");
  }
  if (namedAdmission?.freshness === "expired") {
    onRejected?.({ reasons: ["beyond-age-budget"],
      age: { compositionAsOfSec: namedAdmission.compositionAsOfSec, maxAgeSec: NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC } });
    return null;
  }
  const compositionMaxAgeSec = namedAdmission !== null
    ? NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC : REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC;
  // A named report's age cannot be bypassed through the generic curated lane.
  const report = meta.proofOfReserves?.latestReport;
  if (hasNamedReportFirm(meta) && report?.periodEnd === review?.compositionAsOf &&
    namedAdmission === null) {
    if (!onRejected) return null;
    if (reportScopeApplies(meta, clockSec, fixedInput)) return reject("report-scope-not-whole-book");
    if (!review) return reject("no-review");
    if (review.scope == null) return reject("scope-missing");
    if (review.scope !== "full-composition") return reject(review.scope);
    if (review.confidence === "unknown") return reject("unverified");
    if (report?.confidence === "unknown") return reject("report-confidence-unverified");
    if (review.compositionAsOf == null) return reject("undated");
    if (report?.publishedAt == null) return reject("report-publication-date-missing");
    const publishedAtSec = conservativeDateEndSec(report.publishedAt, Number.POSITIVE_INFINITY);
    if (publishedAtSec !== null && publishedAtSec > clockSec) return reject("report-publication-future-dated");
    if (!CORROBORATING_ASSURANCE_METHODS.has(report.assuranceMethod)) return reject("report-assurance-method-unsupported");
    const reviewAtSec = conservativeDateEndSec(review.reviewedAt, clockSec);
    const compositionAtSec = conservativeDateEndSec(review.compositionAsOf, clockSec);
    if (reviewAtSec === null || (compositionAtSec !== null && reviewAtSec < compositionAtSec)) return reject("invalid-review-chronology");
    return reject("named-report-ineligible");
  }
  if (review && (review.knownUnknownExposurePct ?? 0) > 0) {
    const reviewAtSec = conservativeDateEndSec(review.reviewedAt, clockSec);
    const compositionAtSec = conservativeDateEndSec(review.compositionAsOf, clockSec);
    if (reviewAtSec === null || compositionAtSec === null || reviewAtSec < compositionAtSec) return rejectReview(review);
  }
  const observationRefs = review?.observations?.length ? resolveV10ReserveObservationDeploymentRefs(meta) : [];
  const separate = review?.observations?.find(row =>
    row.kind === "standing-structure" && admitV10ReserveObservation({
      observation: row, deploymentRefs: observationRefs,
      clockSec, policy: V9_CANDIDATE_POLICY_V1.policy,
    }).admitted,
  );
  if (separate?.kind === "standing-structure" && rows.length === 1 && rows[0].pct === 100 &&
    rows[0].assetClass === "fund-share" && rows[0].risk === "high" &&
    rows[0].liquidityHorizon === "over-seven-days" && rows[0].coinId == null &&
    rows[0].issuerOrObligor === separate.instrumentKey) {
    return { rows: [...rows], evidenceClass: "static-validated", provenance, sourceKind: "standing-structure", scopeId: separate.scopeId };
  }
  const portfolio = review?.observations?.find(row => row.kind === "portfolio-observation" &&
    review.reportScopeId == null && review.compositionAsOf === new Date(row.observedAtSec * 1000).toISOString().slice(0, 10) &&
    row.wholeAssetDenominator?.sourceSha256 === row.sourceSha256 &&
    admitV10ReserveObservation({ observation: row, deploymentRefs: observationRefs,
      clockSec, policy: V9_CANDIDATE_POLICY_V1.policy }).wholeAssetComposition);
  if (portfolio && review?.confidence === "verified" && review.scope === "full-composition" &&
    curatedRows !== null && rows.length > 0 && validateReserveCompositionTotal(rows, "full")) {
    return { rows: [...curatedRows], evidenceClass: "static-validated", provenance, sourceKind: "portfolio-observation", scopeId: portfolio.scopeId };
  }
  if (reportScopeApplies(meta, clockSec, fixedInput)) return reject("report-scope-not-whole-book");
  const reviewedAtSec = conservativeDateEndSec(review?.reviewedAt, clockSec);
  const compositionAtSec = conservativeDateEndSec(review?.compositionAsOf, clockSec);
  const reportPeriodEnd = meta.proofOfReserves?.latestReport?.periodEnd;
  const hasDateMismatch = reportPeriodEnd != null && review?.compositionAsOf != null &&
    reportPeriodEnd !== review.compositionAsOf;
  if (!review) return reject("no-review");
  if (rows.length === 0) return reject("no-composition");
  if (review.scope !== "full-composition" || review.confidence !== "verified" || compositionAtSec === null) {
    return rejectReview(review);
  }
  if (review.sources.length === 0) return reject("review-sources-missing");
  if (curatedRows === null) return reject("invalid-composition");
  if (reviewedAtSec === null || reviewedAtSec < compositionAtSec) return reject("invalid-review-chronology");
  if (hasDateMismatch && (
    !(hasIndependentLiveCompositionDates(meta) || hasIndependentReserveObservationDates(meta)) ||
    conservativeDateEndSec(reportPeriodEnd, clockSec) === null ||
    conservativeDateEndSec(meta.proofOfReserves?.latestReport?.publishedAt, clockSec) === null
  )) return reject("report-date-mismatch");
  if (clockSec - compositionAtSec > compositionMaxAgeSec) {
    onRejected?.({ reasons: ["beyond-age-budget"], age: { compositionAsOfSec: compositionAtSec, maxAgeSec: compositionMaxAgeSec } });
    return null;
  }
  if (!validateReserveCompositionTotal(rows, "full")) return reject("invalid-composition");
  return {
    rows: normalizeReviewedStaticReserveRows(curatedRows),
    evidenceClass: "static-validated",
    provenance,
  };
}

export function buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
  namedAdmission?: IndependentlyAttestedCompositionAdmission | null,
  onRejected?: OnReserveCompositionRejected,
): ReviewedStaticReserveRows | null {
  if (meta.liveReservesConfig == null) return null;
  // A display-only probe cannot turn a separately reviewed observation into fallback evidence.
  const provenance = LIVE_RESERVE_ADAPTER_DEFINITIONS[meta.liveReservesConfig.adapter].evidenceClass === "weak-live-probe" &&
    hasIndependentReserveObservationDates(meta) ? "curated" : "curated-fallback";
  return buildSafetyScoreV9ReviewedCuratedReserveRows(meta, clockSec, provenance, fixedInput, namedAdmission, onRejected);
}

/**
 * Assets without a live-reserve producer may use the same tightly bounded
 * reviewed composition as a static input. Wrappers remain parent-inherited so
 * a child cannot duplicate or replace the parent's backing facts.
 */
export function buildSafetyScoreV9ReviewedStandaloneReserveRows(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>,
  namedAdmission?: IndependentlyAttestedCompositionAdmission | null,
  onRejected?: OnReserveCompositionRejected,
): ReviewedStaticReserveRows | null {
  if (meta.liveReservesConfig != null) return null;
  if (meta.variantOf != null) {
    onRejected?.({ reasons: ["variant-standalone-ineligible"] });
    return null;
  }
  return buildSafetyScoreV9ReviewedCuratedReserveRows(meta, clockSec, "curated", fixedInput, namedAdmission, onRejected);
}

export type ReviewedReserveAdmission =
  | { kind: "none"; projected: null }
  | { kind: "history"; projected: null; source: IndependentlyAttestedCompositionAdmission }
  | { kind: "named-report"; projected: ReviewedStaticReserveRows; source: Pick<IndependentlyAttestedCompositionAdmission, "review" | "proof" | "report">; named: boolean }
  | { kind: "reviewed-composition"; projected: ReviewedStaticReserveRows; review: NonNullable<V9ExtensionRegistryMeta["reserveReview"]> }
  | { kind: "scoped-observation"; projected: ReviewedStaticReserveRows; observation: ReserveObservationEnvelope };

/** Ephemeral: consume evidence locally; never retain in the prepared cohort. */
export function resolveReviewedReserveAdmission(input: {
  meta: V9ExtensionRegistryMeta;
  clockSec: number;
  liveReserveRows: readonly ReserveSlice[];
  fixedInput?: Readonly<SafetyScoreV9CompilerInput>;
  onRejected?: OnReserveCompositionRejected;
}): ReviewedReserveAdmission {
  const { meta, clockSec, fixedInput } = input;
  // Evidence historically uses the report-only scope context, while row
  // admission also sees the current partition. Preserve both without
  // repeating the named-report selector or renewing historical provenance.
  const source = independentlyAttestedComposition(meta, clockSec);
  const namedAdmission = fixedInput && reportScopeApplies(meta, clockSec, fixedInput) ? null : source;
  const projected = input.liveReserveRows.length > 0 ? null :
    buildSafetyScoreV9ReviewedStaticReserveRows(meta, clockSec, fixedInput, namedAdmission) ??
    (meta.liveReservesConfig != null
      ? buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec, fixedInput, namedAdmission) ??
        buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, clockSec, fixedInput, namedAdmission, input.onRejected)
      : buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec, fixedInput, namedAdmission, input.onRejected));
  if (!projected) return source?.freshness === "expired"
    ? { kind: "history", projected: null, source } : { kind: "none", projected: null };
  if (projected.sourceKind === "standing-structure" || projected.sourceKind === "portfolio-observation") {
    const observation = meta.reserveReview?.observations?.find(row =>
      row.scopeId === projected.scopeId && row.kind === projected.sourceKind);
    if (!observation) throw new Error("Independent reserve admission has no source envelope");
    return { kind: "scoped-observation", projected, observation };
  }
  if (source) return { kind: "named-report", projected, source, named: true };
  const review = meta.reserveReview!;
  const proof = meta.proofOfReserves;
  if (projected.evidenceClass !== "static-validated" && proof?.latestReport) {
    return { kind: "named-report", projected, source: { review, proof, report: proof.latestReport }, named: false };
  }
  return { kind: "reviewed-composition", projected, review };
}

export function addReviewedStaticReserveEvidence(
  admission: ReviewedReserveAdmission,
  evidence: ReviewEvidenceBuilder,
): void {
  if (admission.kind === "none") return;
  if (admission.kind === "scoped-observation") {
    const structure = admission.observation;
    evidence.add({
      componentKeys: ["reviewed-static-reserves", ...admission.projected.rows.map(row => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}` as const)],
      sourceId: `stablecoin-meta.reserve-${structure.kind}`, reviewedAtSec: structure.reviewedAtSec,
      observedAtSec: structure.observedAtSec ?? structure.reviewedAtSec,
      confidence: "verified", sources: structure.sources.map(source => ({ label: structure.kind, url: source.url })),
      payload: { structure, rows: admission.projected.rows }, maxAgeSec: structure.kind === "standing-structure"
        ? V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.standingStructureMaxAgeSec
        : REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC,
    });
    return;
  }
  if (admission.kind === "history") {
    const {
      proof,
      report: expiredReport,
      review: expiredReview,
      sourceRows,
    } = admission.source;
    const sources = [...expiredReview.sources, ...expiredReport.sources].filter(
      (source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index,
    );
    evidence.add({
      componentKeys: ["reserve-composition-history"],
      sourceId: "stablecoin-meta.expired-reviewed-static-reserves",
      reviewedAt: expiredReview.reviewedAt,
      observedAt: expiredReport.periodEnd,
      publishedAt: expiredReport.publishedAt,
      publishedBy: "issuer",
      confidence: confidenceForResearch(expiredReport.confidence),
      sources,
      payload: {
        reserveReview: expiredReview,
        reserves: sourceRows,
        proofOfReserves: proof,
      },
      maxAgeSec: NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC,
    });
    return;
  }
  if (admission.kind === "named-report") {
    const { review, report, proof } = admission.source;
    const auditedSources = [...review.sources, ...report.sources].filter(
      (source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index,
    );
    evidence.add({
      componentKeys: [
        "reviewed-static-reserves",
        ...admission.projected.rows.map((row) => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}` as const),
      ],
      sourceId: admission.named ? "stablecoin-meta.reviewed-audited-fallback-reserves" : "stablecoin-meta.reviewed-static-reserves",
      reviewedAt: review.reviewedAt,
      observedAt: report.periodEnd,
      publishedAt: report.publishedAt,
      publishedBy: "issuer",
      confidence: confidenceForResearch(report.confidence),
      sources: auditedSources,
      payload: {
        reserveReview: review,
        reserves: admission.projected.rows,
        evidenceClass: admission.projected.evidenceClass,
        provenance: admission.projected.provenance,
        proofOfReserves: proof,
      },
      maxAgeSec: NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC,
    });
    return;
  }
  const { review, projected } = admission;
  if (projected.evidenceClass === "static-validated") {
    evidence.add({
      componentKeys: [
        "reviewed-static-reserves",
        ...projected.rows.map((row) => `reserve-classification:${computeSafetyScoreV9ReserveExposureKey(row)}` as const),
      ],
      sourceId:
        projected.provenance === "curated-fallback"
          ? "stablecoin-meta.reviewed-curated-fallback-reserves"
          : "stablecoin-meta.reviewed-standalone-reserves",
      reviewedAt: review.compositionAsOf!,
      publishedBy: "unknown",
      confidence: confidenceForResearch(review.confidence),
      sources: review.sources,
      payload: {
        reserveReview: review,
        reserves: projected.rows,
        evidenceClass: projected.evidenceClass,
        provenance: projected.provenance,
      },
      maxAgeSec: REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC,
    });
    return;
  }
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
    componentKeys: reviewed.map((classification) => `reserve-classification:${classification.exposureKey}` as const),
    sourceId: "stablecoin-meta.reserve-review",
    reviewedAt: review.reviewedAt,
    publishedBy: "unknown",
    confidence: confidenceForResearch(review.confidence),
    sources: review.sources,
    payload: { reserveReview: review, reserves: meta.reserves ?? [] },
    maxAgeSec: REVIEWED_RESERVE_CLASSIFICATION_MAX_AGE_SEC,
  });
}

function selectScopedReserveObservations(meta: V9ExtensionRegistryMeta, fixedInput: Readonly<SafetyScoreV9CompilerInput>) {
  const live = fixedInput.liveReserveProvenanceMap[meta.id]?.reserveObservation;
  const observations = meta.reserveReview?.observations ?? [];
  const observationRefs = observations.length || live ? resolveV10ReserveObservationDeploymentRefs(meta) : [];
  const observedScopes = new Map<string, { observation: ReserveObservationEnvelope; admission: ReserveScopedAdmission }>();
  for (const observation of observations) {
    const admission = admitV10ReserveObservation({ observation, deploymentRefs: observationRefs,
      clockSec: fixedInput.clockSec, policy: V9_CANDIDATE_POLICY_V1.policy });
    if (admission.rejectionCodes.includes("expired")) continue;
    if (observedScopes.has(admission.scopeId)) throw new Error(`${meta.id}: overlapping-reserve-scope-identities`);
    observedScopes.set(admission.scopeId, { observation, admission });
  }
  if (live) {
    const admission = admitV10ReserveObservation({ observation: live, deploymentRefs: observationRefs,
      clockSec: fixedInput.clockSec, policy: V9_CANDIDATE_POLICY_V1.policy });
    if (!admission.rejectionCodes.includes("expired")) {
      const authored = observedScopes.get(admission.scopeId)?.admission;
      if (authored && (authored.kind !== admission.kind || authored.liabilityBookKey !== admission.liabilityBookKey ||
        authored.deploymentRefs.length !== admission.deploymentRefs.length ||
        authored.deploymentRefs.some(ref => !admission.deploymentRefs.includes(ref)))) {
        throw new Error(`${meta.id}: overlapping-reserve-scope-identities`);
      }
      // A producer refresh is one scope's new revision, never another reserve.
      // Failed live evidence cannot replace admissible authored evidence.
      if (admission.admitted || !authored?.admitted) observedScopes.set(admission.scopeId, { observation: live, admission });
    }
  }
  return observedScopes;
}

export interface ScopedReserveAdmission {
  admissions: ReserveScopedAdmission[];
  observations: ReadonlyMap<string, { observation: ReserveObservationEnvelope; admission: ReserveScopedAdmission }>;
  report: NonNullable<V9ExtensionRegistryMeta["proofOfReserves"]>["latestReport"];
}

export function buildSafetyScoreV10ScopedReserveAdmissions(meta: V9ExtensionRegistryMeta, fixedInput: Readonly<SafetyScoreV9CompilerInput>): ScopedReserveAdmission {
  if (fixedInput.liveReserveProvenanceMap[meta.id]?.reserveObservationFailure != null) {
    throw new Error(`${meta.id}: malformed-reserve-observation (producer-failed)`);
  }
  const deploymentRefs = (meta.contracts ?? []).map(row => normalizeDeploymentId(`${row.chain}:${row.address}`));
  const report = meta.proofOfReserves?.latestReport;
  const partition = fixedInput.safetyScoreV9SupplyAttributionById[meta.id];
  const admissions: ReserveScopedAdmission[] = [];
  if (report?.coverage) {
    const scope = admitV10ReserveReportScope({ report, deploymentRefs, clockSec: fixedInput.clockSec, policy: V9_CANDIDATE_POLICY_V1.policy,
      currentPartition: partition?.model === "reviewed-economic-deployment-partition-v1" ? partition : null,
      baseInputGenerationId: fixedInput.baseInputGenerationId });
    if (scope) admissions.push(scope);
  }
  const observations = selectScopedReserveObservations(meta, fixedInput);
  for (const { admission } of observations.values()) admissions.push(admission);
  if (new Set(admissions.map(row => row.scopeId)).size !== admissions.length) {
    throw new Error(`${meta.id}: overlapping-reserve-scope-identities`);
  }
  return { admissions: admissions.sort((a, b) => compareText(a.scopeId, b.scopeId)), observations, report };
}

export function addScopedReserveEvidence(
  { admissions, observations, report }: ScopedReserveAdmission,
  evidence: ReviewEvidenceBuilder,
): void {
  for (const admission of admissions) {
    if (!admission.admitted) { admission.evidenceRefIds = []; continue; }
    const observation = observations.get(admission.scopeId)?.observation;
    if (observation) {
      admission.evidenceRefIds = evidence.add({ componentKeys: [`reserve-scope:${admission.scopeId}`], sourceId: `reserve-observation:${observation.kind}`,
        reviewedAtSec: observation.reviewedAtSec, observedAtSec: observation.observedAtSec ?? observation.reviewedAtSec,
        sources: observation.sources.map(source => ({ label: observation.kind, url: source.url })), confidence: "verified", payload: observation,
        maxAgeSec: observation.expiresAtSec - (observation.observedAtSec ?? observation.reviewedAtSec) });
    } else if (report?.coverage) {
      admission.evidenceRefIds = evidence.add({ componentKeys: [`reserve-scope:${admission.scopeId}`], sourceId: "reserve-scoped-financial-report",
        reviewedAtSec: report.coverage.reviewedAtSec, observedAtSec: report.coverage.denominator.asOfSec, publishedAt: report.publishedAt,
        sources: report.sources, confidence: "verified", payload: report, publishedBy: "issuer",
        maxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.assuranceReportMaxAgeSec });
    }
  }
}
