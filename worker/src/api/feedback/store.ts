import type { FeedbackBody, GitHubSubmissionResult } from "./types";

type FeedbackSubmissionStatus = "pending" | "submitted" | "failed";

function buildSubmissionId(nowMs: number): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `fb_${nowMs.toString(36)}_${suffix}`;
}

function encodeNullable(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value;
}

function encodeFlag(value: boolean | undefined): number {
  return value ? 1 : 0;
}

export async function createFeedbackSubmissionRecord(
  db: D1Database,
  feedback: FeedbackBody,
): Promise<{ submissionId: string; createdAt: number }> {
  const nowMs = Date.now();
  const createdAt = Math.floor(nowMs / 1000);
  const submissionId = buildSubmissionId(nowMs);

  await db
    .prepare(
      `INSERT INTO feedback_submissions (
         submission_id,
         created_at,
         status,
         feedback_type,
         title,
         description,
         expected_value,
         stablecoin_id,
         stablecoin_name,
         page_url,
         peg_value,
         contact_consent,
         contact_channel,
         contact_handle
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      submissionId,
      createdAt,
      "pending" satisfies FeedbackSubmissionStatus,
      feedback.type,
      encodeNullable(feedback.title),
      feedback.description,
      encodeNullable(feedback.expectedValue),
      encodeNullable(feedback.stablecoinId),
      encodeNullable(feedback.stablecoinName),
      feedback.pageUrl,
      encodeNullable(feedback.pegValue),
      encodeFlag(feedback.contactConsent),
      encodeNullable(feedback.contactChannel),
      encodeNullable(feedback.contactHandle),
    )
    .run();

  return { submissionId, createdAt };
}

export async function markFeedbackSubmissionSubmitted(
  db: D1Database,
  submissionId: string,
  result: GitHubSubmissionResult,
): Promise<void> {
  await db
    .prepare(
      `UPDATE feedback_submissions
          SET status = ?,
              submitted_at = ?,
              github_target_kind = ?,
              github_target_number = ?,
              github_target_url = ?,
              last_error = NULL
        WHERE submission_id = ?`,
    )
    .bind(
      "submitted" satisfies FeedbackSubmissionStatus,
      Math.floor(Date.now() / 1000),
      result.kind,
      result.number,
      result.url,
      submissionId,
    )
    .run();
}

export async function markFeedbackSubmissionFailed(
  db: D1Database,
  submissionId: string,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE feedback_submissions
          SET status = ?,
              submitted_at = ?,
              last_error = ?
        WHERE submission_id = ?`,
    )
    .bind(
      "failed" satisfies FeedbackSubmissionStatus,
      Math.floor(Date.now() / 1000),
      errorMessage.slice(0, 500),
      submissionId,
    )
    .run();
}
