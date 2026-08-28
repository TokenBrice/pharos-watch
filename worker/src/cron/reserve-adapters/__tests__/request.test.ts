import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse, mockFetchStrict } from "@shared/test-utils/mock-fetch";
import {
  buildBrowserHeaders,
  fetchJsonAdapterInput,
  fetchJsonPostWithRetry,
  fetchJsonWithRetry,
  fetchBinaryResponseWithRetry,
  fetchTextWithRetry,
  getCachedRequest,
  REQUEST_CACHE_MAX_ENTRY_BYTES,
  REQUEST_CACHE_MAX_TOTAL_BYTES,
} from "../request";

describe("buildBrowserHeaders", () => {
  it("returns the canonical Origin/Referer/Accept-Language triple", () => {
    const headers = buildBrowserHeaders("https://app.example.com") as Record<string, string>;
    expect(headers.Origin).toBe("https://app.example.com");
    expect(headers.Referer).toBe("https://app.example.com");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("allows a distinct Referer when an adapter uses a deeper path", () => {
    const headers = buildBrowserHeaders(
      "https://app.ethena.fi",
      "https://app.ethena.fi/dashboards/transparency",
    ) as Record<string, string>;
    expect(headers.Origin).toBe("https://app.ethena.fi");
    expect(headers.Referer).toBe("https://app.ethena.fi/dashboards/transparency");
  });

  it("evicts failed cached requests so the next call can recover", async () => {
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    let calls = 0;

    await expect(getCachedRequest("recoverable", async () => {
      calls++;
      throw new Error("first attempt failed");
    }, ctx)).rejects.toThrow("first attempt failed");

    const recovered = await getCachedRequest("recoverable", async () => {
      calls++;
      return "ok";
    }, ctx);

    expect(recovered).toBe("ok");
    expect(calls).toBe(2);
  });

  it("evicts least-recently-used successful bodies within the byte budget", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const ctx = { requestCache: cache };
    const body = "x".repeat(REQUEST_CACHE_MAX_ENTRY_BYTES);

    for (const key of ["first", "second", "third", "fourth"]) {
      await getCachedRequest(key, async () => body, ctx);
    }
    await getCachedRequest("first", async () => "unused", ctx);
    await getCachedRequest("fifth", async () => body, ctx);

    expect(cache.has("first")).toBe(true);
    expect(cache.has("second")).toBe(false);
    expect(cache.has("third")).toBe(true);
    expect(cache.has("fourth")).toBe(true);
    expect(cache.has("fifth")).toBe(true);
    expect(cache.size).toBe(REQUEST_CACHE_MAX_TOTAL_BYTES / REQUEST_CACHE_MAX_ENTRY_BYTES);
  });

  it("does not retain a successful body larger than the per-entry cap", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const ctx = { requestCache: cache };
    const body = "x".repeat(REQUEST_CACHE_MAX_ENTRY_BYTES + 1);

    await expect(getCachedRequest("oversized", async () => body, ctx)).resolves.toBe(body);
    expect(cache.has("oversized")).toBe(false);
  });
});

describe("adapter request cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dedupes identical JSON GETs within an adapter context", async () => {
    const fetchMock = mockFetchStrict([
      { match: "https://issuer.example/reserves", body: { ok: true } },
    ]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    await Promise.all([
      fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx),
      fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps same-URL JSON GETs separate when headers differ", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/reserves",
      respond: (request) => jsonResponse({ origin: request.headers.get("origin") }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    const first = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: { Origin: "https://app-a.example" } },
    );
    const second = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: { Origin: "https://app-b.example" } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("keeps same-URL JSON GETs separate when Headers instances differ", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/reserves",
      respond: (request) => jsonResponse({ origin: request.headers.get("origin") }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    const first = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: new Headers({ Origin: "https://app-a.example" }) },
    );
    const second = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: new Headers({ Origin: "https://app-b.example" }) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("does not share JSON and text reads for the same URL", async () => {
    const fetchMock = mockFetchStrict([
      { match: "https://issuer.example/reserves", body: { ok: true } },
    ]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    await fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx);
    const text = await fetchTextWithRetry("https://issuer.example/reserves", signal, 1_000, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text).toBe(JSON.stringify({ ok: true }));
  });

  it("keeps same-URL text GETs separate when headers differ", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/reserves",
      respond: (request) => new Response(request.headers.get("referer") ?? "none", {
        headers: { "content-type": "text/plain" },
      }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    const first = await fetchTextWithRetry(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: { Referer: "https://issuer.example/a" } },
    );
    const second = await fetchTextWithRetry(
      "https://issuer.example/reserves",
      signal,
      1_000,
      ctx,
      { headers: { Referer: "https://issuer.example/b" } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toBe("https://issuer.example/a");
    expect(second).toBe("https://issuer.example/b");
  });

  it("dedupes entry-array text headers after deterministic normalization", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/reserves",
      respond: (request) => new Response(`${request.headers.get("origin")}:${request.headers.get("referer")}`, {
        headers: { "content-type": "text/plain" },
      }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    const firstHeaders: [string, string][] = [
      ["Origin", "https://issuer.example"],
      ["Referer", "https://issuer.example/reserves"],
    ];
    const sameHeadersDifferentOrder: [string, string][] = [
      ["referer", "https://issuer.example/reserves"],
      ["origin", "https://issuer.example"],
    ];

    const [first, second] = await Promise.all([
      fetchTextWithRetry("https://issuer.example/reserves", signal, 1_000, ctx, { headers: firstHeaders }),
      fetchTextWithRetry("https://issuer.example/reserves", signal, 1_000, ctx, {
        headers: sameHeadersDifferentOrder,
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe("https://issuer.example:https://issuer.example/reserves");
    expect(second).toBe(first);
  });

  it("keys JSON POST cache entries by serialized body", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/graphql",
      respond: async (request) => jsonResponse({ body: await request.clone().text() }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx);
    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx);
    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "eurc" }, signal, 1_000, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps JSON POST cache entries separate when Headers instances differ", async () => {
    const fetchMock = mockFetchStrict([{
      match: "https://issuer.example/graphql",
      respond: (request) => jsonResponse({ origin: request.headers.get("origin") }),
    }]);

    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;

    const first = await fetchJsonPostWithRetry<{ origin: string }>(
      "https://issuer.example/graphql",
      { coin: "usdc" },
      signal,
      1_000,
      ctx,
      { headers: new Headers({ Origin: "https://app-a.example" }) },
    );
    const second = await fetchJsonPostWithRetry<{ origin: string }>(
      "https://issuer.example/graphql",
      { coin: "usdc" },
      signal,
      1_000,
      ctx,
      { headers: new Headers({ Origin: "https://app-b.example" }) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("fetches the primary JSON input from a live-reserve config", async () => {
    const fetchMock = mockFetchStrict([
      { match: "https://issuer.example/reserves", body: { reserves: "ok" } },
    ]);

    const config = {
      adapter: "ethena",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "http-json", url: "https://issuer.example/reserves" },
      },
    } as LiveReservesConfig;
    const signal = new AbortController().signal;
    const payload = await fetchJsonAdapterInput<{ reserves: string }>(config, "ethena", signal, 1_000);

    expect(payload).toEqual({ reserves: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels binary error bodies and reports only the host and status", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private error details"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(responseBody, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reason = await fetchBinaryResponseWithRetry(
      "https://issuer.example/private/report.pdf?token=secret",
      new AbortController().signal,
      1_000,
      undefined,
      { maxRetries: 0 },
    ).then(() => null, (err: unknown) => err);
    const error = reason instanceof Error ? reason : new Error("expected an Error rejection");

    expect(error.message).toBe("HTTP 503 for issuer.example");
    expect(error.message).not.toContain("/private/report.pdf");
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
