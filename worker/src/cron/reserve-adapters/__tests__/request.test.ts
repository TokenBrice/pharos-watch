import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import { createAdapterIoLimiter } from "../concurrency";
import {
  ADAPTER_USER_AGENT,
  buildBrowserHeaders,
  createRequestBodyObserver,
  fetchJsonAdapterInput,
  fetchJsonPostWithRetry,
  fetchJsonWithRetry,
  fetchBinaryResponseWithRetry,
  fetchWithBrowserFallback,
  fetchTextWithRetry,
  getCachedRequest,
  getRequestResourceSnapshot,
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

  it("tries browser headers first and only falls back to neutral headers after failure", async () => {
    const signal = new AbortController().signal;
    const calls: HeadersInit[] = [];
    const result = await fetchWithBrowserFallback(
      "https://app.example.com",
      "https://app.example.com/reserves",
      async (headers) => {
        calls.push(headers);
        if (calls.length === 1) throw new Error("browser blocked");
        return "ok";
      },
      signal,
    );

    expect(result).toBe("ok");
    expect(new Headers(calls[0]).get("origin")).toBe("https://app.example.com");
    expect(new Headers(calls[1]).get("origin")).toBeNull();
  });

  it("preserves both failure reasons when browser and neutral identities fail", async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    await expect(fetchWithBrowserFallback(
      "https://app.example.com",
      "https://app.example.com/reserves",
      async () => {
        calls++;
        throw new Error(calls === 1 ? "browser blocked" : "neutral blocked");
      },
      signal,
    )).rejects.toThrow("browser fetch failed: browser blocked; neutral fetch failed: neutral blocked");
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
      return { value: "ok", cacheBytes: 2, basis: "declared-estimate" };
    }, ctx);

    expect(recovered).toBe("ok");
    expect(calls).toBe(2);
  });

  it("evicts least-recently-used successful bodies within the byte budget", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const ctx = { requestCache: cache };
    const body = "x".repeat(REQUEST_CACHE_MAX_ENTRY_BYTES);

    for (const key of ["first", "second", "third", "fourth"]) {
      await getCachedRequest(key, async () => ({ value: body, cacheBytes: body.length, basis: "declared-estimate" }), ctx);
    }
    await getCachedRequest("first", async () => ({ value: "unused", cacheBytes: 6, basis: "declared-estimate" }), ctx);
    await getCachedRequest("fifth", async () => ({ value: body, cacheBytes: body.length, basis: "declared-estimate" }), ctx);

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

    await expect(getCachedRequest("oversized", async () => ({ value: body, cacheBytes: body.length, basis: "declared-estimate" }), ctx)).resolves.toBe(body);
    expect(cache.has("oversized")).toBe(false);
  });

  it("dedupes pending work without retaining it and cleans failed promises", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const onRequestCache = vi.fn();
    const ctx = { requestCache: cache, onRequestCache };
    let resolve!: (value: { value: string; cacheBytes: null; basis: "unavailable" }) => void;
    const factory = vi.fn(() => new Promise<{ value: string; cacheBytes: null; basis: "unavailable" }>((done) => { resolve = done; }));
    const first = getCachedRequest("pending", factory, ctx);
    const second = getCachedRequest("pending", factory, ctx);
    expect(first).toBe(second);
    expect(cache.size).toBe(0);
    await Promise.resolve();
    resolve({ value: "ok", cacheBytes: null, basis: "unavailable" });
    await expect(first).resolves.toBe("ok");
    expect(factory).toHaveBeenCalledOnce();
    expect(onRequestCache.mock.calls.map(([event]) => event.hit)).toEqual([false, true]);
    expect(getRequestResourceSnapshot(ctx, "settled")).toMatchObject({ cacheBytes: 0, guard: "cache-bypassed" });
  });

  it("never serializes returned values or invokes getters to account retention", async () => {
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const getter = vi.fn(() => { throw new Error("must not inspect"); });
    const value = Object.defineProperty({}, "toJSON", { get: getter });
    await expect(getCachedRequest("opaque", async () => ({
      value, cacheBytes: 100, basis: "declared-estimate",
    }), ctx)).resolves.toBe(value);
    expect(getter).not.toHaveBeenCalled();
    expect(getRequestResourceSnapshot(ctx, "retained")).toMatchObject({ cacheBytes: 100, cacheBasis: "declared-estimate" });
  });

  it("never exceeds the prospective total at Map insertion", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const ctx = { requestCache: cache };
    const insert = vi.spyOn(cache, "set");
    for (let index = 0; index < 6; index++) {
      await getCachedRequest(String(index), async () => ({
        value: index, cacheBytes: REQUEST_CACHE_MAX_ENTRY_BYTES, basis: "declared-estimate",
      }), ctx);
      expect(cache.size).toBeLessThanOrEqual(4);
      expect(getRequestResourceSnapshot(ctx, "admitted").cacheBytes).toBeLessThanOrEqual(REQUEST_CACHE_MAX_TOTAL_BYTES);
    }
    expect(insert).toHaveBeenCalledTimes(6);
  });

  it.each([null, -1, Infinity, 0.5])("bypasses unknown or invalid estimates %s without failing work", async (cacheBytes) => {
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    await expect(getCachedRequest("uncached", async () => ({
      value: "ok", cacheBytes, basis: "declared-estimate",
    }), ctx)).resolves.toBe("ok");
    expect(ctx.requestCache.size).toBe(0);
    expect(getRequestResourceSnapshot(ctx, "done").guard).toBe("cache-bypassed");
  });
});

describe("adapter request cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dedupes identical JSON GETs within an adapter context", async () => {
    const network = installAdapterNetwork({ json: { "https://issuer.example/reserves": { ok: true } } });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    await Promise.all([
      fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx),
      fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx),
    ]);
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps same-URL JSON GETs separate when headers differ", async () => {
    const network = installAdapterNetwork({
      json: { "https://issuer.example/reserves": (request: Request) => ({ json: { origin: request.headers.get("origin") } }) },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const first = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves", signal, 1_000, ctx, { headers: { Origin: "https://app-a.example" } },
    );
    const second = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves", signal, 1_000, ctx, { headers: { Origin: "https://app-b.example" } },
    );
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("keeps same-URL JSON GETs separate when Headers instances differ", async () => {
    const network = installAdapterNetwork({
      json: { "https://issuer.example/reserves": (request: Request) => ({ json: { origin: request.headers.get("origin") } }) },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const first = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves", signal, 1_000, ctx,
      { headers: new Headers({ Origin: "https://app-a.example" }) },
    );
    const second = await fetchJsonWithRetry<{ origin: string }>(
      "https://issuer.example/reserves", signal, 1_000, ctx,
      { headers: new Headers({ Origin: "https://app-b.example" }) },
    );
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("does not share JSON and text reads for the same URL", async () => {
    const network = installAdapterNetwork({ json: { "https://issuer.example/reserves": { ok: true } } });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    await fetchJsonWithRetry("https://issuer.example/reserves", signal, 1_000, ctx);
    const text = await fetchTextWithRetry("https://issuer.example/reserves", signal, 1_000, ctx);
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
    expect(text).toBe(JSON.stringify({ ok: true }));
  });

  it("keeps same-URL text GETs separate when headers differ", async () => {
    const network = installAdapterNetwork({
      html: { "https://issuer.example/reserves": (request) => request.headers.get("referer") ?? "none" },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const first = await fetchTextWithRetry(
      "https://issuer.example/reserves", signal, 1_000, ctx,
      { headers: { Referer: "https://issuer.example/a" } },
    );
    const second = await fetchTextWithRetry(
      "https://issuer.example/reserves", signal, 1_000, ctx,
      { headers: { Referer: "https://issuer.example/b" } },
    );
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
    expect(first).toBe("https://issuer.example/a");
    expect(second).toBe("https://issuer.example/b");
  });

  it("dedupes entry-array text headers after deterministic normalization", async () => {
    const network = installAdapterNetwork({
      html: {
        "https://issuer.example/reserves": (request) =>
          `${request.headers.get("origin")}:${request.headers.get("referer")}`,
      },
    });
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
      fetchTextWithRetry("https://issuer.example/reserves", signal, 1_000, ctx, { headers: sameHeadersDifferentOrder }),
    ]);
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toBe("https://issuer.example:https://issuer.example/reserves");
    expect(second).toBe(first);
  });

  it("keys JSON POST cache entries by serialized body", async () => {
    const network = installAdapterNetwork({
      json: {
        "https://issuer.example/graphql": async (request: Request) => ({ json: { body: await request.clone().text() } }),
      },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx);
    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx);
    await fetchJsonPostWithRetry("https://issuer.example/graphql", { coin: "eurc" }, signal, 1_000, ctx);
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps JSON POST cache entries separate when Headers instances differ", async () => {
    const network = installAdapterNetwork({
      json: { "https://issuer.example/graphql": (request: Request) => ({ json: { origin: request.headers.get("origin") } }) },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const first = await fetchJsonPostWithRetry<{ origin: string }>(
      "https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx,
      { headers: new Headers({ Origin: "https://app-a.example" }) },
    );
    const second = await fetchJsonPostWithRetry<{ origin: string }>(
      "https://issuer.example/graphql", { coin: "usdc" }, signal, 1_000, ctx,
      { headers: new Headers({ Origin: "https://app-b.example" }) },
    );
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.origin).toBe("https://app-a.example");
    expect(second.origin).toBe("https://app-b.example");
  });

  it("fetches the primary JSON input from a live-reserve config", async () => {
    const network = installAdapterNetwork({ json: { "https://issuer.example/reserves": { reserves: "ok" } } });
    const config = {
      adapter: "ethena",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url: "https://issuer.example/reserves" } },
    } as LiveReservesConfig;
    const payload = await fetchJsonAdapterInput<{ reserves: string }>(
      config, "ethena", new AbortController().signal, 1_000,
    );
    expect(payload).toEqual({ reserves: "ok" });
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports the final URL and status when a JSON endpoint redirects to HTML without leaking URL credentials", async () => {
    const response = new Response("<!DOCTYPE html><title>Issuer homepage</title>", {
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(response, "url", { value: "https://issuer.example/?token=redirect-secret" });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const error = await fetchJsonWithRetry(
      "https://app.issuer.example/reserves?key=request-secret", new AbortController().signal,
    ).catch((error: Error) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 200, text/html; final URL https://issuer.example/?token=[redacted]");
    expect((error as Error).message).toContain("body starts with: <!DOCTYPE html>");
    expect((error as Error).message).not.toContain("redirect-secret");
    expect((error as Error).message).not.toContain("request-secret");
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
      new AbortController().signal, 1_000, undefined, { maxRetries: 0 },
    ).then(() => null, (err: unknown) => err);
    const error = reason instanceof Error ? reason : new Error("expected an Error rejection");
    expect(error.message).toBe("HTTP 503 for issuer.example");
    expect(error.message).not.toContain("/private/report.pdf");
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe.each(["GET", "POST"] as const)("JSON %s transport identity", (method) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const url = "https://issuer.example/reserves";
  const request = (
    ctx: Parameters<typeof fetchJsonWithRetry>[3],
    options?: Parameters<typeof fetchJsonWithRetry>[4],
    timeoutMs = 1_000,
  ) => {
    const signal = new AbortController().signal;
    return method === "GET"
      ? fetchJsonWithRetry(url, signal, timeoutMs, ctx, options)
      : fetchJsonPostWithRetry(url, { coin: "usdc" }, signal, timeoutMs, ctx, options);
  };

  it("isolates redirect policies for pending and retained responses", async () => {
    const network = installAdapterNetwork({
      json: { [url]: (received: Request) => ({ json: { redirect: received.redirect } }) },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const policies = ["follow", "error", "manual"] as const;
    const results = await Promise.all(policies.map((redirect) => request(ctx, { redirect })));
    expect(results).toEqual(policies.map((redirect) => ({ redirect })));
    for (const redirect of policies) {
      await expect(request(ctx, { redirect })).resolves.toEqual({ redirect });
    }
    await expect(request(ctx)).resolves.toEqual({ redirect: "follow" });
    expect(network.fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("replaces default headers with lower-case overrides rather than appending them", async () => {
    const name = method === "GET" ? "accept" : "content-type";
    const network = installAdapterNetwork({
      json: { [url]: (received: Request) => ({ json: {
        profile: received.headers.get(name),
        agent: received.headers.get("user-agent"),
      } }) },
    });
    await expect(request(undefined, { headers: {
      [name]: "application/vnd.issuer+json",
      "user-agent": "issuer-probe",
    } })).resolves.toEqual({ profile: "application/vnd.issuer+json", agent: "issuer-probe" });
    expect(network.fetchSpy).toHaveBeenCalledOnce();
  });

  it("dedupes equivalent reordered/cased records, Headers and entry arrays", async () => {
    const network = installAdapterNetwork({ json: { [url]: { ok: true } } });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const variants: HeadersInit[] = [
      { Authorization: "Bearer shared", Origin: "https://issuer.example" },
      { origin: "https://issuer.example", authorization: "Bearer shared" },
      new Headers({ ORIGIN: "https://issuer.example", AUTHORIZATION: "Bearer shared" }),
      [["origin", "https://issuer.example"], ["Authorization", "Bearer shared"]],
    ];
    const results = await Promise.all(variants.map((headers) => request(ctx, { headers })));
    expect(results).toEqual(variants.map(() => ({ ok: true })));
    await request(ctx, { headers: variants[1] });
    expect(network.fetchSpy).toHaveBeenCalledOnce();
  });

  it("shares implicit and explicit effective default profiles", async () => {
    const network = installAdapterNetwork({ json: { [url]: { ok: true } } });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const name = method === "GET" ? "accept" : "content-type";
    const options = { headers: { [name]: "application/json", "user-agent": ADAPTER_USER_AGENT }, redirect: "follow" as const };
    expect(await Promise.all([request(ctx), request(ctx, options)])).toEqual([{ ok: true }, { ok: true }]);
    await request(ctx, { headers: new Headers(options.headers) });
    expect(network.fetchSpy).toHaveBeenCalledOnce();
  });

  it("never shares different authorization credentials", async () => {
    const network = installAdapterNetwork({
      json: { [url]: (received: Request) => ({ json: { auth: received.headers.get("authorization") } }) },
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const [first, second] = await Promise.all([
      request(ctx, { headers: { Authorization: "Bearer first" } }),
      request(ctx, { headers: { authorization: "Bearer second" } }),
    ]);
    expect(first).toEqual({ auth: "Bearer first" });
    expect(second).toEqual({ auth: "Bearer second" });
    await expect(request(ctx, { headers: { AUTHORIZATION: "Bearer first" } })).resolves.toEqual(first);
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives each observer its own actual response despite a retained matching result", async () => {
    const responses: Response[] = [];
    const fetchMock = vi.fn(async () => {
      const response = Response.json({ request: responses.length });
      responses.push(response);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    await expect(request(ctx)).resolves.toEqual({ request: 0 });
    const first = vi.fn();
    const second = vi.fn();
    const results = await Promise.all([
      request(ctx, { onResponse: first }),
      request(ctx, { onResponse: second }),
    ]);
    expect(results).toEqual([{ request: 1 }, { request: 2 }]);
    expect(first.mock.calls).toEqual([[responses[1]]]);
    expect(second.mock.calls).toEqual([[responses[2]]]);
    expect(first.mock.calls[0][0]).toBe(responses[1]);
    expect(second.mock.calls[0][0]).toBe(responses[2]);
    expect(responses[1]).not.toBe(responses[2]);
    await expect(request(ctx, { onResponse: first })).resolves.toEqual({ request: 3 });
    expect(first.mock.calls[1][0]).toBe(responses[3]);
    const beforeHit = getRequestResourceSnapshot(ctx, "before-hit");
    await expect(request(ctx)).resolves.toEqual({ request: 0 });
    expect(getRequestResourceSnapshot(ctx, "after-hit").intakeBytes).toBe(beforeHit.intakeBytes);
    expect(ctx.requestCache.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not populate the cache with observer-only requests", async () => {
    const network = installAdapterNetwork({ json: { [url]: { ok: true } } });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const onResponse = vi.fn();
    await Promise.all([request(ctx, { onResponse }), request(ctx, { onResponse })]);
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(ctx.requestCache.size).toBe(0);
    await request(ctx);
    await request(ctx);
    expect(network.fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("observes each retry response without replaying it to another caller", async () => {
    const responses = [
      new Response("down", { status: 500 }),
      Response.json({ ok: true }),
      Response.json({ ok: true }),
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(responses[2]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const first = vi.fn();
    const second = vi.fn();
    await request(ctx, { maxRetries: 1, onResponse: first });
    await request(ctx, { maxRetries: 1, onResponse: second });
    expect(first.mock.calls).toEqual([[responses[0]], [responses[1]]]);
    expect(second.mock.calls).toEqual([[responses[2]]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps observer requests inside the two-I/O limit until their bodies finish", async () => {
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodies.push(controller); },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = { requestCache: new Map<string, Promise<unknown>>(), ioLimiter: createAdapterIoLimiter() };
    const onResponse = vi.fn();
    const requests = Array.from({ length: 3 }, () => request(ctx, { onResponse }));
    // Fetch is started synchronously in the first two claimed limiter slots.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const complete = (index: number) => {
      bodies[index].enqueue(new TextEncoder().encode('{"ok":true}'));
      bodies[index].close();
    };
    complete(0);
    await requests[0];
    expect(fetchMock).toHaveBeenCalledTimes(3);
    complete(1);
    complete(2);
    await Promise.all(requests);
    expect(onResponse).toHaveBeenCalledTimes(3);
    expect(ctx.requestCache.size).toBe(0);
  });

  it("still cancels an oversized observed body instead of admitting a result", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":"oversized"}')); },
      cancel,
    }));
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onResponse = vi.fn();
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    await expect(request(ctx, { onResponse, maxRetries: 0, maxResponseBytes: 8 }))
      .rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(onResponse.mock.calls[0][0]).toBe(response);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.requestCache.size).toBe(0);
    expect(getRequestResourceSnapshot(ctx, "oversized").rejectedBodies).toBe(1);
  });

  it("still applies the attempt deadline through observed body consumption", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      async pull() { await new Promise<never>(() => {}); },
      cancel,
    }));
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onResponse = vi.fn();
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    await expect(request(ctx, { onResponse, maxRetries: 0 }, 50))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(onResponse.mock.calls[0][0]).toBe(response);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.requestCache.size).toBe(0);
    expect(getRequestResourceSnapshot(ctx, "timed-out").rejectedBodies).toBe(0);
  });
});

describe("binary fetch lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bounds binary body reads with the attempt timeout", async () => {
    let cancelled = false;
    const slowBody = new ReadableStream<Uint8Array>({
      async pull() {
        await new Promise<never>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(slowBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const startedAt = Date.now();
    await expect(fetchBinaryResponseWithRetry(
      "https://issuer.example/report.pdf", new AbortController().signal, 50, undefined, { maxRetries: 0 },
    )).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels binary bodies whose declared length exceeds the limit", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("small"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(responseBody, {
      status: 200, headers: { "content-length": "1048576" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchBinaryResponseWithRetry(
      "https://issuer.example/report.pdf", new AbortController().signal, 1_000, undefined,
      { maxRetries: 0, maxResponseBytes: 1024 },
    )).rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels binary bodies that overflow the limit mid-stream", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("overflowing bytes"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(responseBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fetchBinaryResponseWithRetry(
      "https://issuer.example/report.pdf", new AbortController().signal, 1_000, undefined,
      { maxRetries: 0, maxResponseBytes: 8 },
    )).rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("JSON POST retry and size limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("enforces maxResponseBytes on JSON POST responses", async () => {
    const network = installAdapterNetwork({
      json: { "https://issuer.example/graphql": { ok: true, note: "x".repeat(256) } },
    });
    await expect(fetchJsonPostWithRetry(
      "https://issuer.example/graphql", { coin: "usdc" }, new AbortController().signal, 1_000, undefined,
      { maxRetries: 0, maxResponseBytes: 64 },
    )).rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("honours maxRetries on JSON POST requests", async () => {
    const network = installAdapterNetwork({
      json: { "https://issuer.example/graphql": { status: 500, body: "down" } },
    });
    await expect(fetchJsonPostWithRetry(
      "https://issuer.example/graphql", { coin: "usdc" }, new AbortController().signal, 1_000, undefined,
      { maxRetries: 1 },
    )).rejects.toThrow("HTTP 500 for POST https://issuer.example/graphql");
    expect(network.fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("body intake attribution", () => {
  it("counts partial interruption without inventing a budget rejection", () => {
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const observer = createRequestBodyObserver(ctx, 4);
    observer.onBodyRead({ intakeBytes: 2, declaredBytes: null, outcome: "rejected" });
    expect(getRequestResourceSnapshot(ctx, "abort")).toMatchObject({
      intakeBytes: 2, rejectedBodies: 0, guard: "within-policy",
    });
    observer.onBodyRead({ intakeBytes: 5, declaredBytes: 1, outcome: "rejected" });
    expect(getRequestResourceSnapshot(ctx, "overflow")).toMatchObject({
      intakeBytes: 7, rejectedBodies: 1, guard: "resource-budget-exceeded",
    });
  });
});
