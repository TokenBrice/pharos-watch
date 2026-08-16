import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllFetchRoutesUsed, mockFetch, mockFetchStrict } from "../__shared/mock-fetch";

describe("mockFetch helper", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps ordinary routes reusable while tracking request history", async () => {
    const fetchSpy = mockFetch([
      { match: "api.example.test/prices", body: { ok: true } },
    ]);

    const res = await fetch("https://api.example.test/prices?ids=usdt");
    const repeat = await fetch("https://api.example.test/prices?ids=usdt");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await repeat.json()).toEqual({ ok: true });
    expect(fetchSpy.getHistory()).toEqual([
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
    ]);
    expect(() => fetchSpy.assertAllRoutesUsed()).not.toThrow();
  });

  it("canonicalizes Request and init details in request history", async () => {
    const fetchSpy = mockFetch([{ match: "api.example.test/submit", body: { ok: true } }]);
    const request = new Request("https://api.example.test/submit", {
      method: "POST",
      headers: { "X-Original": "discarded" },
      body: "original body",
    });

    await fetch(request, {
      method: "PATCH",
      headers: [["X-Zebra", "z"], ["A-Alpha", "a"]],
      body: '{"replayed":true}',
    });

    const history = fetchSpy.getHistory();
    expect(history).toEqual([{
      url: "https://api.example.test/submit",
      method: "PATCH",
      headers: { "a-alpha": "a", "content-type": "text/plain;charset=UTF-8", "x-zebra": "z" },
      body: '{"replayed":true}',
    }]);
    expect(Object.keys(history[0]!.headers)).toEqual(["a-alpha", "content-type", "x-zebra"]);
  });

  it("can route repeated URLs by request body", async () => {
    mockFetch([
      { match: "api.example.test/graphql", matchBody: "PoolQuery", body: { data: "pools" } },
      { match: "api.example.test/graphql", matchBody: "AmpQuery", body: { data: "amps" } },
    ], { requireMatch: true });

    const pools = await fetch("https://api.example.test/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "PoolQuery" }),
    });
    const amps = await fetch("https://api.example.test/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "AmpQuery" }),
    });

    expect(await pools.json()).toEqual({ data: "pools" });
    expect(await amps.json()).toEqual({ data: "amps" });
  });

  it("supports request predicate matchers", async () => {
    mockFetch([
      {
        match: (request) => request.method === "DELETE" && new URL(request.url).searchParams.get("id") === "7",
        body: { deleted: true },
      },
    ], { requireMatch: true });

    const response = await fetch("https://api.example.test/items?id=7", { method: "DELETE" });

    expect(await response.json()).toEqual({ deleted: true });
    await expect(fetch("https://api.example.test/items?id=8", { method: "DELETE" })).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/items?id=8",
    );
  });

  it("matches required headers without rejecting extra request headers", async () => {
    mockFetch([
      {
        match: "api.example.test/authorized",
        matchHeaders: { Authorization: "Bearer test-token", "X-Tenant": "pharos" },
        body: { authorized: true },
      },
    ], { requireMatch: true });

    const response = await fetch("https://api.example.test/authorized", {
      headers: { authorization: "Bearer test-token", "x-tenant": "pharos", "x-extra": "kept" },
    });

    expect(await response.json()).toEqual({ authorized: true });
    await expect(fetch("https://api.example.test/authorized", {
      headers: { authorization: "Bearer wrong-token", "x-tenant": "pharos" },
    })).rejects.toThrow("mockFetch: no match for URL: https://api.example.test/authorized");
  });

  it("matches parsed JSON bodies structurally or with a predicate", async () => {
    mockFetch([
      {
        match: "api.example.test/exact-json",
        matchJson: { nested: { enabled: true }, ids: [1, 2] },
        body: { match: "exact" },
      },
      {
        match: "api.example.test/predicate-json",
        matchJson: (body) => typeof body === "object" && body != null && "kind" in body && body.kind === "probe",
        body: { match: "predicate" },
      },
    ], { requireMatch: true });

    const exact = await fetch("https://api.example.test/exact-json", {
      method: "POST",
      body: JSON.stringify({ ids: [1, 2], nested: { enabled: true } }),
    });
    const predicate = await fetch("https://api.example.test/predicate-json", {
      method: "POST",
      body: JSON.stringify({ kind: "probe", ignored: true }),
    });

    expect(await exact.json()).toEqual({ match: "exact" });
    expect(await predicate.json()).toEqual({ match: "predicate" });
    await expect(fetch("https://api.example.test/exact-json", {
      method: "POST",
      body: JSON.stringify({ nested: { enabled: true }, ids: [2, 1] }),
    })).rejects.toThrow("mockFetch: no match for URL: https://api.example.test/exact-json");
  });

  it("computes dynamic responses from the normalized request", async () => {
    const fetchSpy = mockFetch([{
      match: "api.example.test/echo",
      respond: async (request) => ({
        body: { method: request.method, body: await request.text() },
        status: 201,
        headers: { "X-Dynamic": "yes" },
      }),
    }], { requireMatch: true });

    const response = await fetch("https://api.example.test/echo", { method: "POST", body: "payload" });

    expect(response.status).toBe(201);
    expect(response.headers.get("X-Dynamic")).toBe("yes");
    expect(await response.json()).toEqual({ method: "POST", body: "payload" });
    expect(fetchSpy.getHistory()[0]?.body).toBe("payload");
  });

  it("resolves delayed responses after the configured duration", async () => {
    vi.useFakeTimers();
    mockFetch([{
      match: "api.example.test/delayed",
      body: { ready: true },
      delayMs: 100,
    }], { requireMatch: true });

    let settled = false;
    const pending = fetch("https://api.example.test/delayed").then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(settled).toBe(true);
    expect(await response.json()).toEqual({ ready: true });
  });

  it("throws on unexpected URLs when requireMatch is enabled", async () => {
    mockFetch([], { requireMatch: true });

    await expect(fetch("https://api.example.test/missing")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/missing",
    );
  });

  it("supports explicit not-found and passthrough unmatched URL policies", async () => {
    const originalFetch = vi.fn(async () => new Response("upstream", { status: 202 }));
    vi.stubGlobal("fetch", originalFetch);
    mockFetch([], { unmatched: "passthrough" });

    const passthrough = await fetch("https://api.example.test/passthrough");
    expect(passthrough.status).toBe(202);
    expect(await passthrough.text()).toBe("upstream");
    expect(originalFetch).toHaveBeenCalledWith(expect.any(Request));

    mockFetch([], { unmatched: "not-found" });
    const missing = await fetch("https://api.example.test/missing");
    expect(missing.status).toBe(404);
  });

  it("supports exact URL matching in strictUrl mode", async () => {
    const fetchSpy = mockFetchStrict([
      { match: "https://api.example.test/prices?ids=usdt", body: { exact: true } },
    ]);

    const res = await fetch("https://api.example.test/prices?ids=usdt");
    expect(await res.json()).toEqual({ exact: true });

    await expect(fetch("https://api.example.test/prices?ids=usdc")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/prices?ids=usdc",
    );
    expect(fetchSpy.getHistory()).toEqual([
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
      { url: "https://api.example.test/prices?ids=usdc", method: "GET", headers: {}, body: null },
    ]);
  });

  it("reports unused configured routes", () => {
    const fetchSpy = mockFetch([
      { match: "api.example.test/unused", body: {} },
    ]);

    expect(() => fetchSpy.assertAllRoutesUsed()).toThrow(
      "mockFetch: unused route match(es): api.example.test/unused",
    );
  });

  it("can create a strict spy without stubbing global fetch", async () => {
    const fetchSpy = mockFetchStrict([
      { match: "https://api.example.test/prices", body: { exact: true } },
    ], { stubGlobal: false });

    const res = await fetchSpy("https://api.example.test/prices");

    expect(await res.json()).toEqual({ exact: true });
    expect(() => assertAllFetchRoutesUsed(fetchSpy)).not.toThrow();
  });

  it("replays scripted responses in order and fails when they are exhausted", async () => {
    const fetchSpy = mockFetch([{
      match: "api.example.test/retry",
      outcomes: [
        { body: { retry: true }, status: 503, headers: { "Retry-After": "1" } },
        { body: { ok: true } },
      ],
    }]);

    const first = await fetch("https://api.example.test/retry");
    const second = await fetch("https://api.example.test/retry");

    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("1");
    expect(await second.json()).toEqual({ ok: true });
    await expect(fetch("https://api.example.test/retry")).rejects.toThrow(
      "mockFetch: scripted outcomes exhausted for route match: api.example.test/retry (configured 2)",
    );
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("replays network errors", async () => {
    const networkFailure = new TypeError("socket reset");
    const fetchSpy = mockFetch([{
      match: "api.example.test/network",
      outcomes: [networkFailure],
    }]);

    await expect(fetch("https://api.example.test/network")).rejects.toBe(networkFailure);
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("replays a raw response for streaming and non-JSON contracts", async () => {
    const raw = new Response("rate limited", { status: 429, headers: { "Retry-After": "5" } });
    mockFetch([{
      match: "api.example.test/raw",
      outcomes: [{ response: raw }],
    }]);

    const response = await fetch("https://api.example.test/raw");
    expect(response).toBe(raw);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
  });

  it("stalls until the request signal aborts", async () => {
    const originalController = new AbortController();
    const effectiveController = new AbortController();
    const fetchSpy = mockFetch([{
      match: "api.example.test/stall",
      outcomes: [{ stall: true }],
    }]);

    const pending = fetch(
      new Request("https://api.example.test/stall", { signal: originalController.signal }),
      { signal: effectiveController.signal },
    );
    effectiveController.abort(new DOMException("test abort", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "test abort" });
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("reports unused scripted outcomes by route", async () => {
    const fetchSpy = mockFetch([{
      match: "api.example.test/unused-outcomes",
      outcomes: [{ body: { first: true } }, { body: { second: true } }],
    }]);

    await fetch("https://api.example.test/unused-outcomes");

    expect(() => fetchSpy.assertAllOutcomesUsed()).toThrow(
      "mockFetch: unused scripted outcome(s): api.example.test/unused-outcomes (1 remaining)",
    );
  });
});
