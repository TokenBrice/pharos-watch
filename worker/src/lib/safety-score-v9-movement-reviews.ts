import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
  SafetyScoreV9MovementReviewRecordSchema,
  SafetyScoreV9MovementReviewRequestSchema,
  type SafetyScoreV9MovementReviewDisposition,
  type SafetyScoreV9MovementReviewRecord,
  type SafetyScoreV9MovementReviewRequest,
} from "@shared/types/safety-score-v9-review";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { parseJson } from "./json-parse";
import {
  SafetyScoreV9DiffReportSchema,
  type SafetyScoreV9DiffReport,
} from "./safety-score-v9-shadow";

const SAFETY_SCORE_V9_MOVEMENT_REVIEW_DIGEST_DOMAIN = "safety-score-v9.movement-review.v1";

interface MovementReviewRow {
  review_key: string;
  review_class_key: string;
  reviewed_v8_score: number | null;
  reviewed_v9_score: number | null;
  asset_id: string;
  source_diff_report_digest: string;
  candidate_id: string;
  source_publication_generation_id: string;
  policy_digest: string;
  evaluation_build_digest: string;
  v8_methodology_version: string;
  disposition: string;
  reviewer_id: string;
  rationale: string;
  reviewed_at_sec: number;
  review_digest: string;
  review_json: string;
}

export class SafetyScoreV9MovementReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9MovementReviewConflictError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reviewPayload(review: SafetyScoreV9MovementReviewRecord) {
  const { reviewDigest: _reviewDigest, ...payload } = review;
  return payload;
}

function hasSameImmutableReviewIntent(
  left: SafetyScoreV9MovementReviewRecord,
  right: SafetyScoreV9MovementReviewRecord,
): boolean {
  return (
    left.reviewKey === right.reviewKey &&
    left.reviewClassKey === right.reviewClassKey &&
    left.reviewedV8Score === right.reviewedV8Score &&
    left.reviewedV9Score === right.reviewedV9Score &&
    left.assetId === right.assetId &&
    left.candidateId === right.candidateId &&
    left.policyDigest === right.policyDigest &&
    left.evaluationBuildDigest === right.evaluationBuildDigest &&
    left.v8MethodologyVersion === right.v8MethodologyVersion &&
    left.disposition === right.disposition &&
    left.reviewerId === right.reviewerId &&
    left.rationale === right.rationale
  );
}

function computeSafetyScoreV9MovementReviewDigest(
  review: Omit<SafetyScoreV9MovementReviewRecord, "reviewDigest">,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: SAFETY_SCORE_V9_MOVEMENT_REVIEW_DIGEST_DOMAIN,
      review,
    }),
  );
}

export function createSafetyScoreV9MovementReview(input: {
  request: SafetyScoreV9MovementReviewRequest;
  diff: SafetyScoreV9DiffReport;
  reviewedAtSec: number;
}): SafetyScoreV9MovementReviewRecord {
  const request = SafetyScoreV9MovementReviewRequestSchema.parse(input.request);
  const diff = SafetyScoreV9DiffReportSchema.parse(input.diff);
  if (!Number.isInteger(input.reviewedAtSec) || input.reviewedAtSec < diff.generatedAtSec) {
    throw new Error("Safety Score v9 movement review cannot predate its diff report");
  }
  if (request.sourceDiffReportDigest !== diff.reportDigest) {
    throw new SafetyScoreV9MovementReviewConflictError("Safety Score v9 review targets a stale diff report");
  }
  const card = diff.cards.find((entry) => entry.id === request.assetId);
  if (!card) throw new Error(`Safety Score v9 diff has no asset ${request.assetId}`);
  if (!card.flags.requiresReview || card.review.key === null) {
    throw new Error(`Safety Score v9 movement ${request.assetId} does not require review`);
  }
  if (request.reviewKey !== card.review.key) {
    throw new SafetyScoreV9MovementReviewConflictError("Safety Score v9 movement review key is stale");
  }
  if (card.review.classKey === null) {
    throw new Error(`Safety Score v9 movement ${request.assetId} has no review class key`);
  }

  // The class key and score anchors are derived from the diff card, never supplied by the caller,
  // so a client cannot widen the class its ruling will carry across.
  const payload = {
    schemaVersion: SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
    reviewKey: request.reviewKey,
    reviewClassKey: card.review.classKey,
    reviewedV8Score: card.v8?.score ?? null,
    reviewedV9Score: card.v9?.score ?? null,
    assetId: request.assetId,
    sourceDiffReportDigest: request.sourceDiffReportDigest,
    candidateId: diff.v9Identity.candidateId,
    sourcePublicationGenerationId: diff.v9Identity.publicationGenerationId,
    policyDigest: diff.v9Identity.policyDigest,
    evaluationBuildDigest: diff.v9Identity.evaluationBuildDigest,
    v8MethodologyVersion: diff.v8Identity.methodologyVersion,
    disposition: request.disposition,
    reviewerId: request.reviewerId,
    rationale: request.rationale,
    reviewedAtSec: input.reviewedAtSec,
  } as const;
  return SafetyScoreV9MovementReviewRecordSchema.parse({
    ...payload,
    reviewDigest: computeSafetyScoreV9MovementReviewDigest(payload),
  });
}

function parseReviewRow(row: MovementReviewRow): SafetyScoreV9MovementReviewRecord {
  const parsed = parseJson(row.review_json);
  if (!parsed.ok) throw new Error(`Malformed Safety Score v9 movement review JSON: ${parsed.message}`);
  const review = SafetyScoreV9MovementReviewRecordSchema.parse(parsed.value);
  if (stableJsonStringifyV1(review) !== row.review_json) {
    throw new Error("Safety Score v9 movement review JSON is not canonical");
  }
  if (review.reviewDigest !== computeSafetyScoreV9MovementReviewDigest(reviewPayload(review))) {
    throw new Error("Safety Score v9 movement review digest mismatch");
  }
  const projection = {
    schemaVersion: SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
    reviewKey: row.review_key,
    reviewClassKey: row.review_class_key,
    reviewedV8Score: row.reviewed_v8_score,
    reviewedV9Score: row.reviewed_v9_score,
    assetId: row.asset_id,
    sourceDiffReportDigest: row.source_diff_report_digest,
    candidateId: row.candidate_id,
    sourcePublicationGenerationId: row.source_publication_generation_id,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    v8MethodologyVersion: row.v8_methodology_version,
    disposition: row.disposition,
    reviewerId: row.reviewer_id,
    rationale: row.rationale,
    reviewedAtSec: row.reviewed_at_sec,
    reviewDigest: row.review_digest,
  };
  if (stableJsonStringifyV1(projection) !== stableJsonStringifyV1(review)) {
    throw new Error(`Safety Score v9 movement review row projection mismatch for ${review.reviewKey}`);
  }
  return review;
}

const REVIEW_SELECT = `SELECT review_key, review_class_key, reviewed_v8_score, reviewed_v9_score,
  asset_id, source_diff_report_digest, candidate_id,
  source_publication_generation_id, policy_digest, evaluation_build_digest,
  v8_methodology_version, disposition, reviewer_id, rationale, reviewed_at_sec,
  review_digest, review_json FROM safety_score_v9_movement_reviews`;

async function loadReviewByKey(
  db: D1Database,
  reviewKey: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9MovementReviewRecord | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(`${REVIEW_SELECT} WHERE review_key = ?`)
        .bind(reviewKey)
        .first<MovementReviewRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseReviewRow(row) : null;
}

export async function persistSafetyScoreV9MovementReview(
  db: D1Database,
  reviewInput: SafetyScoreV9MovementReviewRecord,
  signal?: AbortSignal,
): Promise<{ status: "recorded" | "unchanged"; review: SafetyScoreV9MovementReviewRecord }> {
  throwIfAborted(signal);
  const review = SafetyScoreV9MovementReviewRecordSchema.parse(reviewInput);
  if (review.reviewDigest !== computeSafetyScoreV9MovementReviewDigest(reviewPayload(review))) {
    throw new Error("Safety Score v9 movement review digest mismatch");
  }
  const canonical = stableJsonStringifyV1(review);
  const existing = await loadReviewByKey(db, review.reviewKey, signal);
  if (existing) {
    if (!hasSameImmutableReviewIntent(existing, review)) {
      throw new SafetyScoreV9MovementReviewConflictError(
        `Immutable Safety Score v9 movement review conflict for ${review.reviewKey}`,
      );
    }
    return { status: "unchanged", review: existing };
  }
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `INSERT INTO safety_score_v9_movement_reviews
           (review_key, review_class_key, reviewed_v8_score, reviewed_v9_score,
            asset_id, source_diff_report_digest, candidate_id,
            source_publication_generation_id, policy_digest, evaluation_build_digest,
            v8_methodology_version, disposition, reviewer_id, rationale, reviewed_at_sec,
            review_digest, review_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          review.reviewKey,
          review.reviewClassKey,
          review.reviewedV8Score,
          review.reviewedV9Score,
          review.assetId,
          review.sourceDiffReportDigest,
          review.candidateId,
          review.sourcePublicationGenerationId,
          review.policyDigest,
          review.evaluationBuildDigest,
          review.v8MethodologyVersion,
          review.disposition,
          review.reviewerId,
          review.rationale,
          review.reviewedAtSec,
          review.reviewDigest,
          canonical,
        )
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (Number(result.meta.changes ?? 0) > 0) return { status: "recorded", review };
  const raced = await loadReviewByKey(db, review.reviewKey, signal);
  if (!raced || !hasSameImmutableReviewIntent(raced, review)) {
    throw new SafetyScoreV9MovementReviewConflictError(
      `Immutable Safety Score v9 movement review conflict for ${review.reviewKey}`,
    );
  }
  return { status: "unchanged", review: raced };
}

export async function loadSafetyScoreV9MovementReviews(
  db: D1Database,
  reviewKeysInput: readonly string[],
  signal?: AbortSignal,
): Promise<SafetyScoreV9MovementReviewRecord[]> {
  const reviewKeys = [...new Set(reviewKeysInput)].sort(compareText);
  if (reviewKeys.length === 0) return [];
  const reviews: SafetyScoreV9MovementReviewRecord[] = [];
  for (let offset = 0; offset < reviewKeys.length; offset += 100) {
    throwIfAborted(signal);
    const chunk = reviewKeys.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await runWithOverloadRetry(
      () =>
        db
          .prepare(`${REVIEW_SELECT} WHERE review_key IN (${placeholders}) ORDER BY review_key`)
          .bind(...chunk)
          .all<MovementReviewRow>(),
      3,
      signal,
    );
    reviews.push(...(rows.results ?? []).map(parseReviewRow));
  }
  throwIfAborted(signal);
  return reviews.sort((left, right) => compareText(left.reviewKey, right.reviewKey));
}

export async function loadSafetyScoreV9MovementReviewDispositions(
  db: D1Database,
  reviewKeys: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, SafetyScoreV9MovementReviewDisposition>> {
  return Object.fromEntries(
    (await loadSafetyScoreV9MovementReviews(db, reviewKeys, signal)).map((review) => [
      review.reviewKey,
      review.disposition,
    ]),
  );
}

/**
 * Loads the dispositions eligible to carry into today's run, indexed by movement class key.
 *
 * A class can hold several recorded reviews once a movement's exact key has churned; the most
 * recent ruling wins, since it adjudicated the closest observation. The score anchors travel with
 * it so the caller can enforce the drift cap. This never decides whether a carry applies — it
 * only supplies what was recorded.
 */
export async function loadSafetyScoreV9MovementReviewCarries(
  db: D1Database,
  classKeysInput: readonly string[],
  signal?: AbortSignal,
): Promise<
  Record<
    string,
    {
      reviewKey: string;
      disposition: SafetyScoreV9MovementReviewDisposition;
      reviewedV8Score: number | null;
      reviewedV9Score: number | null;
    }
  >
> {
  const classKeys = [...new Set(classKeysInput)].sort(compareText);
  if (classKeys.length === 0) return {};
  const reviews: SafetyScoreV9MovementReviewRecord[] = [];
  for (let offset = 0; offset < classKeys.length; offset += 100) {
    throwIfAborted(signal);
    const chunk = classKeys.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await runWithOverloadRetry(
      () =>
        db
          .prepare(`${REVIEW_SELECT} WHERE review_class_key IN (${placeholders}) ORDER BY review_key`)
          .bind(...chunk)
          .all<MovementReviewRow>(),
      3,
      signal,
    );
    reviews.push(...(rows.results ?? []).map(parseReviewRow));
  }
  throwIfAborted(signal);
  const byClassKey = new Map<string, SafetyScoreV9MovementReviewRecord>();
  for (const review of reviews) {
    const existing = byClassKey.get(review.reviewClassKey);
    const supersedes =
      existing === undefined ||
      review.reviewedAtSec > existing.reviewedAtSec ||
      (review.reviewedAtSec === existing.reviewedAtSec && compareText(review.reviewKey, existing.reviewKey) > 0);
    if (supersedes) byClassKey.set(review.reviewClassKey, review);
  }
  return Object.fromEntries(
    [...byClassKey.entries()].map(([classKey, review]) => [
      classKey,
      {
        reviewKey: review.reviewKey,
        disposition: review.disposition,
        reviewedV8Score: review.reviewedV8Score,
        reviewedV9Score: review.reviewedV9Score,
      },
    ]),
  );
}
