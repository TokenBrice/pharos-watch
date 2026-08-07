import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../abort", () => ({
  sleepWithSignal: vi.fn(async () => undefined),
}));

import { fetchWithRetry } from "../fetch-retry";
import { fetchDsTokenPairsWithStatus, fetchDsTokenPoolsWithStatus } from "../dexscreener";

describe("dexscreener", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("treats malformed token-pool payloads as failed fetches for breaker accounting", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify([{ pairAddress: "0xpair" }]), { status: 200 }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: false,
      pairs: [],
      status: 200,
      contentType: "text/plain;charset=UTF-8",
      error: "DexScreener payload contained no valid pair rows",
    });
    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.dexscreener.com/tokens/v1/base/0xabc",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          "User-Agent": "Pharos/1.0 (stablecoin analytics)",
        },
      }),
      2,
      { timeoutMs: 10_000, returnFinalResponse: true },
    );
  });

  it("uses the all-pairs endpoint for single-token discovery", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await expect(fetchDsTokenPairsWithStatus("blast", "0xabc", undefined, 8_000, 0)).resolves.toEqual({
      ok: true,
      pairs: [],
    });
    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://api.dexscreener.com/token-pairs/v1/blast/0xabc",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          "User-Agent": "Pharos/1.0 (stablecoin analytics)",
        },
      }),
      0,
      { timeoutMs: 8_000, returnFinalResponse: true },
    );
  });

  it("returns final non-OK status details for diagnostics", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: false,
      pairs: [],
      status: 429,
      contentType: "text/html",
      error: "HTTP 429 for https://api.dexscreener.com/tokens/v1/base/0xabc; body starts with: rate limited",
      hardRefusal: true,
    });
  });

  it("classifies provider WAF code 1015 as a hard refusal even on a non-429 response", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response("error code: 1015", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toMatchObject({
      ok: false,
      status: 403,
      hardRefusal: true,
      error: expect.stringContaining("error code: 1015"),
    });
  });

  it("bounds and cancels non-OK diagnostic body reads", async () => {
    let bytesPulled = 0;
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new TextEncoder().encode("x".repeat(512));
        bytesPulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelCalled = true;
      },
    });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(body, {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toMatchObject({
      ok: false,
      pairs: [],
      status: 500,
      contentType: "text/html",
      error: `HTTP 500 for https://api.dexscreener.com/tokens/v1/base/0xabc; body starts with: ${"x".repeat(160)}`,
    });
    expect(bytesPulled).toBeLessThanOrEqual(2048);
    expect(cancelCalled).toBe(true);
  });

  it("keeps valid token-pool rows and drops malformed rows from mixed payloads", async () => {
    const validPair = {
      chainId: "base",
      dexId: "aerodrome",
      pairAddress: "0xpair",
      baseToken: { address: "0xabc", name: "USD Test", symbol: "USDTST" },
      quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
      priceUsd: "1.0001",
      liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
      volume: { h24: 1_000, h6: 100, h1: 10, m5: 1 },
      pairCreatedAt: Date.now(),
    };
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify([validPair, { pairAddress: "0xbroken" }]), { status: 200 }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: true,
      pairs: [validPair],
    });
  });

  it("accepts object-style payloads that wrap pools under pairs[]", async () => {
    const validPair = {
      chainId: "base",
      dexId: "aerodrome",
      pairAddress: "0xpair",
      baseToken: { address: "0xabc", name: "USD Test", symbol: "USDTST" },
      quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
      priceUsd: "1.0001",
      liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
      volume: { h24: 1_000, h6: 100, h1: 10, m5: 1 },
      pairCreatedAt: Date.now(),
    };
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: [validPair] }), { status: 200 }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: true,
      pairs: [validPair],
    });
  });
});
