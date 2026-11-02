import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mockD1 as createMockD1,
  type MockD1Database,
  type MockD1Options,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import { stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import type { FeedbackEnv } from "../feedback";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockFetch } from "@shared/test-utils/mock-fetch";

import { createGitHubIssue, GitHubIssueRejectedError } from "../feedback/github";
// Stub fetch and crypto.subtle before importing the handler
let fetchSpy: ReturnType<typeof mockFetch>;
let fetchOutcomes: Array<Response | Error | Promise<Response>> = [];

function queueFetch(...outcomes: Array<Response | Error | Promise<Response>>): void {
  fetchOutcomes = outcomes;
}

function installFetchMock(): ReturnType<typeof mockFetch> {
  fetchOutcomes = [];
  return mockFetch([{
    match: "https://api.github.com/repos/TokenBrice/pharos-watch/issues",
    respond: () => fetchOutcomes.shift() ?? new Error("unexpected GitHub request"),
  }], { requireMatch: true });
}

stubCryptoForAuth();

const { logWorkerEventMock, logWorkerEventArgsMock } = vi.hoisted(() => ({
  logWorkerEventMock: vi.fn(),
  logWorkerEventArgsMock: vi.fn(),
}));

vi.mock("../../lib/structured-log", () => ({
  logWorkerEvent: logWorkerEventMock,
  logWorkerEventArgs: logWorkerEventArgsMock,
}));

const { handleFeedback } = await import("../feedback");
const FEEDBACK_IDEMPOTENCY_KEY = "feedback-test-key";
const fixtures = createLatestSchemaFixtureTracker();

describe("bounded GitHub rejection evidence", () => {
  it("preserves known HTTP rejection while capping diagnostics and cancelling remainder", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(4097))); }, cancel,
    }), { status: 422 });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    try {
      await expect(createGitHubIssue("pat", "title", "body", [])).rejects.toMatchObject({
        name: "GitHubIssueRejectedError", status: 422, message: `GitHub Issues API 422: ${"x".repeat(200)}`,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(GitHubIssueRejectedError).toBeDefined();
    } finally {
      fetch.mockRestore();
    }
  });
});

function mockD1(tables: MockTableConfig[] = [], options: MockD1Options = {}): MockD1Database {
  const canned = createMockD1(tables, options);
  let durable: D1Database | undefined;
  const durableHistory: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    ...canned,
    prepare(query: string) {
      if (!query.includes("admin_idempotency_keys")) return canned.prepare(query);
      durable ??= fixtures.open().db;
      durableHistory.push({ sql: query, binds: [] });
      return durable.prepare(query);
    },
    getHistory: () => [...canned.getHistory(), ...durableHistory],
  } as MockD1Database;
}

function createDurableFeedbackDb(): { sqlite: DatabaseSync; db: D1Database } {
  return fixtures.open();
}

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

function makeRequest(body: unknown, idempotencyKey = FEEDBACK_IDEMPOTENCY_KEY): Request {
  return makeJsonRequest("https://x/api/feedback", body, {
    headers: {
      "CF-Connecting-IP": "1.2.3.4",
      "Idempotency-Key": idempotencyKey,
    },
  });
}

function makeRawRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://x/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
      "Idempotency-Key": FEEDBACK_IDEMPOTENCY_KEY,
      ...headers,
    },
    body,
  });
}

function makeRateLimiter(success = true): RateLimit {
  return { limit: vi.fn(async () => ({ success })) } as unknown as RateLimit;
}

function makeEnv(overrides: Partial<FeedbackEnv> = {}): FeedbackEnv {
  return {
    GITHUB_PAT: overrides.GITHUB_PAT ?? "ghp_test_token",
    FEEDBACK_IP_SALT: overrides.FEEDBACK_IP_SALT ?? "test-salt",
    FEEDBACK_PREAUTH_RATE_LIMIT: overrides.FEEDBACK_PREAUTH_RATE_LIMIT ?? makeRateLimiter(),
  };
}

describe("handleFeedback", () => {
  beforeEach(() => {
    fetchSpy = installFetchMock();
    logWorkerEventMock.mockReset();
    logWorkerEventArgsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fixtures.closeAll();
  });

  it("returns 413 for oversized declared bodies before side effects", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(
      db,
      makeRawRequest(JSON.stringify(makeFeedbackBody()), { "Content-Length": String(17 * 1024) }),
      makeEnv(),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "Request body too large" });
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when title is missing for bug type", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ type: "bug", title: "" })), makeEnv());

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(body.error).toMatch(/Title/i);
  });

  it("returns 400 when pageUrl does not start with /", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ pageUrl: "https://evil.com" })), makeEnv());

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(body.error).toMatch(/pageUrl/i);
  });

  it("returns 400 when stablecoinId is invalid", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ stablecoinId: "not-a-real-coin" })), makeEnv());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid stablecoinId" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a well-formed idempotency key only after payload validation", async () => {
    const db = mockD1([]);
    const missingKeyRequest = makeJsonRequest("https://x/api/feedback", makeFeedbackBody(), {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    const missing = await handleFeedback(db, missingKeyRequest, makeEnv());
    const malformed = await handleFeedback(db, makeRequest(makeFeedbackBody(), "bad key"), makeEnv());

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "A valid Idempotency-Key header is required" });
    await expect(malformed.json()).resolves.toEqual({ error: "A valid Idempotency-Key header is required" });
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("silently accepts honeypot submissions", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ website: "I am a bot" })), makeEnv());

    const body = (await readJsonResponse(res, 200)) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized honeypot fields before side effects", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ website: "x".repeat(301) })), makeEnv());

    expect(res.status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries the same key after a 429 without persisting or consuming the rejected attempt", async () => {
    const { sqlite, db } = createDurableFeedbackDb();
    queueFetch(
      new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }),
      new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }),
      new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }),
      new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }),
    );

    for (const key of ["feedback-quota-1", "feedback-quota-2", "feedback-quota-3"]) {
      const response = await handleFeedback(db, makeRequest(makeFeedbackBody(), key), makeEnv());
      expect(response.status).toBe(200);
    }

    const limited = await handleFeedback(db, makeRequest(makeFeedbackBody(), "feedback-quota-retry"), makeEnv());
    expect(limited.status).toBe(429);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM admin_idempotency_keys WHERE idempotency_key = ?")
        .get("feedback-quota-retry"),
    ).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 3 });

    sqlite.prepare("DELETE FROM feedback_rate_limit WHERE rowid = (SELECT MIN(rowid) FROM feedback_rate_limit)").run();
    const retry = await handleFeedback(db, makeRequest(makeFeedbackBody(), "feedback-quota-retry"), makeEnv());

    expect(retry.status).toBe(200);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 3 });
  });

  it("returns explicit degraded-service 503 when feedback rate-limit storage fails", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], throwError: new Error("D1 unavailable") }]);

    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.json()).resolves.toEqual({
      error: "Feedback service temporarily unavailable. Please try again.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 503 when FEEDBACK_IP_SALT is not configured", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), {
      GITHUB_PAT: "ghp_test_token",
      FEEDBACK_PREAUTH_RATE_LIMIT: makeRateLimiter(),
    });

    const body = (await readJsonResponse(res, 503)) as { error: string };
    expect(body.error).toMatch(/misconfigured/i);
  });

  it("rejects an exhausted pre-auth allowance before body or idempotency D1 work", async () => {
    const db = mockD1([]);
    const limiter = makeRateLimiter(false);
    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody()),
      makeEnv({ FEEDBACK_PREAUTH_RATE_LIMIT: limiter }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.json()).resolves.toEqual({ error: "Too many submissions. Please wait a few minutes." });
    expect(limiter.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed without a pre-auth rate-limit binding", async () => {
    const db = mockD1([]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), {
      GITHUB_PAT: "ghp_test_token",
      FEEDBACK_IP_SALT: "test-salt",
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries the same key after pre-execution configuration recovers", async () => {
    const { sqlite, db } = createDurableFeedbackDb();
    queueFetch(new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }));

    const unavailable = await handleFeedback(db, makeRequest(makeFeedbackBody()), {
      FEEDBACK_IP_SALT: "test-salt",
      FEEDBACK_PREAUTH_RATE_LIMIT: makeRateLimiter(),
    });
    expect(unavailable.status).toBe(503);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_idempotency_keys").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 0 });

    const retry = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(retry.status).toBe(200);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 1 });
  });

  it("returns 200 and creates GitHub issue for bug report", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    // Mock successful GitHub Issues API response
    const response = new Response(JSON.stringify({ id: 1, number: 42 }), { status: 201 });
    queueFetch(response);

    const res = await handleFeedback(
      db,
      makeRequest(makeFeedbackBody({ type: "bug", title: "Chart broken" })),
      makeEnv(),
    );

    const body = (await readJsonResponse(res, 200)) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify GitHub API was called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/TokenBrice/pharos-watch/issues");
    expect(init?.method).toBe("POST");
    expect(response.bodyUsed).toBe(true);
  });

  it.each([
    ["eurc-circle", "EURC", "peggedEUR", 1.08, 1.1, -1.818],
    ["xaut-tether", "XAUT", "peggedGOLD", 2990, 3025, -1.157],
  ] as const)("uses the %s peg reference for auto-verification", async (id, symbol, pegType, price, reference, deviation) => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: {
        value: JSON.stringify({
          peggedAssets: [{ id, symbol, price, pegType, circulating: { [pegType]: 5_000_000 } }],
          fxFallbackRates: { [pegType]: reference },
        }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      } },
    ]);
    queueFetch(new Response(JSON.stringify({ id: 5, number: 46 }), { status: 201 }));
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction", stablecoinId: id, stablecoinName: symbol,
      description: "The reported peg deviation appears incorrect.",
    })), makeEnv());
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string };
    const reported = issuePayload.body.match(/\*\*Peg deviation:\*\* (-?[\d.]+)%/);
    expect(Number(reported?.[1])).toBe(deviation);
  });

  it("canonicalizes a client-supplied name from the attached stablecoin ID", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    queueFetch(new Response(JSON.stringify({ id: 12, number: 53 }), { status: 201 }));

    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction",
      stablecoinId: "usdc-circle",
      stablecoinName: "Tether USD",
      description: "The peg deviation shown for this asset is wrong.",
    })), makeEnv());

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { title: string; body: string };
    expect(issuePayload.title).toContain("[Data Correction] USD Coin: ");
    expect(issuePayload.body).toContain("**Stablecoin:** USD Coin (usdc-circle)");
    expect(issuePayload.body).not.toContain("Tether USD");
  });

  it("keeps an ID-less chain label unchanged", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);
    queueFetch(new Response(JSON.stringify({ id: 13, number: 54 }), { status: 201 }));

    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction",
      stablecoinName: "Ethereum",
      description: "The chain health panel shows the wrong status for this chain.",
    })), makeEnv());

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { title: string };
    expect(issuePayload.title).toContain("[Data Correction] Ethereum: ");
  });

  it("does not compare a NAV token price against a fixed-peg reference", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: {
        value: JSON.stringify({
          peggedAssets: [{
            id: "usyc-hashnote", symbol: "USYC", price: 1.1422, pegType: "peggedUSD",
            circulating: { peggedUSD: 5_000_000 },
          }],
        }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      } },
    ]);
    queueFetch(new Response(JSON.stringify({ id: 6, number: 47 }), { status: 201 }));
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction", stablecoinId: "usyc-hashnote", stablecoinName: "USYC",
      description: "The reported peg deviation appears incorrect.",
    })), makeEnv());
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string; labels: string[] };
    expect(issuePayload.labels).not.toContain("verified: confirmed");
    expect(issuePayload.body).toContain("**Peg deviation:** N/A");
  });

  it("withholds a thin peer-median reference from auto-verification", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: {
        value: JSON.stringify({
          peggedAssets: [
            { id: "eurc-circle", symbol: "EURC", price: 1.0, pegType: "peggedEUR", circulating: { peggedEUR: 5_000_000 } },
            { id: "eurs-stasis", symbol: "EURS", price: 1.04, pegType: "peggedEUR", circulating: { peggedEUR: 5_000_000 } },
          ],
        }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      } },
    ]);
    queueFetch(new Response(JSON.stringify({ id: 7, number: 48 }), { status: 201 }));
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction", stablecoinId: "eurs-stasis", stablecoinName: "EURS",
      description: "The reported peg deviation appears incorrect.",
    })), makeEnv());
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string; labels: string[] };
    expect(issuePayload.labels).not.toContain("verified: confirmed");
    expect(issuePayload.body).toContain("**Peg deviation:** N/A");
  });

  it("withholds a reference whose unit disagrees with the curated registry peg", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: {
        value: JSON.stringify({
          peggedAssets: [{
            id: "xaut-tether", symbol: "XAUT", price: 5000, pegType: "peggedUSD",
            circulating: { peggedUSD: 5_000_000 },
          }],
        }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      } },
    ]);
    queueFetch(new Response(JSON.stringify({ id: 8, number: 49 }), { status: 201 }));
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({
      type: "data-correction", stablecoinId: "xaut-tether", stablecoinName: "XAUT",
      description: "The reported peg deviation appears incorrect.",
    })), makeEnv());
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const issuePayload = JSON.parse(String(init?.body)) as { body: string; labels: string[] };
    expect(issuePayload.labels).not.toContain("verified: confirmed");
    expect(issuePayload.body).toContain("**Peg deviation:** N/A");
  });

  it("releases quota and terminally replays a confirmed GitHub rejection", async () => {
    const { sqlite, db } = createDurableFeedbackDb();

    queueFetch(new Response("Forbidden", { status: 403 }));

    const first = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());
    const replay = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    const body = (await readJsonResponse(first, 500)) as { error: string };
    expect(body.error).toMatch(/Failed to submit/i);
    expect(replay.status).toBe(500);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 0 });
    expect(logWorkerEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "feedback_submission_rejected",
      level: "warn",
      provider: "github",
    }));
  });

  it("keeps quota reserved and suppresses retry after an ambiguous GitHub transport failure", async () => {
    const { sqlite, db } = createDurableFeedbackDb();
    queueFetch(new TypeError("network reset"));

    const first = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());
    const replay = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(first.status).toBe(503);
    expect(first.headers.get("X-Execution-Certainty")).toBe("unknown");
    expect(replay.status).toBe(503);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 1 });
    expect(logWorkerEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "feedback_execution_outcome_unknown",
      level: "error",
      provider: "github",
    }));
  });

  it("replays a successful submission without consuming quota or posting twice", async () => {
    const { sqlite, db } = createDurableFeedbackDb();
    queueFetch(new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }));

    const first = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());
    const replay = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 1 });
  });

  it("neutralizes markdown mentions and code fences in GitHub issue bodies", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    queueFetch(new Response(JSON.stringify({ id: 8, number: 49 }), { status: 201 }));

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

});
