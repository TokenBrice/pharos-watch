import { buildFeatureRequestSubmission, buildIssueSubmission } from "./format";
import { createGitHubDiscussion, createGitHubIssue } from "./github";
import { verifyDataCorrection } from "./verification";
import type { PreparedFeedbackSubmission, VerifiedLabel } from "./types";

export async function submitFeedback(
  db: D1Database,
  submission: PreparedFeedbackSubmission,
): Promise<void> {
  const { feedback, pat } = submission;

  if (feedback.type === "feature-request") {
    const { title, body } = buildFeatureRequestSubmission(feedback);

    let created = false;
    if (submission.repositoryId && submission.discussionCategoryId) {
      created = await createGitHubDiscussion(
        pat,
        submission.repositoryId,
        submission.discussionCategoryId,
        title,
        body,
      );
    }
    if (!created) {
      await createGitHubIssue(pat, title, body, ["feature-request"]);
    }
    return;
  }

  let verificationBlock: string | undefined;
  let verifiedLabel: VerifiedLabel = "verified: pending";

  if (feedback.type === "data-correction" && submission.canonicalStablecoinId) {
    const verification = await verifyDataCorrection(db, submission.canonicalStablecoinId);
    verificationBlock = verification.block;
    verifiedLabel = verification.verifiedLabel;
  }

  const issue = buildIssueSubmission(feedback, verificationBlock, verifiedLabel);
  await createGitHubIssue(pat, issue.title, issue.body, issue.labels);
}
