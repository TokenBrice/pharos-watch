import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { createGitHubIssue } from "../feedback/github";
import { logWorkerEvent } from "../../lib/structured-log";

export function notifySelfServeIssued(
  pat: string | undefined,
  input: { requestId: string; keyPrefix: string; expiresAt: number | null },
): Promise<void> | null {
  if (!pat) return null;
  const body = [
    "A self-serve API key was issued.",
    "",
    `- Request ID: ${input.requestId}`,
    `- Key prefix: ${input.keyPrefix}`,
    `- Quota: ${SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm`,
    `- Expires at: ${input.expiresAt ?? "never"}`,
    "- Details: https://ops.pharos.watch/admin-api/",
    "",
    "Private requester details are available only in the Access-gated admin UI.",
  ].join("\n");
  return createGitHubIssue(
    pat,
    `Self-serve API key issued: ${input.requestId}`,
    body,
    ["api-key-request", "self-serve-issued"],
  ).catch((error) => {
    logWorkerEvent({
      scope: "api",
      level: "warn",
      event: "api_key_request_notification_failed",
      route: "api-key-requests",
      source: "github_issue",
      message: "Best-effort self-serve issuance notification failed",
      error,
      metadata: { requestId: input.requestId },
    });
  });
}
