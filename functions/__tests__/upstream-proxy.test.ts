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

  it.each([
    ["resource", "/api/resource"],
    [["coins", "usd"], "/api/coins/usd"],
    ["", null],
  ])("resolves wildcard %j", (path, expected) => {
    expect(resolveWildcardProxyPath(path, "/api/")).toBe(expected);
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
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ "x-proxy-test": "yes" });
    expect(init?.body).toBe("request-body");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes an upstream fetch error to a 502 response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    const result = await fetchUpstreamProxy(
      new Request("https://pharos.watch/proxy"),
      PROXY_OPTIONS,
    );

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    await expect(result.response.json()).resolves.toEqual({ error: "upstream fetch failed" });
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
    });
  });

  it.each(["fetch", "body"] as const)("classifies the deadline during %s without firing early", async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cancel = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      if (phase === "body") {
        return Promise.resolve(new Response(new ReadableStream({ cancel })));
      }
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    });
    let settled = false;
    const pending = fetchUpstreamProxy(new Request("https://pharos.watch/proxy"), {
      ...PROXY_OPTIONS,
      timeoutMs: 100,
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(result.response.status).toBe(504);
    await expect(result.response.json()).resolves.toEqual({ error: "upstream timed out" });
    if (phase === "body") expect(cancel).toHaveBeenCalledWith(PROXY_OPTIONS.timeoutReason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a closed stream exactly at the byte cap", async () => {
    const bytes = new Uint8Array(MAX_PROXY_RESPONSE_BODY_BYTES);
    bytes[0] = 17;
    bytes[bytes.length - 1] = 29;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    })));
    const result = await fetchUpstreamProxy(new Request("https://pharos.watch/proxy"), PROXY_OPTIONS);
    expect(result.ok).toBe(true);
    const buffered = await result.response.arrayBuffer();
    expect(buffered.byteLength).toBe(MAX_PROXY_RESPONSE_BODY_BYTES);
    expect(Buffer.from(buffered).equals(Buffer.from(bytes.buffer))).toBe(true);
  });

  it("rejects a safe declared cap-plus-one without pulling content", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      pull,
      cancel,
    }, { highWaterMark: 0 }), {
      headers: { "Content-Length": String(MAX_PROXY_RESPONSE_BODY_BYTES + 1) },
    }));
    const result = await fetchUpstreamProxy(new Request("https://pharos.watch/proxy"), PROXY_OPTIONS);
    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    expect(result.response.status).toBe(502);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ name: "ProxyResponseTooLargeError" }));
  });

  it("preserves a bodyless 204 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const result = await fetchUpstreamProxy(new Request("https://pharos.watch/proxy"), PROXY_OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.response.status).toBe(204);
    expect(result.response.body).toBeNull();
  });

  it("propagates a caller abort to a pending upstream body read", async () => {
    vi.useFakeTimers();
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
    const resultPromise = fetchUpstreamProxy(request, { ...PROXY_OPTIONS, timeoutMs: 100 });
    const abortReason = new DOMException("client disconnected", "AbortError");

    await readStarted;
    await vi.advanceTimersByTimeAsync(99);
    requestController.abort(abortReason);

    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, errorKind: "fetch-error" });
    if (result.ok) return;
    expect(result.response.status).toBe(502);
    expect(cancelReason).toBe(abortReason);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.reason).toBe(abortReason);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
