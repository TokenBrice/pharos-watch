import { buildFeatureRequestSubmission, buildIssueSubmission } from "./format";
import { createGitHubDiscussion, createGitHubIssue } from "./github";
import { verifyDataCorrection } from "./verification";
import type { GitHubSubmissionResult, PreparedFeedbackSubmission, VerifiedLabel } from "./types";

export async function submitFeedback(
  db: D1Database,
  submission: PreparedFeedbackSubmission,
): Promise<GitHubSubmissionResult> {
  const { feedback, pat, submissionId } = submission;

  if (feedback.type === "feature-request") {
    const { title, body } = buildFeatureRequestSubmission(feedback, submissionId);

    let created: GitHubSubmissionResult | null = null;
    if (submission.repositoryId && submission.discussionCategoryId) {
      created = await createGitHubDiscussion(
        pat,
        submission.repositoryId,
        submission.discussionCategoryId,
        title,
        body,
      );
    }
    if (created) {
      return created;
    }
    return createGitHubIssue(pat, title, body, ["feature-request"]);
  }

  let verificationBlock: string | undefined;
  let verifiedLabel: VerifiedLabel = "verified: pending";

  if (feedback.type === "data-correction" && submission.canonicalStablecoinId) {
    const verification = await verifyDataCorrection(db, submission.canonicalStablecoinId);
    verificationBlock = verification.block;
    verifiedLabel = verification.verifiedLabel;
  }

  const issue = buildIssueSubmission(feedback, submissionId, verificationBlock, verifiedLabel);
  return createGitHubIssue(pat, issue.title, issue.body, issue.labels);
}
