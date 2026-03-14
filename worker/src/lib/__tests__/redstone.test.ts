import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRedstonePrices } from "../redstone";

afterEach(() => vi.unstubAllGlobals());

describe("fetchRedstonePrices", () => {
  it("returns price and venue breakdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        USDT: [{
          value: 0.9998,
          source: { binance: 0.9999, coinbase: 0.9997, curve: 0.9998 },
          timestamp: 1710000000000,
        }],
      }),
    }));
    const results = await fetchRedstonePrices(["USDT"]);
    expect(results.size).toBe(1);
    const r = results.get("USDT")!;
    expect(r.price).toBeCloseTo(0.9998, 4);
    expect(r.venues.size).toBeGreaterThanOrEqual(3);
    expect(r.venueAgreementPct).toBeGreaterThan(0);
  });

  it("computes venue agreement percentage correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        USDT: [{
          value: 0.97,
          source: {
            binance: 0.97, coinbase: 0.97, kraken: 0.97,
            curve: 1.00, uniswap: 1.00,
          },
          timestamp: Date.now(),
        }],
      }),
    }));
    const results = await fetchRedstonePrices(["USDT"]);
    const r = results.get("USDT")!;
    // 3 out of 5 venues show depeg → 60% venue agreement
    expect(r.venueAgreementPct).toBeCloseTo(60, 0);
  });
});
