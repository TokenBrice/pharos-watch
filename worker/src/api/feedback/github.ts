import { drainResponseBody } from "../../lib/response-body";
import { GITHUB_OWNER, GITHUB_REPO } from "./types";

export class GitHubIssueRejectedError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`GitHub Issues API ${status}: ${detail}`);
    this.name = "GitHubIssueRejectedError";
    this.status = status;
  }
}

function buildGitHubHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pharos-feedback-widget/1.0",
  };
}

export async function createGitHubIssue(pat: string, title: string, body: string, labels: string[]): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: buildGitHubHeaders(pat),
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubIssueRejectedError(res.status, text.slice(0, 200));
  }

  await drainResponseBody(res);
}
