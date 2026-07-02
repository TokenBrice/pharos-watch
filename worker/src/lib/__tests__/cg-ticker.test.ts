import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonWithRetry } from "../fetch-retry";
import {
  fetchCgTickerPricesDetailed,
  pickBestTicker,
  type CgTickerConfig,
} from "../cg-ticker";

const KAU_CONFIG: CgTickerConfig = {
  stablecoinId: "kau-kinesis",
  geckoId: "kinesis-gold",
  targetCurrency: "USD",
  exchangeId: "kinesis_money",
};

const KAG_CONFIG: CgTickerConfig = {
  stablecoinId: "kag-kinesis",
  geckoId: "kinesis-silver",
  targetCurrency: "USD",
  exchangeId: "kinesis_money",
};

function makeTicker(overrides: Record<string, unknown> = {}) {
  return {
    base: "KAU",
    target: "USD",
    last: 136.76,
    volume: 1815,
    is_stale: false,
    bid_ask_spread_percentage: 0.12,
    converted_last: { usd: 136.76 },
    converted_volume: { usd: 248_100 },
    market: { identifier: "kinesis_money" },
    ...overrides,
  };
}

function makeTickerResult(tickers: unknown[]) {
  return {
    response: new Response(JSON.stringify({ tickers }), { status: 200 }),
    body: { tickers },
  };
}

describe("pickBestTicker", () => {
  it("picks the USD ticker", () => {
    const tickers = [
      makeTicker({ target: "EUR", last: 118.71, converted_volume: { usd: 310_000 } }),
      makeTicker({ target: "USD", last: 136.76, converted_volume: { usd: 248_100 } }),
    ];
    expect(pickBestTicker(tickers as never[], "USD")).toBe(136.76);
  });

  it("filters out stale tickers", () => {
    const tickers = [
      makeTicker({ is_stale: true, last: 175.32, converted_volume: { usd: 500_000 } }),
      makeTicker({ is_stale: false, last: 136.76, converted_volume: { usd: 248_100 } }),
    ];
    expect(pickBestTicker(tickers as never[], "USD")).toBe(136.76);
  });

  it("returns null when no USD tickers exist", () => {
    const tickers = [makeTicker({ target: "EUR", last: 118.71 })];
    expect(pickBestTicker(tickers as never[], "USD")).toBeNull();
  });

  it("returns null when all USD tickers are stale", () => {
    const tickers = [makeTicker({ is_stale: true })];
    expect(pickBestTicker(tickers as never[], "USD")).toBeNull();
  });

  it("picks the highest-volume ticker among multiple USD pairs", () => {
    const tickers = [
      makeTicker({ last: 132.77, converted_volume: { usd: 42_000 } }),
      makeTicker({ last: 136.76, converted_volume: { usd: 248_100 } }),
    ];
    expect(pickBestTicker(tickers as never[], "USD")).toBe(136.76);
  });

  it("filters by exchange ID when provided", () => {
    const tickers = [
      makeTicker({ last: 200.0, converted_volume: { usd: 999_999 }, market: { identifier: "other_exchange" } }),
      makeTicker({ last: 136.76, converted_volume: { usd: 248_100 }, market: { identifier: "kinesis_money" } }),
    ];
    expect(pickBestTicker(tickers as never[], "USD", "kinesis_money")).toBe(136.76);
  });

  it("matches ticker targets case-insensitively", () => {
    const tickers = [makeTicker({ target: "usd" })];
    expect(pickBestTicker(tickers as never[], "USD")).toBe(136.76);
  });

  it("rejects tickers with non-positive price", () => {
    const tickers = [
      makeTicker({ last: 0 }),
      makeTicker({ last: -5 }),
    ];
    expect(pickBestTicker(tickers as never[], "USD")).toBeNull();
  });
});

describe("fetchCgTickerPricesDetailed", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches both coins on happy path", async () => {
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("kinesis-gold")) {
        return makeTickerResult([makeTicker({ last: 136.76 })]);
      }
      if (url.includes("kinesis-silver")) {
        return makeTickerResult([makeTicker({ base: "KAG", last: 62.42, converted_volume: { usd: 143_000 } })]);
      }
      return null;
    });

    const results = (await fetchCgTickerPricesDetailed([KAU_CONFIG, KAG_CONFIG], null)).prices;

    expect(results.size).toBe(2);
    expect(results.get("kau-kinesis")).toBe(136.76);
    expect(results.get("kag-kinesis")).toBe(62.42);
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(2);
  });

  it("passes API key through to the fetch call", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(makeTickerResult([makeTicker()]));

    await fetchCgTickerPricesDetailed([KAU_CONFIG], "my-key");

    // Verify fetch was called — API key plumbing is tested via coingecko.ts unit
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(fetchJsonWithRetry).mock.calls[0]!;
    expect(url).toContain("/coins/kinesis-gold/tickers");
  });

  it("continues when one coin fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("kinesis-gold")) return null; // failure
      return makeTickerResult([makeTicker({ base: "KAG", last: 62.42, converted_volume: { usd: 143_000 } })]);
    });

    const results = (await fetchCgTickerPricesDetailed([KAU_CONFIG, KAG_CONFIG], null)).prices;

    expect(results.size).toBe(1);
    expect(results.has("kau-kinesis")).toBe(false);
    expect(results.get("kag-kinesis")).toBe(62.42);
  });

  it("skips coins with no valid USD ticker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(
      makeTickerResult([makeTicker({ target: "EUR", last: 118.71 })]),
    );

    const results = (await fetchCgTickerPricesDetailed([KAU_CONFIG], null)).prices;
    expect(results.size).toBe(0);
  });

  it("includes exchange_ids filter in URL", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(makeTickerResult([makeTicker()]));

    await fetchCgTickerPricesDetailed([KAU_CONFIG], null);

    const [url] = vi.mocked(fetchJsonWithRetry).mock.calls[0]!;
    expect(url).toContain("exchange_ids=kinesis_money");
  });

  it("rethrows on abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(new Error("aborted"));

    await expect(
      fetchCgTickerPricesDetailed([KAU_CONFIG], null, controller.signal),
    ).rejects.toThrow("aborted");
  });
});

describe("fetchCgTickerPricesDetailed result metadata", () => {
  afterEach(() => vi.clearAllMocks());

  it("counts successful responses even when no fresh ticker is usable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(
      makeTickerResult([makeTicker({ is_stale: true })]),
    );

    const result = await fetchCgTickerPricesDetailed([KAU_CONFIG], null);

    expect(result.successfulResponses).toBe(1);
    expect(result.prices.size).toBe(0);
  });
});
