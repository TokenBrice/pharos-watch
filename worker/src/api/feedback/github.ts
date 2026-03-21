import { drainResponseBody } from "../../lib/response-body";
import { GITHUB_OWNER, GITHUB_REPO } from "./types";

function buildGitHubHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pharos-feedback-widget/1.0",
  };
}

export async function createGitHubIssue(
  pat: string,
  title: string,
  body: string,
  labels: string[],
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: buildGitHubHeaders(pat),
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Issues API ${res.status}: ${text.slice(0, 200)}`);
  }

  await drainResponseBody(res);
}

export async function createGitHubDiscussion(
  pat: string,
  repositoryId: string,
  categoryId: string,
  title: string,
  body: string,
): Promise<boolean> {
  const mutation = `
    mutation CreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { id }
      }
    }
  `;

  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: buildGitHubHeaders(pat),
      body: JSON.stringify({
        query: mutation,
        variables: { repositoryId, categoryId, title, body },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await drainResponseBody(res);
      console.warn("[feedback] GraphQL HTTP error:", res.status);
      return false;
    }
    const data = (await res.json()) as { errors?: unknown[] };
    if (data.errors?.length) {
      console.warn("[feedback] GraphQL errors:", JSON.stringify(data.errors));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[feedback] GraphQL Discussion creation failed:", err);
    return false;
  }
}
