import type { FeedbackBody, VerifiedLabel } from "./types";

function normalizeMultilineText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

function sanitizeInlineText(input: string): string {
  return normalizeMultilineText(input)
    .replace(/\n+/g, " ")
    .replace(/@/g, "@ ")
    .slice(0, 200);
}

function formatTextBlock(label: string, value: string): string[] {
  return [`**${label}:**`, "```text", normalizeMultilineText(value), "```"];
}

function formatFeedbackBody(feedback: FeedbackBody, verificationBlock?: string): string {
  const lines: string[] = [];

  lines.push(
    `**Type:** ${feedback.type === "bug" ? "Bug Report" : feedback.type === "data-correction" ? "Data Correction" : "Feature Request"}`,
  );

  if (feedback.stablecoinName || feedback.stablecoinId) {
    const name = sanitizeInlineText(feedback.stablecoinName ?? "").slice(0, 100);
    const id = feedback.stablecoinId ? ` (${sanitizeInlineText(feedback.stablecoinId).slice(0, 100)})` : "";
    lines.push(`**Stablecoin:** ${name}${id}`);
  }

  const safePageUrl = sanitizeInlineText(feedback.pageUrl);
  lines.push(`**Page:** ${safePageUrl}`);

  if (feedback.pegValue) lines.push(`**Current value:** ${sanitizeInlineText(feedback.pegValue).slice(0, 100)}`);
  if (feedback.contactHandle) {
    lines.push(`**Submitter contact:** ${sanitizeInlineText(feedback.contactHandle)}`);
  }

  lines.push("", ...formatTextBlock("Description", feedback.description));

  if (feedback.expectedValue) {
    lines.push("", ...formatTextBlock("Expected value / source", feedback.expectedValue));
  }

  if (verificationBlock) lines.push("", verificationBlock);

  lines.push("", "---", "*Submitted via Pharos feedback widget*");

  return lines.join("\n");
}

export function buildIssueSubmission(
  feedback: FeedbackBody,
  verificationBlock?: string,
  verifiedLabel: VerifiedLabel = "verified: pending",
): { title: string; labels: string[]; body: string } {
  const stablecoinPart = feedback.stablecoinName ? `${sanitizeInlineText(feedback.stablecoinName).slice(0, 100)}: ` : "";
  const shortDesc = sanitizeInlineText(feedback.description).slice(0, 60);
  const ellipsis = sanitizeInlineText(feedback.description).length > 60 ? "..." : "";

  return {
    title:
      feedback.type === "bug"
        ? `[Bug] ${sanitizeInlineText((feedback.title ?? "").trim()).slice(0, 100)}`
        : `[Data Correction] ${stablecoinPart}${shortDesc}${ellipsis}`,
    labels: feedback.type === "bug" ? ["bug"] : ["data-correction", verifiedLabel],
    body: formatFeedbackBody(feedback, verificationBlock),
  };
}

export function buildFeatureRequestSubmission(
  feedback: FeedbackBody,
): { title: string; body: string } {
  return {
    title: `[Feature Request] ${sanitizeInlineText((feedback.title ?? "").trim()).slice(0, 100)}`,
    body: formatFeedbackBody(feedback),
  };
}
