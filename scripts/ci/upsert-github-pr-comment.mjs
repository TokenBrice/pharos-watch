#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

export const DEFAULT_COMMENT_MARKER = "<!-- pharos-change-contract -->";

export class GitHubApiError extends Error {
  constructor(status, text) {
    super(`GitHub API ${status}: ${text.slice(0, 500)}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export function findExistingComment(comments, marker = DEFAULT_COMMENT_MARKER) {
  return [...comments]
    .reverse()
    .find((comment) => typeof comment?.body === "string" && comment.body.includes(marker));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new GitHubApiError(response.status, text);
  }
  return text ? JSON.parse(text) : null;
}

/** Extracts the `rel="next"` URL from a GitHub Link header, or null. */
export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetches every comment page for the PR, following GitHub's Link pagination
 * so a marker comment beyond the first 100 is still found.
 */
async function fetchAllComments(firstUrl, headers, fetchImpl) {
  const comments = [];
  let url = firstUrl;
  while (url) {
    const response = await fetchImpl(url, { headers });
    const nextUrl = parseNextLink(response.headers?.get?.("link"));
    const page = await readJsonResponse(response);
    if (Array.isArray(page)) comments.push(...page);
    url = nextUrl;
  }
  return comments;
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

  try {
    const baseUrl = `https://api.github.com/repos/${repo}`;
    const headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const comments = await fetchAllComments(
      `${baseUrl}/issues/${prNumber}/comments?per_page=100`,
      headers,
      fetchImpl,
    );
    const existing = findExistingComment(comments, marker);
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
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 403) {
      return { action: "skipped", reason: "forbidden" };
    }
    throw error;
  }
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
  if (result.action === "skipped") {
    console.warn(`[pharos-change-contract] PR comment skipped (${result.reason ?? "unknown reason"})`);
    return;
  }
  console.log(`[pharos-change-contract] PR comment ${result.action} (${result.commentId ?? "unknown id"})`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
