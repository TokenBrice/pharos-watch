import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../abort", () => ({
  sleepWithSignal: vi.fn(async () => undefined),
}));

import { fetchWithRetry } from "../fetch-retry";
import { fetchDsTokenPairsWithStatus, fetchDsTokenPoolsWithStatus, getDsTrackedTokenPriceUsd, getDsTrackedTokenSymbol } from "../dexscreener";

function validPair(chainId = "base", dexId = "aerodrome") {
  return {
    chainId, dexId, pairAddress: "0xpair",
    baseToken: { address: "0xabc", name: "USD Test", symbol: "USDTST" },
    quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
    priceUsd: "1.0001",
    liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
    volume: { h24: 1_000, h6: 100, h1: 10, m5: 1 },
    pairCreatedAt: 1_700_000_000_000,
  };
}
describe("dexscreener", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([undefined, "0", "-1", "invalid", "Infinity", "2"])(
    "derives quote USD only with a valid native ratio %s",
    (priceNative) => {
      const pair = { ...validPair(), priceUsd: "4", priceNative };
      expect(getDsTrackedTokenPriceUsd(pair, "0xDEF", "base")).toEqual({
        side: "quote", priceUsd: priceNative === "2" ? 2 : null,
      });
      expect(getDsTrackedTokenPriceUsd(pair, "0xABC", "base")).toEqual({ side: "base", priceUsd: 4 });
      expect(getDsTrackedTokenPriceUsd(pair, "other", "base")).toEqual({ side: null, priceUsd: null });
      expect(getDsTrackedTokenPriceUsd({ ...pair, priceUsd: "invalid" }, "0xdef", "base"))
        .toEqual({ side: "quote", priceUsd: null });
    },
  );

  it("preserves native identity case for both tracked-side price and symbol resolution", () => {
    const pair = {
      ...validPair("solana"), priceUsd: "4", priceNative: "2",
      baseToken: { address: "MintCase", name: "Native", symbol: "NATIVE" },
      quoteToken: { address: "QuoteCase", name: "Quote", symbol: "QUOTE" },
    };
    expect(getDsTrackedTokenPriceUsd(pair, "mintCase", "solana")).toEqual({ side: null, priceUsd: null });
    expect(getDsTrackedTokenSymbol(pair, "mintCase", "solana")).toBeNull();
    expect(getDsTrackedTokenPriceUsd(pair, "QuoteCase", "solana")).toEqual({ side: "quote", priceUsd: 2 });
    expect(getDsTrackedTokenSymbol(pair, "QuoteCase", "solana")).toBe("QUOTE");
    expect(getDsTrackedTokenPriceUsd(pair, "quoteCase", "solana")).toEqual({ side: null, priceUsd: null });
    for (const priceNative of [undefined, "0", "invalid"]) {
      expect(getDsTrackedTokenPriceUsd({ ...pair, priceNative }, "QuoteCase", "solana"))
        .toEqual({ side: "quote", priceUsd: null });
    }
    expect(getDsTrackedTokenPriceUsd(validPair(), "0xAbC", "base")).toEqual({ side: "base", priceUsd: 1.0001 });
    expect(getDsTrackedTokenSymbol(validPair(), "0xDEF", "base")).toBe("USDC");
    expect(getDsTrackedTokenPriceUsd(validPair(), "0xabc", "ethereum")).toEqual({ side: null, priceUsd: null });
    expect(getDsTrackedTokenSymbol(validPair(), "0xabc", "ethereum")).toBeNull();
  });

  it.each([fetchDsTokenPoolsWithStatus, fetchDsTokenPairsWithStatus])(
    "rejects wrong-chain responses and preserves mixed-chain incompleteness", async (fetchPools) => {
      vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify([validPair("ethereum")])));
      await expect(fetchPools("base", "0xabc")).resolves.toMatchObject({
        ok: false, degraded: true, pairs: [], error: expect.stringContaining("outside requested chain base"),
      });
      const pair = validPair();
      vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify([pair, validPair("ethereum")])));
      await expect(fetchPools("base", "0xabc")).resolves.toMatchObject({ ok: true, degraded: true, pairs: [pair] });
      vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("[]"));
      await expect(fetchPools("base", "0xabc")).resolves.toEqual({ ok: true, pairs: [] });
    },
  );

  it("compares against mapped provider chain slugs rather than Pharos chain ids", async () => {
    const pair = validPair("flowevm");
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify([pair])));
    await expect(fetchDsTokenPairsWithStatus("flow", "0xabc")).resolves.toEqual({ ok: true, pairs: [pair] });
    expect(getDsTrackedTokenPriceUsd(pair, "0xAbC", "flow")).toEqual({ side: "base", priceUsd: 1.0001 });
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

  it("uses the all-pairs endpoint and normalizes mixed rows for single-token discovery", async () => {
    const pair = validPair("blast", "thruster");
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify([pair, { pairAddress: "0xbroken" }]), { status: 200 }),
    );

    await expect(fetchDsTokenPairsWithStatus("blast", "0xabc", undefined, 8_000, 0)).resolves.toEqual({
      ok: true,
      pairs: [pair],
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

  it("returns final discovery 429 details and classifies the response as a hard refusal", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(fetchDsTokenPairsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: false,
      pairs: [],
      status: 429,
      contentType: "text/html",
      error: "HTTP 429 for https://api.dexscreener.com/token-pairs/v1/base/0xabc; body starts with: rate limited",
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

    await expect(fetchDsTokenPairsWithStatus("base", "0xabc")).resolves.toMatchObject({
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

    await expect(fetchDsTokenPairsWithStatus("base", "0xabc")).resolves.toMatchObject({
      ok: false,
      pairs: [],
      status: 500,
      contentType: "text/html",
      error: `HTTP 500 for https://api.dexscreener.com/token-pairs/v1/base/0xabc; body starts with: ${"x".repeat(160)}`,
    });
    expect(bytesPulled).toBeLessThanOrEqual(2048);
    expect(cancelCalled).toBe(true);
  });

  it("keeps valid token-pool rows and drops malformed rows from mixed payloads", async () => {
    const pair = validPair();
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify([pair, { pairAddress: "0xbroken" }]), { status: 200 }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: true,
      pairs: [pair],
    });
  });

  it("accepts object-style payloads that wrap pools under pairs[]", async () => {
    const pair = validPair();
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: [pair] }), { status: 200 }),
    );

    await expect(fetchDsTokenPoolsWithStatus("base", "0xabc")).resolves.toEqual({
      ok: true,
      pairs: [pair],
    });
  });

  it("refuses an over-cap token-pool body instead of buffering it into the isolate", async () => {
    const oversizedBody = JSON.stringify(Array.from({ length: 12_000 }, () => validPair()));
    expect(oversizedBody.length).toBeGreaterThan(2 * 1024 * 1024);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(oversizedBody, { status: 200 }));

    const result = await fetchDsTokenPoolsWithStatus("base", "0xoversize");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Response body exceeded \d+ bytes/);
  });
});
