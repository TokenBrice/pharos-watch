import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as FetchRetry from "../../../lib/fetch-retry";

vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({
  ...await importOriginal<typeof FetchRetry>(),
  fetchTextWithRetry: vi.fn(),
}));

import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { fetchDefiLlamaPrices } from "../defillama";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";

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

    const { prices, warnings } = await fetchDefiLlamaPrices(
      [{ key: "branch", chain: "hyperevm", address: "0xABC" }],
      new AbortController().signal,
    );

    expect(prices.get("branch")).toBe(1.23);
    expect(warnings).toEqual([]);
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

  it("returns empty prices and warnings without network I/O for no assets", async () => {
    expect(await fetchDefiLlamaPrices([], new AbortController().signal)).toEqual({ prices: new Map(), warnings: [] });
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
    const { prices, warnings } = await fetchDefiLlamaPrices(
      ["first", "second", "zero", "negative", "missing"].map((key) => ({
        key, chain: "ethereum", address: key === "first" || key === "second" ? "0xABC" : `0x${key}`,
      })),
      new AbortController().signal,
    );
    expect(prices).toEqual(new Map([["first", 2], ["second", 2]]));
    expect(warnings).toHaveLength(3);
    expect(warnings.every((warning) => warning.code === "defillama-quote-missing" && warning.effect === "degraded")).toBe(true);
  });

  it("returns each caller's logical keys while sharing one upstream fetch for the same asset", async () => {
    vi.mocked(fetchTextWithRetry).mockImplementation(async (_url, _init, _retries, options) => {
      const body = JSON.stringify({ coins: { "ethereum:0xabc": {
        price: 2, timestamp: Math.floor(Date.now() / 1000), confidence: 1,
      } } });
      options?.onBodyRead?.({ intakeBytes: new TextEncoder().encode(body).byteLength, declaredBytes: null, outcome: "accepted" });
      return { response: new Response(body), body };
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    expect(await fetchDefiLlamaPrices([{ key: "first", chain: "ethereum", address: "0xABC" }], signal, ctx))
      .toEqual({ prices: new Map([["first", 2]]), warnings: [] });
    expect(await fetchDefiLlamaPrices([{ key: "second", chain: "ethereum", address: "0xabc" }], signal, ctx))
      .toEqual({ prices: new Map([["second", 2]]), warnings: [] });
    expect(await fetchDefiLlamaPrices([{ key: "second", chain: "ethereum", address: "0xabc" }], signal, ctx))
      .toEqual({ prices: new Map([["second", 2]]), warnings: [] });
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller's fallback prices leak into a later cached request", async () => {
    vi.mocked(fetchTextWithRetry).mockImplementation(async (_url, _init, _retries, options) => {
      const body = JSON.stringify({ coins: { "ethereum:0xabc": {
        price: 2, timestamp: Math.floor(Date.now() / 1000), confidence: 1,
      } } });
      options?.onBodyRead?.({ intakeBytes: new TextEncoder().encode(body).byteLength, declaredBytes: null, outcome: "accepted" });
      return { response: new Response(body), body };
    });
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const signal = new AbortController().signal;
    const assets = [
      { key: "priced", chain: "ethereum", address: "0xABC" },
      { key: "unpriced", chain: "ethereum", address: "0xDEF" },
    ];

    const first = await fetchDefiLlamaPrices(assets, signal, ctx);
    first.prices.set("unpriced", 99);
    first.warnings.length = 0;

    const second = await fetchDefiLlamaPrices(assets, signal, ctx);
    expect(second.prices).toEqual(new Map([["priced", 2]]));
    expect(second.warnings).toEqual([expect.objectContaining({ code: "defillama-quote-missing", effect: "degraded" })]);
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
  });

  it("returns low-quality warnings with retained values for every cached caller", async () => {
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
      const { prices, warnings } = await fetchDefiLlamaPrices(assets, new AbortController().signal, ctx);
      expect(prices).toEqual(new Map([["old", 2], ["weak", 3], ["edge", 4]]));
      expect(warnings.map((warning) => warning.effect)).toEqual(["degraded", "degraded"]);
      warnings.length = 0;
    }
  });

  it.each([
    { label: "one-day boundary", timestamp: 200000 - 86400, degraded: false },
    { label: "one second too old", timestamp: 200000 - 86401, degraded: true },
    { label: "allowed future skew", timestamp: 200000 + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, degraded: false },
    { label: "one second beyond future skew", timestamp: 200001 + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, degraded: true },
    { label: "millisecond timestamp", timestamp: 200000 * 1000, degraded: true },
    { label: "missing timestamp", timestamp: undefined, degraded: true },
    { label: "zero timestamp", timestamp: 0, degraded: true },
  ])("classifies $label at the quote boundary", async ({ timestamp, degraded }) => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({ coins: { "ethereum:0xabc": { price: 2, timestamp, confidence: 0.8 } } }),
    });
    const { prices, warnings } = await fetchDefiLlamaPrices(
      [{ key: "branch", chain: "ethereum", address: "0xabc" }],
      new AbortController().signal,
      { nowSec: 200000 },
    );
    expect(prices.get("branch")).toBe(2);
    expect(warnings).toEqual(degraded
      ? [expect.objectContaining({ code: "defillama-quote-quality", effect: "degraded" })]
      : []);
  });
});
