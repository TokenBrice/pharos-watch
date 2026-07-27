import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
  SafetyScoreV9MovementReviewRecordSchema,
  type SafetyScoreV9MovementReviewDisposition,
  type SafetyScoreV9MovementReviewRecord,
} from "@shared/types/safety-score-v9-review";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { parseJson } from "./json-parse";

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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reviewPayload(review: SafetyScoreV9MovementReviewRecord) {
  const { reviewDigest: _reviewDigest, ...payload } = review;
  return payload;
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

async function loadSafetyScoreV9MovementReviews(
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
