import { sha256Hex } from "@shared/lib/sha256";
import type {
  YieldCoverageAuditQueueAction,
  YieldCoverageAuditQueueItemKind,
} from "@shared/types/status";
import { runChunkedInRead } from "../../lib/db";

const DISPOSITION_TABLE = "yield_coverage_review_dispositions";
const DEFAULT_PUBLISHED_ITEM_LIMIT = 20;

export interface YieldCoverageReviewableQueueItem {
  id: string;
  kind: YieldCoverageAuditQueueItemKind;
  actionHint: YieldCoverageAuditQueueAction;
  stablecoinIds?: readonly string[];
  project?: string;
  pool?: string;
  symbol?: string;
  chain?: string;
  tvlUsd?: number;
  apy?: number;
  poolCount?: number;
  totalTvlUsd?: number;
  recommendedTier?: "high-confidence" | "review-needed";
  protocolCategory?: string | null;
  examplePools?: readonly string[];
  reasonCodes?: readonly string[];
  sourceKey?: string;
  reviewedAt?: string;
  reviewConfidence?: string;
  promotionMetadata?: {
    sourceQueue: string;
    sourceQueueField: string;
    minPoolTvlUsd: number;
    queueQualifiedPoolCount: number;
    categoryGate: readonly string[];
    passedCategoryGate: boolean;
    existingAllowlistMember: boolean;
  };
}

export interface YieldCoverageReviewQueue<T extends YieldCoverageReviewableQueueItem> {
  persistence: "deferred" | "durable";
  promotionMode: "human-reviewed";
  allowedActions: YieldCoverageAuditQueueAction[];
  headlineGaps: T[];
  recommendationCandidates: T[];
  suppressedItemCount: number;
}

export interface YieldCoverageReviewDispositionSummary {
  candidateItemCount: number;
  suppressedItemCount: number;
  visibleItemCount: number;
  visibleHeadlineGapCount: number;
  visibleRecommendationCandidateCount: number;
  publishedItemCount: number;
  truncatedItemCount: number;
  visibleByKind: Record<string, number>;
  noDispositionCount: number;
  evidenceChangedCount: number;
  kindChangedCount: number;
  reviewDueCount: number;
  expiredCount: number;
}

export interface ApplyYieldCoverageReviewDispositionOptions {
  nowSec?: number;
  publishedItemLimit?: number;
}

interface YieldCoverageReviewDispositionRow {
  queue_item_id: string;
  queue_item_kind: string;
  evidence_fingerprint: string;
  disposition: string;
  evidence: string;
  review_owner: string;
  reviewed_at: number;
  next_review_at: number;
  expires_at: number;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function canonicalStringSet(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeText).filter((value): value is string => value != null))].sort();
}

function tvlBand(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 5_000_000) return "lt-5m";
  if (value < 10_000_000) return "5m-10m";
  if (value < 50_000_000) return "10m-50m";
  if (value < 100_000_000) return "50m-100m";
  if (value < 500_000_000) return "100m-500m";
  return "gte-500m";
}

function apyBand(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return "negative";
  if (value < 5) return "0-5";
  if (value < 10) return "5-10";
  if (value < 25) return "10-25";
  return "gte-25";
}

/**
 * Hash only decision-relevant evidence. Volatile exact APY/TVL values are
 * bucketed so routine market noise does not re-open a reviewed queue item.
 */
export function buildYieldCoverageEvidenceFingerprint(
  item: YieldCoverageReviewableQueueItem,
): string {
  const promotion = item.promotionMetadata;
  return sha256Hex(JSON.stringify({
    version: 1,
    id: normalizeText(item.id),
    kind: item.kind,
    actionHint: item.actionHint,
    stablecoinIds: canonicalStringSet(item.stablecoinIds),
    project: normalizeText(item.project),
    pool: normalizeText(item.pool),
    symbol: normalizeText(item.symbol),
    chain: normalizeText(item.chain),
    tvlBand: tvlBand(item.tvlUsd),
    apyBand: apyBand(item.apy),
    poolCount: Number.isInteger(item.poolCount) ? item.poolCount : null,
    totalTvlBand: tvlBand(item.totalTvlUsd),
    recommendedTier: item.recommendedTier ?? null,
    protocolCategory: normalizeText(item.protocolCategory),
    examplePools: canonicalStringSet(item.examplePools),
    reasonCodes: canonicalStringSet(item.reasonCodes),
    sourceKey: normalizeText(item.sourceKey),
    reviewedAt: item.reviewedAt ?? null,
    reviewConfidence: normalizeText(item.reviewConfidence),
    promotion: promotion
      ? {
          sourceQueue: promotion.sourceQueue,
          sourceQueueField: promotion.sourceQueueField,
          minPoolTvlBand: tvlBand(promotion.minPoolTvlUsd),
          queueQualifiedPoolCount: promotion.queueQualifiedPoolCount,
          categoryGate: canonicalStringSet(promotion.categoryGate),
          passedCategoryGate: promotion.passedCategoryGate,
          existingAllowlistMember: promotion.existingAllowlistMember,
        }
      : null,
  }));
}

function requireEpochSeconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer epoch second`);
  }
  return value;
}

function requirePublishedItemLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("publishedItemLimit must be a positive integer");
  }
  return value;
}

async function loadDispositions(
  db: D1Database,
  queueItemIds: readonly string[],
): Promise<Map<string, YieldCoverageReviewDispositionRow>> {
  const uniqueIds = [...new Set(queueItemIds)];
  if (uniqueIds.length === 0) return new Map();
  // SAFETY: DISPOSITION_TABLE is fixed and inClause contains only generated bind placeholders.
  const rows = await runChunkedInRead(
    uniqueIds,
    (inClause) =>
      `SELECT queue_item_id, queue_item_kind, evidence_fingerprint, disposition,
              evidence, review_owner, reviewed_at, next_review_at, expires_at
         FROM ${DISPOSITION_TABLE}
        WHERE queue_item_id IN (${inClause})`,
    async (sql, binds) => {
      const result = await db.prepare(sql).bind(...binds).all<YieldCoverageReviewDispositionRow>();
      return result.results ?? [];
    },
  );
  return new Map(rows.map((row) => [row.queue_item_id, row]));
}

function emptySummary(): YieldCoverageReviewDispositionSummary {
  return {
    candidateItemCount: 0,
    suppressedItemCount: 0,
    visibleItemCount: 0,
    visibleHeadlineGapCount: 0,
    visibleRecommendationCandidateCount: 0,
    publishedItemCount: 0,
    truncatedItemCount: 0,
    visibleByKind: {},
    noDispositionCount: 0,
    evidenceChangedCount: 0,
    kindChangedCount: 0,
    reviewDueCount: 0,
    expiredCount: 0,
  };
}

export async function applyYieldCoverageReviewDispositions<
  T extends YieldCoverageReviewableQueueItem,
>(
  db: D1Database,
  queue: YieldCoverageReviewQueue<T>,
  options: ApplyYieldCoverageReviewDispositionOptions = {},
): Promise<{
  queue: YieldCoverageReviewQueue<T> & { persistence: "durable" };
  summary: YieldCoverageReviewDispositionSummary;
}> {
  const nowSec = requireEpochSeconds(options.nowSec ?? Math.floor(Date.now() / 1_000), "nowSec");
  const publishedItemLimit = requirePublishedItemLimit(
    options.publishedItemLimit ?? DEFAULT_PUBLISHED_ITEM_LIMIT,
  );
  const allItems = [...queue.headlineGaps, ...queue.recommendationCandidates];
  const dispositions = await loadDispositions(db, allItems.map((item) => item.id));
  const summary = emptySummary();
  summary.candidateItemCount = allItems.length;

  const filterVisible = (items: T[]): T[] => items.filter((item) => {
    const row = dispositions.get(item.id);
    if (!row) {
      summary.noDispositionCount += 1;
      return true;
    }
    if (row.queue_item_kind !== item.kind) {
      summary.kindChangedCount += 1;
      return true;
    }
    if (row.evidence_fingerprint !== buildYieldCoverageEvidenceFingerprint(item)) {
      summary.evidenceChangedCount += 1;
      return true;
    }
    if (row.expires_at > 0 && row.expires_at <= nowSec) {
      summary.expiredCount += 1;
      return true;
    }
    if (row.next_review_at <= nowSec) {
      summary.reviewDueCount += 1;
      return true;
    }
    summary.suppressedItemCount += 1;
    return false;
  });

  const visibleHeadlineGaps = filterVisible(queue.headlineGaps);
  const visibleRecommendationCandidates = filterVisible(queue.recommendationCandidates);
  summary.visibleItemCount = visibleHeadlineGaps.length + visibleRecommendationCandidates.length;
  summary.visibleHeadlineGapCount = visibleHeadlineGaps.length;
  summary.visibleRecommendationCandidateCount = visibleRecommendationCandidates.length;
  for (const item of [...visibleHeadlineGaps, ...visibleRecommendationCandidates]) {
    summary.visibleByKind[item.kind] = (summary.visibleByKind[item.kind] ?? 0) + 1;
  }
  const headlineGaps = visibleHeadlineGaps.slice(0, publishedItemLimit);
  const recommendationCandidates = visibleRecommendationCandidates.slice(0, publishedItemLimit);
  summary.publishedItemCount = headlineGaps.length + recommendationCandidates.length;
  summary.truncatedItemCount = summary.visibleItemCount - summary.publishedItemCount;

  return {
    queue: {
      ...queue,
      persistence: "durable",
      promotionMode: "human-reviewed",
      suppressedItemCount: summary.suppressedItemCount,
      headlineGaps,
      recommendationCandidates,
    },
    summary,
  };
}
