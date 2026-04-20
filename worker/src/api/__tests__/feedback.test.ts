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
function makeFeedbackBody(
  overrides: Partial<{
    type: string;
    title: string;
    description: string;
    pageUrl: string;
    stablecoinId: string;
    stablecoinName: string;
    expectedValue: string;
    contactHandle: string;
    website: string;
  }> = {},
) {
  return {
    type: overrides.type ?? "bug",
    title: overrides.title ?? "Something is broken",
    description: overrides.description ?? "The price chart is not loading correctly on the dashboard.",
    pageUrl: overrides.pageUrl ?? "/stablecoin/usdt-tether",
    stablecoinId: overrides.stablecoinId,
    stablecoinName: overrides.stablecoinName,
    expectedValue: overrides.expectedValue,
    contactHandle: overrides.contactHandle,
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
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ type: "spam" })), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/type/i);
  });

  it("returns 400 when description is too short", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ description: "short" })), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Description/i);
  });

  it("returns 400 when title is missing for bug type", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ type: "bug", title: "" })), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Title/i);
  });

  it("returns 400 when pageUrl does not start with /", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ pageUrl: "https://evil.com" })), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/pageUrl/i);
  });

  it("returns 400 when pageUrl is protocol-relative", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ pageUrl: "//evil.com" })), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/pageUrl/i);
  });

  it("returns 400 when stablecoinId is invalid", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ stablecoinId: "not-a-real-coin" })), makeEnv());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid stablecoinId" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("silently accepts honeypot submissions", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ website: "I am a bot" })), makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // Should NOT call GitHub API for honeypot
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 0 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Too many/i);
  });

  it("returns 503 when FEEDBACK_IP_SALT is not configured", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), { GITHUB_PAT: "ghp_test_token" });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("returns 503 when GITHUB_PAT is not configured", async () => {
    const db = mockD1([], { requireMatch: true });
    // Explicitly omit GITHUB_PAT (not undefined — ?? would fill the default)
    const env: FeedbackEnv = { FEEDBACK_IP_SALT: "test-salt" };
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unavailable/i);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("returns 200 and creates GitHub issue for bug report", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    // Mock successful GitHub Issues API response
    const response = new Response(JSON.stringify({ id: 1, number: 42 }), { status: 201 });
    fetchSpy.mockResolvedValueOnce(response);

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ type: "bug", title: "Chart broken" })),
      makeEnv(),
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
    expect(response.bodyUsed).toBe(true);
  });

  it("returns 200 and creates GitHub issue for data-correction", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      // verifyDataCorrection will query the stablecoins cache
      { match: "cache", rows: [], first: null },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 2, number: 43 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          type: "data-correction",
          description: "The circulating supply is wrong by a large margin.",
          stablecoinId: "usdt-tether",
          stablecoinName: "Tether",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("uses the EUR peg reference for EUR-pegged data-correction auto-verification", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      {
        match: "cache",
        rows: [],
        first: {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "eurc-circle",
                symbol: "EURC",
                price: 1.08,
                pegType: "peggedEUR",
                circulating: { peggedEUR: 5_000_000 },
              },
            ],
            fxFallbackRates: {
              peggedEUR: 1.1,
            },
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 5, number: 46 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          type: "data-correction",
          description: "EURC appears to be showing the wrong peg deviation.",
          stablecoinId: "eurc-circle",
          stablecoinName: "EURC",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string };
    expect(issuePayload.body).toContain("**Peg deviation:** -1.818%");
  });

  it("uses the commodity peg reference for gold-pegged auto-verification", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      {
        match: "cache",
        rows: [],
        first: {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "xaut-tether",
                symbol: "XAUT",
                price: 2990,
                pegType: "peggedGOLD",
                circulating: { peggedGOLD: 8_000_000 },
              },
            ],
            fxFallbackRates: {
              peggedGOLD: 3025,
            },
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 6, number: 47 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          type: "data-correction",
          description: "XAUT looks off relative to spot gold.",
          stablecoinId: "xaut-tether",
          stablecoinName: "Tether Gold",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string };
    expect(issuePayload.body).toContain("**Peg deviation:** -1.157%");
  });

  it("returns 200 and creates GitHub issue for feature-request", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    const issueResponse = new Response(JSON.stringify({ id: 3, number: 44 }), { status: 201 });
    fetchSpy.mockResolvedValueOnce(issueResponse);

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          type: "feature-request",
          title: "Add dark mode",
          description: "Please add a dark mode toggle to the dashboard.",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/issues");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body)) as { labels: string[] };
    expect(payload.labels).toEqual(["feature-request"]);
    expect(issueResponse.bodyUsed).toBe(true);
  });

  it("returns 500 when GitHub API call fails", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));

    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Failed to submit/i);
  });

  it("does not require title for data-correction type", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: null },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 4, number: 45 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest({
        type: "data-correction",
        description: "The price for this stablecoin is completely wrong.",
        pageUrl: "/stablecoin/usdt-tether",
        stablecoinId: "usdt-tether",
        // no title field
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
  });

  it("neutralizes markdown mentions and code fences in GitHub issue bodies", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 8, number: 49 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          title: "@ops broken",
          description: "Ping @ops and **please** fix this regression.\n```markdown\n@team",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { title: string; body: string };
    expect(issuePayload.title).toContain("@ ops");
    expect(issuePayload.body).toContain("Ping @ ops");
    expect(issuePayload.body).toContain("@ team");
    expect(issuePayload.body).toContain("```text");
    expect(issuePayload.body).not.toContain("```markdown");
  });

  it("includes optional contact handle in GitHub body", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 10, number: 51 }), { status: 201 }));

    const res = await handleFeedback(
      db,
      makeRequest(
        makeFeedbackBody({
          contactHandle: "@PharosHelp",
        }),
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string };
    expect(issuePayload.body).toContain("**Submitter contact:** @ PharosHelp");
  });
});
