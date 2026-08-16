import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mockD1 as createMockD1,
  type MockD1Database,
  type MockD1Options,
  type MockTableConfig,
} from "../../test-helpers/__shared/mock-d1";
import { stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import type { FeedbackEnv } from "../feedback";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

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
const encoder = new TextEncoder();
const FEEDBACK_IDEMPOTENCY_KEY = "feedback-test-key";

function mockD1(tables: MockTableConfig[] = [], options: MockD1Options = {}): MockD1Database {
  const canned = createMockD1(tables, options);
  const sqlite = createLatestSchemaSqlite().sqlite;
  const durable = createSqliteD1(sqlite);
  const durableHistory: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    ...canned,
    prepare(query: string) {
      if (!query.includes("admin_idempotency_keys")) return canned.prepare(query);
      durableHistory.push({ sql: query, binds: [] });
      return durable.prepare(query);
    },
    getHistory: () => [...canned.getHistory(), ...durableHistory],
  } as MockD1Database;
}

function createDurableFeedbackDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
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
  return new Request("https://x/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
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

function makeStreamedRequest(chunks: string[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request("https://x/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
      "Idempotency-Key": FEEDBACK_IDEMPOTENCY_KEY,
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function makeEnv(overrides: Partial<FeedbackEnv> = {}): FeedbackEnv {
  return {
    GITHUB_PAT: overrides.GITHUB_PAT ?? "ghp_test_token",
    FEEDBACK_IP_SALT: overrides.FEEDBACK_IP_SALT ?? "test-salt",
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

  it("returns 413 for oversized declared bodies before side effects", async () => {
    const db = mockD1([], { requireMatch: true });
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

  it("returns 413 for oversized streamed bodies before side effects", async () => {
    const db = mockD1([], { requireMatch: true });
    const res = await handleFeedback(
      db,
      makeStreamedRequest([
        '{"type":"bug","title":"Broken","description":"',
        "x".repeat(17 * 1024),
        '","pageUrl":"/stablecoin/usdt-tether"}',
      ]),
      makeEnv(),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "Request body too large" });
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("requires a well-formed idempotency key only after payload validation", async () => {
    const db = mockD1([], { requireMatch: true });
    const missingKeyRequest = new Request("https://x/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify(makeFeedbackBody()),
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
    const db = mockD1([], { requireMatch: true });
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ website: "I am a bot" })), makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized honeypot fields before side effects", async () => {
    const db = mockD1([], { requireMatch: true });
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody({ website: "x".repeat(301) })), makeEnv());

    expect(res.status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 0 } }]);
    const res = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Too many/i);
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
    expect(db.getHistory().some((entry) => entry.sql.includes("feedback_rate_limit"))).toBe(false);
  });

  it("retries the same key after pre-execution configuration recovers", async () => {
    const { sqlite, db } = createDurableFeedbackDb();
    queueFetch(new Response(JSON.stringify({ id: 11, number: 52 }), { status: 201 }));

    const unavailable = await handleFeedback(db, makeRequest(makeFeedbackBody()), { FEEDBACK_IP_SALT: "test-salt" });
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify GitHub API was called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/TokenBrice/pharos-watch/issues");
    expect(init?.method).toBe("POST");
    expect(response.bodyUsed).toBe(true);
  });

  it("returns 200 and creates GitHub issue for data-correction", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      // verifyDataCorrection will query the stablecoins cache
      { match: "cache", rows: [], first: null },
    ]);

    queueFetch(new Response(JSON.stringify({ id: 2, number: 43 }), { status: 201 }));

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

    queueFetch(new Response(JSON.stringify({ id: 5, number: 46 }), { status: 201 }));

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

    queueFetch(new Response(JSON.stringify({ id: 6, number: 47 }), { status: 201 }));

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
    queueFetch(issueResponse);

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
    expect(String(url)).toBe("https://api.github.com/repos/TokenBrice/pharos-watch/issues");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body)) as { labels: string[] };
    expect(payload.labels).toEqual(["feature-request"]);
    expect(issueResponse.bodyUsed).toBe(true);
  });

  it("releases quota and terminally replays a confirmed GitHub rejection", async () => {
    const { sqlite, db } = createDurableFeedbackDb();

    queueFetch(new Response("Forbidden", { status: 403 }));

    const first = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());
    const replay = await handleFeedback(db, makeRequest(makeFeedbackBody()), makeEnv());

    expect(first.status).toBe(500);
    const body = (await first.json()) as { error: string };
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

  it("does not require title for data-correction type", async () => {
    const db = mockD1([
      { match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } },
      { match: "cache", rows: [], first: null },
    ]);

    queueFetch(new Response(JSON.stringify({ id: 4, number: 45 }), { status: 201 }));

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

  it("includes optional contact handle in GitHub body", async () => {
    const db = mockD1([{ match: "feedback_rate_limit", rows: [], runMeta: { changes: 1 } }]);

    queueFetch(new Response(JSON.stringify({ id: 10, number: 51 }), { status: 201 }));

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
