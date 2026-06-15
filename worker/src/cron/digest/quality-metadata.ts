import type { DigestValidationIssue } from "../daily-digest/response";

export function formatQualityMetadata(issues: readonly DigestValidationIssue[]): string {
  return issues.length > 0
    ? `, quality: ${issues.map((issue) => `${issue.code}:${issue.severity}`).join("|")}`
    : "";
}
