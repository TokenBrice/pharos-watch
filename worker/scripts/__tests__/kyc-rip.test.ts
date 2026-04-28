import { describe, expect, it, vi } from "vitest";
import { fetchKycRipRows, type KycRipCurrentBalanceRow } from "../lib/kyc-rip";

function okPayload(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

const validCurrentRow = {
  address: "0x0000000000000000000000000000000000000001",
  asset: "USDT",
  chain: "ETH",
  frozen_balance: "12.5",
};

describe("kyc.rip fetch validation", () => {
  it("retries provider 5xx responses and accepts the final valid payload", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(okPayload([validCurrentRow]));

    const result = await fetchKycRipRows<KycRipCurrentBalanceRow>({
      mode: "current-balances",
      timeoutMs: 10_000,
      minRows: 1,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
    expect(result.stats.acceptedRows).toBe(1);
  });

  it("does not retry wrong payload shapes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await expect(fetchKycRipRows({
      mode: "current-balances",
      timeoutMs: 10_000,
      minRows: 1,
      fetchImpl,
    })).rejects.toThrow(/data array/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails below-minimum accepted row counts without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([]));

    await expect(fetchKycRipRows({
      mode: "current-balances",
      timeoutMs: 10_000,
      minRows: 1,
      fetchImpl,
    })).rejects.toThrow(/below minimum/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats missing required asset or chain fields as malformed rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([
      { address: "0x0000000000000000000000000000000000000001", asset: "USDT", frozen_balance: "1" },
    ]));

    await expect(fetchKycRipRows({
      mode: "current-balances",
      timeoutMs: 10_000,
      minRows: 1,
      maxMalformedRows: 0,
      fetchImpl,
    })).rejects.toThrow(/malformed rows/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts timed-out requests with AbortController", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );

    const promise = fetchKycRipRows({
      mode: "current-balances",
      timeoutMs: 50,
      minRows: 1,
      retries: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const rejection = expect(promise).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
