import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUpstreamProxy,
  MAX_PROXY_RESPONSE_BODY_BYTES,
  resolveWildcardProxyPath,
} from "../lib/upstream-proxy";

const PROXY_OPTIONS = {
  upstreamUrl: "https://upstream.example.test/api/resource",
  method: "POST",
  headers: new Headers({ "X-Proxy-Test": "yes" }),
  body: "request-body",
  timeoutReason: new DOMException("proxy timed out", "TimeoutError"),
  logPrefix: "test-proxy",
  timeoutMessage: "upstream timed out",
  fetchFailedMessage: "upstream fetch failed",
};

describe("resolveWildcardProxyPath", () => {
  it("returns null when the wildcard path is absent", () => {
    expect(resolveWildcardProxyPath(undefined, "/api/")).toBeNull();
    expect(resolveWildcardProxyPath([], "/api/")).toBeNull();
  });
});

describe("fetchUpstreamProxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("buffers the response while preserving its status, status text, and headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("response-body", {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": "text/plain",
        "X-Upstream-Trace": "trace-123",
      },
    }));

    const result = await fetchUpstreamProxy(
      new Request("https://pharos.watch/proxy"),
      PROXY_OPTIONS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(206);
    expect(result.response.statusText).toBe("Partial Content");
    expect(result.response.headers.get("X-Upstream-Trace")).toBe("trace-123");
    await expect(result.response.text()).resolves.toBe("response-body");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(PROXY_OPTIONS.upstreamUrl);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toBe(PROXY_OPTIONS.headers);
    expect(init?.body).toBe("request-body");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes an upstream fetch error to a 502 response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    const result = await fetchUpstreamProxy(
      new Request("https://pharos.watch/proxy"),
      PROXY_OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    await expect(result.response.json()).resolves.toEqual({ error: "upstream fetch failed" });
    expect(warnSpy).toHaveBeenCalledWith("[test-proxy] upstream fetch failed (TypeError): network down");
  });

  it("rejects an unsafe declared length before reading the response body", async () => {
    let cancelReason: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      },
    }), {
      headers: { "Content-Length": "9007199254740992" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await fetchUpstreamProxy(
      new Request("https://pharos.watch/proxy"),
      PROXY_OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    expect(cancelReason).toMatchObject({ name: "ProxyResponseTooLargeError" });
  });

  it("cancels and normalizes a streamed response that crosses the byte cap", async () => {
    let cancelReason: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROXY_RESPONSE_BODY_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await fetchUpstreamProxy(
      new Request("https://pharos.watch/proxy"),
      PROXY_OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    expect(cancelReason).toMatchObject({
      name: "ProxyResponseTooLargeError",
      message: `Upstream response exceeded ${MAX_PROXY_RESPONSE_BODY_BYTES} bytes`,
    });
  });

  it("propagates a caller abort to a pending upstream body read", async () => {
    let resolveReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let cancelReason: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull() {
        resolveReadStarted?.();
        return new Promise<void>(() => undefined);
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const requestController = new AbortController();
    const request = new Request("https://pharos.watch/proxy", { signal: requestController.signal });
    const resultPromise = fetchUpstreamProxy(request, PROXY_OPTIONS);
    const abortReason = new DOMException("client disconnected", "AbortError");

    await readStarted;
    requestController.abort(abortReason);

    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    expect(cancelReason).toBe(abortReason);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.reason).toBe(abortReason);
  });
});
