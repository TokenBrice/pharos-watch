import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { stubCryptoForAuth } from "./helpers/auth";
import type { FeedbackEnv } from "../feedback";

// Stub fetch and crypto.subtle before importing the handler
const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

stubCryptoForAuth();

const { handleFeedback } = await import("../feedback");

/** Build a valid feedback request body */
function makeFeedbackBody(overrides: Partial<{
  type: string; title: string; description: string;
  pageUrl: string; stablecoinId: string; stablecoinName: string;
  expectedValue: string; website: string;
}> = {}) {
  return {
    type: overrides.type ?? "bug",
    title: overrides.title ?? "Something is broken",
    description: overrides.description ?? "The price chart is not loading correctly on the dashboard.",
    pageUrl: overrides.pageUrl ?? "/stablecoin/1",
    stablecoinId: overrides.stablecoinId,
    stablecoinName: overrides.stablecoinName,
    expectedValue: overrides.expectedValue,
    website: overrides.website,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("https://x/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify(body),
  });
}

function makeEnv(overrides: Partial<FeedbackEnv> = {}): FeedbackEnv {
  return {
    GITHUB_PAT: overrides.GITHUB_PAT ?? "ghp_test_token",
    GITHUB_REPO_NODE_ID: overrides.GITHUB_REPO_NODE_ID,
    GITHUB_DISCUSSION_CATEGORY_ID: overrides.GITHUB_DISCUSSION_CATEGORY_ID,
    FEEDBACK_IP_SALT: overrides.FEEDBACK_IP_SALT ?? "test-salt",
  };
}

describe("handleFeedback", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("returns 400 for invalid JSON body", async () => {
    const db = mockD1([]);
    const request = new Request("https://x/api/feedback", {
      method: "POST",
      body: "not json",
    });
    const res = await handleFeedback(db, request, makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid JSON/i);
  });

  it("returns 400 for invalid feedback type", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ type: "spam" })),
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/type/i);
  });

  it("returns 400 when description is too short", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ description: "short" })),
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Description/i);
  });

  it("returns 400 when title is missing for bug type", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ type: "bug", title: "" })),
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Title/i);
  });

  it("returns 400 when pageUrl does not start with /", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ pageUrl: "https://evil.com" })),
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/pageUrl/i);
  });

  it("silently accepts honeypot submissions", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ website: "I am a bot" })),
      makeEnv()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // Should NOT call GitHub API for honeypot
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 5 } },
    ]);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody()),
      makeEnv()
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Too many/i);
  });

  it("returns 503 when GITHUB_PAT is not configured", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);
    // Explicitly omit GITHUB_PAT (not undefined — ?? would fill the default)
    const env: FeedbackEnv = { FEEDBACK_IP_SALT: "test-salt" };
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody()),
      env
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unavailable/i);
  });

  it("returns 200 and creates GitHub issue for bug report", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);

    // Mock successful GitHub Issues API response
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, number: 42 }), { status: 201 })
    );

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ type: "bug", title: "Chart broken" })),
      makeEnv()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify GitHub API was called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("api.github.com");
    expect(String(url)).toContain("/issues");
    expect(init?.method).toBe("POST");
  });

  it("returns 200 and creates GitHub issue for data-correction", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
      // verifyDataCorrection will query the stablecoins cache
      { match: "cache", rows: [], first: null },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 2, number: 43 }), { status: 201 })
    );

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({
        type: "data-correction",
        description: "The circulating supply is wrong by a large margin.",
        stablecoinId: "1",
        stablecoinName: "Tether",
      })),
      makeEnv()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("tries GitHub Discussion first for feature-request, falls back to issue", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);

    // First call: GraphQL Discussion creation fails
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "fail" }] }), { status: 200 })
    );
    // Second call: Falls back to Issues API
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 3, number: 44 }), { status: 201 })
    );

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({
        type: "feature-request",
        title: "Add dark mode",
        description: "Please add a dark mode toggle to the dashboard.",
      })),
      makeEnv({
        GITHUB_REPO_NODE_ID: "R_abc123",
        GITHUB_DISCUSSION_CATEGORY_ID: "DC_xyz789",
      })
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First call should be GraphQL
    expect(String(fetchSpy.mock.calls[0][0])).toContain("graphql");
    // Second call should be Issues fallback
    expect(String(fetchSpy.mock.calls[1][0])).toContain("/issues");
  });

  it("returns 500 when GitHub API call fails", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody()),
      makeEnv()
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Failed to submit/i);
  });

  it("does not require title for data-correction type", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], first: { cnt: 0 } },
      { match: "cache", rows: [], first: null },
    ]);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 4, number: 45 }), { status: 201 })
    );

    const res = await handleFeedback(
      db,
      makeRequest({
        type: "data-correction",
        description: "The price for this stablecoin is completely wrong.",
        pageUrl: "/stablecoin/1",
        stablecoinId: "1",
        // no title field
      }),
      makeEnv()
    );

    expect(res.status).toBe(200);
  });
});
