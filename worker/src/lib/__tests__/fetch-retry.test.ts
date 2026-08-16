import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

const {
  sleepWithSignalMock,
  throwIfAbortedMock,
} = vi.hoisted(() => ({
  sleepWithSignalMock: vi.fn(async () => undefined),
  throwIfAbortedMock: vi.fn(),
}));

vi.mock("../abort", () => ({
  sleepWithSignal: sleepWithSignalMock,
  throwIfAborted: throwIfAbortedMock,
  // Real behavior: `response-body` reads it through this module, and the
  // per-attempt timeout assertions below depend on the actual abort reason.
  abortReason: (signal: AbortSignal, fallback: () => unknown) => signal.reason ?? fallback(),
}));

import {
  DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
  fetchJsonWithRetry,
  fetchTextWithRetry,
  fetchWithRetry,
} from "../fetch-retry";

function neverEndingResponse(prefix = ""): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) {
        controller.enqueue(encoder.encode(prefix));
      }
    },
  }));
}

function streamedResponse(
  chunks: Uint8Array[],
  headers?: HeadersInit,
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  let index = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), cancel };
}

const encode = (value: string) => new TextEncoder().encode(value);

function warnRecords(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap((call: unknown[]) => {
    try {
      return [JSON.parse(String(call[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    sleepWithSignalMock.mockClear();
    throwIfAbortedMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the shared consumed-body default at 16 MiB", () => {
    expect(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
  });

  it("passes through configured non-ok statuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry(
      "https://example.com/token",
      undefined,
      1,
      { passthroughStatuses: [404, 422] },
    );

    expect(res?.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepWithSignalMock).not.toHaveBeenCalled();
  });

  it("retains passthrough404 compatibility", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry(
      "https://example.com/token",
      undefined,
      1,
      { passthrough404: true },
    );

    expect(res?.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns and consumes the first HTTP response in network-only retry mode", async () => {
    const first = new Response("upstream down", { status: 503 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response("should not be requested", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTextWithRetry(
      "https://example.com/provider",
      undefined,
      2,
      { retryMode: "network-only", returnFinalResponse: true },
    );

    expect(result).toMatchObject({ response: first, body: "upstream down" });
    expect(first.bodyUsed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepWithSignalMock).not.toHaveBeenCalled();
  });

  it("retries thrown transport failures and can preserve the final error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(fetchTextWithRetry(
        "https://example.com/provider",
        undefined,
        1,
        { retryMode: "network-only", throwOnFinalNetworkError: true },
      )).rejects.toThrow("network unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries 429 responses before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.com/token", undefined, 1);

    expect(res?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepWithSignalMock).toHaveBeenCalledWith(1000, undefined);
  });

  it("handles a Response-like 429 without headers", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, body: { cancel } })
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.com/token", undefined, 1);

    expect(res?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(sleepWithSignalMock).toHaveBeenCalledWith(5000, undefined);
  });

  it("caps provider-controlled retry delays when configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry(
      "https://example.com/token",
      undefined,
      1,
      { maxRetryDelayMs: 5000 },
    );

    expect(res?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepWithSignalMock).toHaveBeenCalledWith(5000, undefined);
  });

  it("waits on Retry-After before returning passthrough 429 responses", async () => {
    const rateLimitedResponse = new Response(JSON.stringify({ error: "slow down" }), {
      status: 429,
      headers: { "Retry-After": "2" },
    });
    sleepWithSignalMock.mockImplementationOnce(async () => {
      expect(rateLimitedResponse.bodyUsed).toBe(true);
    });
    const fetchMock = vi.fn().mockResolvedValue(rateLimitedResponse);
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry(
      "https://example.com/token",
      undefined,
      0,
      { passthroughStatuses: [429] },
    );

    expect(res).not.toBe(rateLimitedResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepWithSignalMock).toHaveBeenCalledWith(2000, undefined);
    await expect(res?.json()).resolves.toEqual({ error: "slow down" });
  });

  it("uses an explicit safe URL in retry logs without changing the fetched URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 520 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry(
      "https://example.com/secret-token/resource",
      undefined,
      0,
      { logUrl: "https://example.com/<redacted>/resource" },
    );

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/secret-token/resource", expect.any(Object));
    expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
      event: "fetch_retry_http_error",
      status: 520,
      metadata: expect.objectContaining({ url: "[url]" }),
    }));
    expect(warnSpy.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("secret-token");
    warnSpy.mockRestore();
  });

  it("redacts known provider URLs in retry logs by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 520 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry(
      "https://eth-mainnet.g.alchemy.com/v2/real-secret-key",
      undefined,
      0,
    );

    expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
      event: "fetch_retry_http_error",
      metadata: expect.objectContaining({ url: "[url]" }),
    }));
    expect(warnSpy.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("real-secret-key");
    warnSpy.mockRestore();
  });

  it("backs off on 529 overload responses before succeeding", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "overloaded" }), { status: 529 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "still overloaded" }), { status: 529 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await fetchWithRetry("https://example.com/token", undefined, 2);

      expect(res?.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleepWithSignalMock).toHaveBeenNthCalledWith(1, 5000, undefined);
      expect(sleepWithSignalMock).toHaveBeenNthCalledWith(2, 10000, undefined);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("jitters generic retry sleeps", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const fetchSpy = mockFetch([{
        match: "https://example.com/token",
        outcomes: [
          { body: "service unavailable", status: 503 },
          new TypeError("network reset"),
          { body: { ok: true } },
        ],
      }], { requireMatch: true });

      const res = await fetchWithRetry("https://example.com/token", undefined, 2);

      expect(res?.ok).toBe(true);
      expect(fetchSpy.getHistory()).toEqual([
        { url: "https://example.com/token", method: "GET", headers: {}, body: null },
        { url: "https://example.com/token", method: "GET", headers: {}, body: null },
        { url: "https://example.com/token", method: "GET", headers: {}, body: null },
      ]);
      expect(sleepWithSignalMock).toHaveBeenNthCalledWith(1, 500, undefined);
      expect(sleepWithSignalMock).toHaveBeenNthCalledWith(2, 1000, undefined);
      expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("keeps the per-attempt timeout active while reading JSON bodies", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fetchMock = vi.fn().mockResolvedValue(neverEndingResponse("{"));
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = fetchJsonWithRetry(
        "https://example.com/slow.json",
        undefined,
        0,
        { timeoutMs: 5 },
      );

      const expectation = expect(resultPromise).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(5);
      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
        event: "fetch_retry_attempt_failed",
        errorName: "TimeoutError",
      }));
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the per-attempt timeout active while reading text bodies", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fetchMock = vi.fn().mockResolvedValue(neverEndingResponse("partial"));
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = fetchTextWithRetry(
        "https://example.com/slow.txt",
        undefined,
        0,
        { timeoutMs: 5 },
      );

      const expectation = expect(resultPromise).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(5);
      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
        event: "fetch_retry_attempt_failed",
        errorName: "TimeoutError",
      }));
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves raw response behavior when a body exceeds the configured wrapper limit", async () => {
    const response = new Response("raw response", { headers: { "Content-Length": "12" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await fetchWithRetry(
      "https://example.com/raw",
      undefined,
      0,
      { maxResponseBytes: -1 },
    );

    expect(result).toBe(response);
    await expect(result?.text()).resolves.toBe("raw response");
  });

  it.each([
    ["JSON", fetchJsonWithRetry],
    ["text", fetchTextWithRetry],
  ])("retries and rejects declared %s bodies above the configured limit", async (_label, fetchBody) => {
    const attempts: Array<ReturnType<typeof streamedResponse>> = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      const attempt = streamedResponse([encode("{}")], { "Content-Length": "6" });
      attempts.push(attempt);
      return Promise.resolve(attempt.response);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await fetchBody(
        "https://example.com/declared-overflow",
        undefined,
        1,
        { maxResponseBytes: 5 },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(attempts.every((attempt) => attempt.cancel.mock.calls.length === 1)).toBe(true);
      expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
        event: "fetch_retry_attempt_failed",
        errorName: "ResponseBodyTooLargeError",
        metadata: expect.objectContaining({ maxBytes: 5, observedBytes: 6 }),
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries and rejects a chunked JSON body instead of parsing a partial payload", async () => {
    const attempts: Array<ReturnType<typeof streamedResponse>> = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      const attempt = streamedResponse([encode('{"ok":"'), encode("overflow"), encode('"}')]);
      attempts.push(attempt);
      return Promise.resolve(attempt.response);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await fetchJsonWithRetry(
        "https://example.com/chunked.json",
        undefined,
        1,
        { maxResponseBytes: 10 },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(attempts.every((attempt) => attempt.cancel.mock.calls.length === 1)).toBe(true);
      expect(warnRecords(warnSpy).filter((record) =>
        record.errorName === "ResponseBodyTooLargeError"
      )).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries and rejects a chunked text body above the configured limit", async () => {
    const attempts: Array<ReturnType<typeof streamedResponse>> = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      const attempt = streamedResponse([encode("abcd"), encode("ef")]);
      attempts.push(attempt);
      return Promise.resolve(attempt.response);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await fetchTextWithRetry(
        "https://example.com/chunked.txt",
        undefined,
        1,
        { maxResponseBytes: 5 },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(attempts.every((attempt) => attempt.cancel.mock.calls.length === 1)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("counts UTF-8 bytes while preserving an under-limit multibyte body", async () => {
    const bytes = encode("€🙂");
    const attempt = streamedResponse([bytes.slice(0, 2), bytes.slice(2)]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(attempt.response));

    const result = await fetchTextWithRetry(
      "https://example.com/multibyte.txt",
      undefined,
      0,
      { maxResponseBytes: bytes.byteLength },
    );

    expect(bytes.byteLength).toBe(7);
    expect(result?.body).toBe("€🙂");
    expect(attempt.cancel).not.toHaveBeenCalled();
  });

  it("reads JSON from a bodyless Response-like test double", async () => {
    const responseLike = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ price: 1 }),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseLike));

    const result = await fetchJsonWithRetry<{ price: number }>(
      "https://example.com/mock.json",
      undefined,
      0,
    );

    expect(result).toEqual({ response: responseLike, body: { price: 1 } });
    expect(responseLike.json).toHaveBeenCalledTimes(1);
  });

  it("enforces the limit after reading a bodyless Response-like test double", async () => {
    const responseLike = {
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("oversized"),
    } as unknown as Response;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseLike));

    try {
      const result = await fetchTextWithRetry(
        "https://example.com/mock.txt",
        undefined,
        0,
        { maxResponseBytes: 5 },
      );

      expect(result).toBeNull();
      expect(warnRecords(warnSpy)).toContainEqual(expect.objectContaining({
        event: "fetch_retry_attempt_failed",
        errorName: "ResponseBodyTooLargeError",
        metadata: expect.objectContaining({ maxBytes: 5, observedBytes: 9 }),
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
