import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { fetchWithRetry } from "../fetch-retry";

describe("fetchWithRetry", () => {
  beforeEach(() => {
    sleepWithSignalMock.mockClear();
    throwIfAbortedMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("backs off on 529 overload responses before succeeding", async () => {
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
  });

  it("keeps the per-request timeout active while callers consume the response body", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          controller.close();
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/slow-body", undefined, 0, { timeoutMs: 200 });
    expect(res).not.toBeNull();

    const bodyRead = res!.text();
    const assertion = expect(bodyRead).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(201);

    await assertion;
  });

});
