import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRealtimeFxRates } from "../fx-realtime";

afterEach(() => vi.unstubAllGlobals());

describe("fetchRealtimeFxRates", () => {
  it("returns USD-per-unit rates for all requested currencies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: { JPY: 150.5, EUR: 0.925, BRL: 5.1, ZAR: 18.2, IDR: 15800 },
      }),
    }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.get("peggedJPY")).toBeCloseTo(1 / 150.5, 6);
    expect(rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(rates.get("peggedREAL")).toBeCloseTo(1 / 5.1, 4);
  });

  it("returns empty map on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.size).toBe(0);
  });

  it("validates rates against bounds before returning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        rates: { JPY: 0.001, EUR: 0.925 }, // JPY rate is absurd (1 JPY = $1000)
      }),
    }));
    const rates = await fetchRealtimeFxRates("test-key");
    expect(rates.has("peggedJPY")).toBe(false); // rejected by bounds
    expect(rates.has("peggedEUR")).toBe(true);   // accepted
  });
});
