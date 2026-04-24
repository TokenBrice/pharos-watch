import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../abort", () => ({
  sleepWithSignal: vi.fn(async () => undefined),
}));

import { fetchWithRetry } from "../fetch-retry";
import { fetchDsTokenPoolsWithStatus } from "../dexscreener";

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
    });
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
});
