import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { cgSimplePricePath } from "../coingecko";
import { fetchCoingeckoSimplePrices } from "../coingecko-simple-price";

const NOW_SEC = 1_792_391_400;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cgSimplePricePath", () => {
  it("forces full precision without dropping existing parameters", () => {
    const path = cgSimplePricePath("ids=euro-coin&vs_currencies=eur&precision=2");
    const url = new URL(path, "https://api.coingecko.com");

    expect(url.pathname).toBe("/simple/price");
    expect(url.searchParams.get("ids")).toBe("euro-coin");
    expect(url.searchParams.get("vs_currencies")).toBe("eur");
    expect(url.searchParams.get("precision")).toBe("full");
  });
});

describe("fetchCoingeckoSimplePrices", () => {
  it("keeps healthy quotes when one batch entry carries a null price", async () => {
    // R8: a provider-shape anomaly in one quote must not reject its 249
    // healthy siblings from the same /simple/price batch.
    mockFetch([
      {
        match: "api.coingecko.com/api/v3/simple/price",
        body: {
          hive_dollar: { usd: 0.98662, last_updated_at: NOW_SEC - 30 },
          "wrappedm-by-m0": { usd: null, last_updated_at: NOW_SEC - 30 },
          usdfc: { usd: 0.950358, last_updated_at: NOW_SEC - 90 },
        },
      },
    ], { requireMatch: true });

    const outcome = await fetchCoingeckoSimplePrices(
      ["hive_dollar", "wrappedm-by-m0", "usdfc"],
      null,
      undefined,
      NOW_SEC,
    );

    expect(outcome.kind).toBe("ok");
    expect(Object.fromEntries(outcome.value)).toEqual({
      hive_dollar: { price: 0.98662, observedAt: NOW_SEC - 30, observedAtMode: "upstream" },
      usdfc: { price: 0.950358, observedAt: NOW_SEC - 90, observedAtMode: "upstream" },
    });
  });
});
