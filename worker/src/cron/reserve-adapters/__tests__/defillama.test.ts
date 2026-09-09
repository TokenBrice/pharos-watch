import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { fetchDefiLlamaPrices } from "../defillama";

describe("fetchDefiLlamaPrices", () => {
  beforeEach(() => {
    vi.mocked(fetchTextWithRetry).mockReset();
  });

  it("normalizes addresses and applies DefiLlama chain aliases", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({
        coins: {
          "hyperliquid:0xabc": { price: 1.23 },
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
        "ethereum:0xabc": { price: 2 },
        "ethereum:0xzero": { price: 0 },
        "ethereum:0xnegative": { price: -1 },
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
      body: JSON.stringify({ coins: { "ethereum:0xabc": { price: 2 } } }),
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
      body: JSON.stringify({ coins: { "ethereum:0xabc": { price: 2 } } }),
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
});
