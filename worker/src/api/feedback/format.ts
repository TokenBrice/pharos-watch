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

function sanitizeBlockText(input: string): string {
  return normalizeMultilineText(input)
    .replace(/`{3,}/g, (run) => Array.from(run).join("\\"))
    .replace(/@/g, "@ ");
}

function buildTextFence(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, maxRun + 1));
}

function formatTextBlock(label: string, value: string): string[] {
  const text = sanitizeBlockText(value);
  const fence = buildTextFence(text);
  return [`**${label}:**`, `${fence}text`, text, fence];
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

  const titleMap: Record<string, string> = {
    bug: `[Bug] ${sanitizeInlineText((feedback.title ?? "").trim()).slice(0, 100)}`,
    "data-correction": `[Data Correction] ${stablecoinPart}${shortDesc}${ellipsis}`,
    "feature-request": `[Feature Request] ${sanitizeInlineText((feedback.title ?? "").trim()).slice(0, 100)}`,
  };

  const labelsMap: Record<string, string[]> = {
    bug: ["bug"],
    "data-correction": ["data-correction", verifiedLabel],
    "feature-request": ["feature-request"],
  };

  return {
    title: titleMap[feedback.type] ?? titleMap.bug,
    labels: labelsMap[feedback.type] ?? labelsMap.bug,
    body: formatFeedbackBody(feedback, verificationBlock),
  };
}
