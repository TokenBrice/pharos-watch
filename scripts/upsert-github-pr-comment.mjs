#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_COMMENT_MARKER = "<!-- pharos-change-contract -->";

export function findExistingComment(comments, marker = DEFAULT_COMMENT_MARKER) {
  return [...comments]
    .reverse()
    .find((comment) => typeof comment?.body === "string" && comment.body.includes(marker));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function upsertPrComment(
  {
    body,
    marker = DEFAULT_COMMENT_MARKER,
    prNumber,
    repo,
    token,
  },
  { fetchImpl = fetch } = {},
) {
  if (!body?.includes(marker)) {
    throw new Error(`Comment body must include marker ${marker}`);
  }
  if (!repo) throw new Error("Missing GitHub repository");
  if (!prNumber) throw new Error("Missing PR number");
  if (!token) throw new Error("Missing GitHub token");

  const baseUrl = `https://api.github.com/repos/${repo}`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const commentsResponse = await fetchImpl(`${baseUrl}/issues/${prNumber}/comments?per_page=100`, {
    headers,
  });
  const comments = await readJsonResponse(commentsResponse);
  const existing = findExistingComment(Array.isArray(comments) ? comments : [], marker);
  const payload = JSON.stringify({ body });

  if (existing?.id) {
    await readJsonResponse(await fetchImpl(`${baseUrl}/issues/comments/${existing.id}`, {
      body: payload,
      headers,
      method: "PATCH",
    }));
    return { action: "updated", commentId: existing.id };
  }

  const created = await readJsonResponse(await fetchImpl(`${baseUrl}/issues/${prNumber}/comments`, {
    body: payload,
    headers,
    method: "POST",
  }));
  return { action: "created", commentId: created?.id };
}

export async function runCli(env = process.env) {
  const commentFile = env.COMMENT_FILE;
  if (!commentFile) {
    throw new Error("COMMENT_FILE is required");
  }
  const result = await upsertPrComment({
    body: readFileSync(commentFile, "utf8"),
    marker: env.COMMENT_MARKER ?? DEFAULT_COMMENT_MARKER,
    prNumber: env.PR_NUMBER,
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  });
  console.log(`[pharos-change-contract] PR comment ${result.action} (${result.commentId ?? "unknown id"})`);
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
