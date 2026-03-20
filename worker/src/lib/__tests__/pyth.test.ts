import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPythPrices } from "../pyth";

afterEach(() => vi.unstubAllGlobals());

describe("fetchPythPrices", () => {
  it("returns prices with confidence intervals for unprefixed Hermes feed ids", async () => {
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          {
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100013000", expo: -8, conf: "61000", publish_time: freshPublishTime },
          },
        ],
      }),
    }));

    const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
    const results = await fetchPythPrices(feedIds);

    expect(results.size).toBe(1);
    const r = results.get("usdt-tether")!;
    expect(r.price).toBeCloseTo(1.00013, 4);
    expect(r.confidenceBps).toBeGreaterThan(0);
    expect(r.publishTime).toBe(freshPublishTime);
  });

  it("warns when feeds were requested but none map back to tracked assets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          {
            id: "deadbeef",
            price: { price: "100000000", expo: -8, conf: "1000", publish_time: 1710000000 },
          },
        ],
      }),
    }));

    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const results = await fetchPythPrices(feedIds);

    expect(results.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith("[pyth] Requested 1 feeds but Hermes returned 0 usable results");
  });

  it("returns empty map on API failure", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, body: { cancel } }));
    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const results = await fetchPythPrices(feedIds);
    expect(results.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("skips feeds with non-positive price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          { id: "0xabc", price: { price: "0", expo: -8, conf: "0", publish_time: 0 } },
        ],
      }),
    }));
    const feedIds = new Map([["broken-coin", "0xabc"]]);
    const results = await fetchPythPrices(feedIds);
    expect(results.size).toBe(0);
  });

  it("rejects feeds older than PYTH_MAX_STALENESS_SEC (RISK-3)", async () => {
    const stalePublishTime = Math.floor(Date.now() / 1000) - 600; // 10 min ago (> 5 min threshold)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        parsed: [
          {
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100010000", expo: -8, conf: "5000", publish_time: stalePublishTime },
          },
        ],
      }),
    }));

    const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
    const results = await fetchPythPrices(feedIds);

    expect(results.size).toBe(0);
  });
});
