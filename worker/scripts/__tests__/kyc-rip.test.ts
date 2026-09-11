import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.useRealTimers());

describe("kyc.rip fetch validation", () => {
  it("continues full pages with distinct offsets and retains every accepted row", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      ...validCurrentRow, address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okPayload(rows.slice(0, 1000)))
      .mockResolvedValueOnce(okPayload(rows.slice(1000)));
    const result = await fetchKycRipRows({ mode: "current-balances", timeoutMs: 1000, minRows: 1001, fetchImpl });
    expect(result.rows).toEqual(rows);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get("offset"))).toEqual(["0", "1000"]);
  });

  it.each([1, 2])("separates unsupported rows from the malformed tolerance of %i", async (malformedCount) => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([
      validCurrentRow,
      { ...validCurrentRow, asset: "USDC", chain: "TRON" },
      ...Array.from({ length: malformedCount }, () => ({ ...validCurrentRow, frozen_balance: "bad" })),
    ]));
    const result = fetchKycRipRows({
      mode: "current-balances", timeoutMs: 1000, minRows: 1, maxMalformedRows: 1, fetchImpl,
    });
    if (malformedCount === 2) {
      await expect(result).rejects.toThrow(/2 malformed rows/);
    } else {
      expect(await result).toMatchObject({
        rows: [validCurrentRow],
        stats: { fetchedRows: 3, acceptedRows: 1, skippedUnsupportedRows: 1, malformedRows: 1 },
      });
    }
  });

  it("validates event transaction hashes while excluding Tron from accepted minimums", async () => {
    const row = { address: validCurrentRow.address, asset: "USDT", chain: "ETH", tx_hash: `0x${"a".repeat(64)}` };
    const payload = [row, { ...row, tx_hash: "0x123" }, { ...row, chain: "TRON" }];
    const result = await fetchKycRipRows({
      mode: "events", timeoutMs: 1000, minRows: 1, maxMalformedRows: 1,
      fetchImpl: vi.fn().mockResolvedValue(okPayload(payload)),
    });
    expect(result).toMatchObject({
      rows: [row],
      stats: { acceptedRows: 1, malformedRows: 1, skippedUnsupportedRows: 1 },
    });
    await expect(fetchKycRipRows({
      mode: "events", timeoutMs: 1000, minRows: 2, maxMalformedRows: 1,
      fetchImpl: vi.fn().mockResolvedValue(okPayload(payload)),
    })).rejects.toThrow(/accepted 1 rows, below minimum 2/);
  });
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
  });
});
