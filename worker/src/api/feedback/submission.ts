import { buildIssueSubmission } from "./format";
import { createGitHubIssue } from "./github";
import { verifyDataCorrection } from "./verification";
import type { PreparedFeedbackSubmission, VerifiedLabel } from "./types";

export async function submitFeedback(
  db: D1Database,
  submission: PreparedFeedbackSubmission,
): Promise<void> {
  const { feedback, pat } = submission;

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
