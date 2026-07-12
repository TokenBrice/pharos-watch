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
}));

import { fetchJsonWithRetry, fetchTextWithRetry, fetchWithRetry } from "../fetch-retry";

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

describe("fetchWithRetry", () => {
  beforeEach(() => {
    sleepWithSignalMock.mockClear();
    throwIfAbortedMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(warnSpy).toHaveBeenCalledWith("[fetch-retry] https://example.com/<redacted>/resource returned 520 (attempt 1/1)");
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

    expect(warnSpy).toHaveBeenCalledWith(
      "[fetch-retry] https://eth-mainnet.g.alchemy.com/[redacted] returned 520 (attempt 1/1)",
    );
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
      expect(warnSpy).toHaveBeenCalledWith(
        "[fetch-retry] https://example.com/slow.json failed (attempt 1/1):",
        expect.objectContaining({ name: "TimeoutError" }),
      );
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
      expect(warnSpy).toHaveBeenCalledWith(
        "[fetch-retry] https://example.com/slow.txt failed (attempt 1/1):",
        expect.objectContaining({ name: "TimeoutError" }),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
