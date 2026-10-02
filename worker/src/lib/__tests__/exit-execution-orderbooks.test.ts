import { describe, expect, it } from "vitest";
import { observeKrakenExitBooks, walkExitBidBook } from "../exit-execution/orderbooks";
import type { ExitExecutionCertificate, ExitExecutionModelReview } from "@shared/types/exit-route";

const inputReference: ExitExecutionCertificate["inputReference"] = { assetKey: "fixture", deployment: "venue:kraken:fixture", rawUnits: "0", decimals: 2, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "input-price", sourceGenerationId: "price-1", observedAtSec: 1000 };
const outputReference: ExitExecutionCertificate["inputReference"] = { ...inputReference, assetKey: "fiat:USD", deployment: "fiat:USD:kraken", decimals: 2 };
const request = { requestedRawInput: 2000n, requestedNotionalUsd: 20, maxCostBps: 200, inputReference, outputReference, takerFeeBps: 50, lotRaw: 1n, minimumRaw: 100n, minimumOutputRaw: 50n, exhaustive: false };
const review: ExitExecutionModelReview = {
  modelId: "orderbook", identity: { assetId: "fixture", deployment: inputReference.deployment, endpoint: "kraken:fixtureUSD", outputAssetKeys: ["fiat:USD"], implementationIdentity: "kraken-v1" }, holder: "verified-customer", reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", evidenceIds: ["fixture"], sourceUrls: ["https://example.com/market"], producer: { kind: "kraken", market: "fixtureUSD", base: "fixture", quote: "ZUSD", inputDecimals: 2, outputDecimals: 2, outputDeployment: outputReference.deployment, settlementEndpoint: "USD-bank-withdrawal" },
};

describe("exact sell-side book walking", () => {
  it("fills a partial final level and subtracts taker fees exactly once", () => {
    const point = walkExitBidBook({ ...request, bids: [["1", "15", 1000], ["0.99", "10", 1000]] });
    expect(point).toMatchObject({ executedRawInput: "2000", executableUsd: 20, allInCostBps: 75, certification: "exact-lower-bound" });
    expect(point.outputs[0]!.rawUnits).toBe("1985");
    expect(point.fees[0]!.rawUnits).toBe("10");
  });
  it("retains a passing prefix but gives no capacity to an entirely overpriced or under-minimum book", () => {
    expect(walkExitBidBook({ ...request, bids: [["1", "15", 1000], ["0.8", "10", 1000]] })).toMatchObject({ executableUsd: 15, executedRawInput: "1500" });
    expect(walkExitBidBook({ ...request, bids: [["0.8", "20", 1000]] })).toMatchObject({ executableUsd: 0, reason: "observed-no-passing-bids" });
    expect(walkExitBidBook({ ...request, bids: [["1", "0.5", 1000]] })).toMatchObject({ executableUsd: 0 });
  });
  it("prices the actual quote currency rather than assuming fiat par and respects order rounding", () => {
    const cad = { ...outputReference, assetKey: "fiat:CAD", unitValueUsd: 0.75, expectedUnitValueUsd: 0.75 };
    const point = walkExitBidBook({ ...request, outputReference: cad, takerFeeBps: 0, lotRaw: 100n, requestedRawInput: 2050n, requestedNotionalUsd: 20.5, bids: [["1.34", "50", 1000]] });
    expect(point).toMatchObject({ executedRawInput: "2000", certification: "exact-lower-bound" });
    expect(point.outputs[0]).toMatchObject({ assetKey: "fiat:CAD", rawUnits: "2680", unitValueUsd: 0.75 });
    expect(walkExitBidBook({ ...request, outputReference: { ...cad, unitValueUsd: 0.5 }, bids: [["1.34", "50", 1000]] }).executableUsd).toBe(0);
  });
  it("rejects inverted bids and does not equate an empty valid prefix with malformed input", () => {
    expect(() => walkExitBidBook({ ...request, bids: [["0.99", "5", 1000], ["1", "5", 1000]] })).toThrow("invalid-book-level-order");
    expect(walkExitBidBook({ ...request, bids: [] })).toMatchObject({ executableUsd: 0, certification: "exact-lower-bound", reason: "observed-no-passing-bids" });
    expect(() => walkExitBidBook({ ...request, bids: [["NaN", "5", 1000]] })).toThrow("invalid-execution-decimal");
  });
  it("distinguishes exhaustive fill from a capped observed prefix", () => {
    const bids = [["1", "25", 1000]] as const;
    expect(walkExitBidBook({ ...request, bids, exhaustive: true }).certification).toBe("exact-complete");
    expect(walkExitBidBook({ ...request, bids, exhaustive: false }).certification).toBe("exact-lower-bound");
  });
});

describe("Kraken live source contract", () => {
  function fetcher(fees: number[][], bids: unknown[] = [["1", "30", 1000]], asks: unknown[] = [["1.01", "30", 1000]]) {
    return (async (url: string | URL | Request) => {
      const path = String(url);
      const result = path.includes("AssetPairs") ? { fixtureUSD: { base: "fixture", quote: "ZUSD", lot_decimals: 2, ordermin: "1", costmin: "0.5", status: "online", fees } } : path.includes("Depth") ? { fixtureUSD: { bids, asks } } : { unixtime: 1000 };
      return new Response(JSON.stringify({ error: [], result }));
    }) as typeof fetch;
  }
  it("walks bids, not asks, without claiming the REST payload is exhaustive", async () => {
    const observed = await observeKrakenExitBooks({ review, inputReference, outputReference, requests: [{ requestedNotionalUsd: 20, maxCostBps: 200 }], fetcher: fetcher([[0, 0.5]]) });
    expect(observed.points[0]).toMatchObject({ executableUsd: 20, allInCostBps: 50, certification: "exact-lower-bound" });
    expect(observed.source).toMatchObject({ complete: false, truncated: true });
  });
  it("fails closed on undisclosed applicable fees and crossed or malformed books", async () => {
    await expect(observeKrakenExitBooks({ review, inputReference, outputReference, requests: [{ requestedNotionalUsd: 20, maxCostBps: 200 }], fetcher: fetcher([]) })).rejects.toThrow("kraken-applicable-fee-unavailable");
    await expect(observeKrakenExitBooks({ review, inputReference, outputReference, requests: [{ requestedNotionalUsd: 20, maxCostBps: 200 }], fetcher: fetcher([[0, 0.5]], [["1.02", "30", 1000]]) })).rejects.toThrow("kraken-crossed-book");
  });
});
