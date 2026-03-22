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
});
