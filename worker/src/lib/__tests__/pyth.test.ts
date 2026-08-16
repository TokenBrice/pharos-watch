import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPythPrices } from "../pyth";
import pythHermesFixture from "./fixtures/pyth-hermes.json";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchPythPrices", () => {
  it("returns prices with confidence intervals for unprefixed Hermes feed ids", async () => {
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    mockFetch([{
      match: () => true,
      body: {
        parsed: [
          {
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100013000", expo: -8, conf: "61000", publish_time: freshPublishTime },
          },
        ],
      },
    }]);

    const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
    const outcome = await fetchPythPrices(feedIds);

    expect(outcome.kind).toBe("ok");
    expect(outcome.value.size).toBe(1);
    const r = outcome.value.get("usdt-tether")!;
    expect(r.price).toBeCloseTo(1.00013, 4);
    expect(r.confidenceBps).toBeGreaterThan(0);
    expect(r.publishTime).toBe(freshPublishTime);
  });

  it("warns when feeds were requested but none map back to tracked assets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([{
      match: () => true,
      body: {
        parsed: [
          {
            id: "deadbeef",
            price: { price: "100000000", expo: -8, conf: "1000", publish_time: 1710000000 },
          },
        ],
      },
    }]);

    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const outcome = await fetchPythPrices(feedIds);

    expect(outcome.value.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[pyth] Requested 1 feeds but Hermes returned 0 usable results"));
  });

  it("returns upstream-error outcome on API failure", async () => {
    const cancel = vi.fn(async () => undefined);
    const failedResponse = () => new Response(new ReadableStream({ cancel }), { status: 503 });
    mockFetch([{
      match: () => true,
      outcomes: [{ response: failedResponse() }, { response: failedResponse() }],
    }]);
    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const outcome = await fetchPythPrices(feedIds);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("skips feeds with non-positive price", async () => {
    mockFetch([{
      match: () => true,
      body: {
        parsed: [
          { id: "0xabc", price: { price: "0", expo: -8, conf: "0", publish_time: 0 } },
        ],
      },
    }]);
    const feedIds = new Map([["broken-coin", "0xabc"]]);
    const outcome = await fetchPythPrices(feedIds);
    expect(outcome.value.size).toBe(0);
  });

  it("rejects feeds older than PYTH_MAX_STALENESS_SEC (RISK-3)", async () => {
    const stalePublishTime = Math.floor(Date.now() / 1000) - 600; // 10 min ago (> 5 min threshold)
    mockFetch([{
      match: () => true,
      body: {
        parsed: [
          {
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100010000", expo: -8, conf: "5000", publish_time: stalePublishTime },
          },
        ],
      },
    }]);

    const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
    const outcome = await fetchPythPrices(feedIds);

    expect(outcome.value.size).toBe(0);
  });

  it("returns no-data outcome when feedIds is empty", async () => {
    mockFetch([], { requireMatch: true });
    const outcome = await fetchPythPrices(new Map());
    expect(outcome.kind).toBe("no-data");
  });

  it("returns upstream-error outcome when fetch throws", async () => {
    mockFetch([{ match: () => true, outcomes: [new Error("network down")] }]);
    const feedIds = new Map([["usdt-tether", "0xabc"]]);
    const outcome = await fetchPythPrices(feedIds);
    expect(outcome.kind).toBe("upstream-error");
  });

  it("parses a real Hermes v2 USDT/USD response (fixture)", async () => {
    // Fixture captured from
    // https://hermes.pyth.network/v2/updates/price/latest?ids[]=<USDT/USD feed>.
    // Verifies the live parsed-envelope shape is accepted by PythPriceFeedSchema
    // and the price/conf BigInt + expo arithmetic works end-to-end.
    const fixtureFeed = pythHermesFixture.parsed[0];
    // Freeze time just after fixture's publish_time so the 300s staleness
    // gate accepts the sample.
    vi.useFakeTimers();
    vi.setSystemTime(new Date((fixtureFeed.price.publish_time + 10) * 1000));

    mockFetch([{ match: () => true, body: pythHermesFixture }]);

    const feedIds = new Map([["usdt-tether", `0x${fixtureFeed.id}`]]);
    const outcome = await fetchPythPrices(feedIds);

    expect(outcome.kind).toBe("ok");
    const result = outcome.value.get("usdt-tether")!;
    const expectedPrice = Number(fixtureFeed.price.price) * Math.pow(10, fixtureFeed.price.expo);
    expect(result.price).toBeCloseTo(expectedPrice, 6);
    expect(result.publishTime).toBe(fixtureFeed.price.publish_time);
    expect(result.confidenceBps).toBeGreaterThan(0);
  });
});
