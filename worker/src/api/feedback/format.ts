import type { FeedbackBody, VerifiedLabel } from "./types";

function formatFeedbackBody(feedback: FeedbackBody, verificationBlock?: string): string {
  const lines: string[] = [];

  lines.push(
    `**Type:** ${feedback.type === "bug" ? "Bug Report" : feedback.type === "data-correction" ? "Data Correction" : "Feature Request"}`,
  );

  if (feedback.stablecoinName || feedback.stablecoinId) {
    const name = (feedback.stablecoinName ?? "").replace(/[\r\n]/g, " ").slice(0, 100);
    const id = feedback.stablecoinId ? ` (${feedback.stablecoinId})` : "";
    lines.push(`**Stablecoin:** ${name}${id}`);
  }

  const safePageUrl = feedback.pageUrl.replace(/[\r\n]/g, " ").slice(0, 200);
  lines.push(`**Page:** ${safePageUrl}`);

  if (feedback.pegValue) lines.push(`**Current value:** ${feedback.pegValue}`);
  if (feedback.expectedValue) lines.push(`**Expected value / source:** ${feedback.expectedValue}`);

  lines.push("", "**Description:**", feedback.description);

  if (verificationBlock) lines.push("", verificationBlock);

  lines.push("", "---", "*Submitted via Pharos feedback widget*");

  return lines.join("\n");
}

export function buildIssueSubmission(
  feedback: FeedbackBody,
  verificationBlock?: string,
  verifiedLabel: VerifiedLabel = "verified: pending",
): { title: string; labels: string[]; body: string } {
  const stablecoinPart = feedback.stablecoinName ? `${feedback.stablecoinName}: ` : "";
  const shortDesc = feedback.description.trim().slice(0, 60);
  const ellipsis = feedback.description.trim().length > 60 ? "…" : "";

  return {
    title:
      feedback.type === "bug"
        ? `[Bug] ${(feedback.title ?? "").trim()}`
        : `[Data Correction] ${stablecoinPart}${shortDesc}${ellipsis}`,
    labels: feedback.type === "bug" ? ["bug"] : ["data-correction", verifiedLabel],
    body: formatFeedbackBody(feedback, verificationBlock),
  };
}

export function buildFeatureRequestSubmission(feedback: FeedbackBody): { title: string; body: string } {
  return {
    title: `[Feature Request] ${(feedback.title ?? "").trim()}`,
    body: formatFeedbackBody(feedback),
  };
}
