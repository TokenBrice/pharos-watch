import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { fetchDefiLlamaPrices } from "../defillama";
import type { LiveReserveWarning } from "@shared/types/live-reserves";

describe("fetchDefiLlamaPrices", () => {
  beforeEach(() => {
    vi.mocked(fetchTextWithRetry).mockReset();
  });

  it("normalizes addresses and applies DefiLlama chain aliases", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({
        coins: {
          "hyperliquid:0xabc": { price: 1.23, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
        },
      }),
    });

    const prices = await fetchDefiLlamaPrices(
      [{ key: "branch", chain: "hyperevm", address: "0xABC" }],
      new AbortController().signal,
    );

    expect(prices.get("branch")).toBe(1.23);
    expect(vi.mocked(fetchTextWithRetry).mock.calls[0]?.[0]).toContain("hyperliquid:0xabc");
  });

  it("throws a classified HTTP failure for non-ok responses", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response("nope", { status: 503 }),
      body: "nope",
    });

    await expect(fetchDefiLlamaPrices(
      [{ key: "branch", chain: "ethereum", address: "0xABC" }],
      new AbortController().signal,
    )).rejects.toThrow("DefiLlama price fetch failed (503)");
  });

  it("returns an empty map without network I/O for no assets", async () => {
    expect(await fetchDefiLlamaPrices([], new AbortController().signal)).toEqual(new Map());
    expect(fetchTextWithRetry).not.toHaveBeenCalled();
  });

  it("preserves separate logical keys for duplicate addresses and omits unavailable prices", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({ coins: {
        "ethereum:0xabc": { price: 2, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
        "ethereum:0xzero": { price: 0, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
        "ethereum:0xnegative": { price: -1, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
      } }),
    });
    const prices = await fetchDefiLlamaPrices(
      ["first", "second", "zero", "negative", "missing"].map((key) => ({
        key, chain: "ethereum", address: key === "first" || key === "second" ? "0xABC" : `0x${key}`,
      })),
      new AbortController().signal,
    );
    expect(prices).toEqual(new Map([["first", 2], ["second", 2]]));
  });

  it("returns each caller's logical keys while sharing one upstream fetch for the same asset", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({ coins: { "ethereum:0xabc": { price: 2, timestamp: Math.floor(Date.now() / 1000), confidence: 1 } } }),
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    expect(await fetchDefiLlamaPrices([{ key: "first", chain: "ethereum", address: "0xABC" }], signal, ctx))
      .toEqual(new Map([["first", 2]]));
    expect(await fetchDefiLlamaPrices([{ key: "second", chain: "ethereum", address: "0xabc" }], signal, ctx))
      .toEqual(new Map([["second", 2]]));
    expect(await fetchDefiLlamaPrices([{ key: "second", chain: "ethereum", address: "0xabc" }], signal, ctx))
      .toEqual(new Map([["second", 2]]));
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller's fallback prices leak into a later cached request", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({ coins: { "ethereum:0xabc": { price: 2, timestamp: Math.floor(Date.now() / 1000), confidence: 1 } } }),
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const assets = [
      { key: "priced", chain: "ethereum", address: "0xABC" },
      { key: "unpriced", chain: "ethereum", address: "0xDEF" },
    ];

    const first = await fetchDefiLlamaPrices(assets, signal, ctx);
    first.set("unpriced", 99);

    expect(await fetchDefiLlamaPrices(assets, signal, ctx)).toEqual(new Map([["priced", 2]]));
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
  });

  it("rejects low-quality quote admission while retaining warned values for every cached caller", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({ coins: {
        "ethereum:0xold": { price: 2, timestamp: 1, confidence: 1 },
        "ethereum:0xweak": { price: 3, timestamp: 200000, confidence: 0.79 },
        "ethereum:0xedge": { price: 4, timestamp: 113600, confidence: 0.8 },
      } }),
    });
    const ctx = { nowSec: 200000, requestCache: new Map<string, Promise<unknown>>() };
    const assets = ["old", "weak", "edge"].map((key) => ({ key, chain: "ethereum", address: `0x${key}` }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const warnings: LiveReserveWarning[] = [];
      expect(await fetchDefiLlamaPrices(assets, new AbortController().signal, ctx, warnings))
        .toEqual(new Map([["old", 2], ["weak", 3], ["edge", 4]]));
      expect(warnings.map((warning) => warning.effect)).toEqual(["degraded", "degraded"]);
    }
    await expect(fetchDefiLlamaPrices(assets, new AbortController().signal, ctx)).rejects.toThrow(/policy/);
  });
});
