import { beforeEach, describe, expect, it } from "vitest";
import {
  asset,
  makeHistoricalMeta,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
} from "./authoritative-price-sources.test-support";
import { createProtocolRedeemProvider } from "../authoritative-price-sources/protocol-redeem-provider";

const meta = makeHistoricalMeta("test-redeem", "Test redemption", "TEST");
const timestamps = [1_710_000_000, 1_710_003_600, 1_710_007_200, 1_710_010_800, 1_710_014_400];

describe("createProtocolRedeemProvider", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) => timestamp);
  });

  it("leaves an absent live quote unavailable and propagates a failed quote read", async () => {
    const unavailable = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => null,
    });
    await expect(unavailable.fetchLivePrice!(asset(meta.id), { assetsById: new Map() })).resolves.toBeNull();

    const error = new Error("protocol quote unavailable");
    const failed = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => { throw error; },
      fetchHistoricalQuote: async () => { throw error; },
    });
    await expect(failed.fetchLivePrice!(asset(meta.id), { assetsById: new Map() })).rejects.toBe(error);
    await expect(failed.fetchHistoricalPrices!(meta, { candidateTimestamps: [timestamps[0]] })).rejects.toBe(error);
  });

  it.each([
    { available: 3, accepted: false },
    { available: 4, accepted: true },
    { available: 5, accepted: true },
  ])("publishes a partial history only at the 80% coverage boundary ($available/5)", async ({ available, accepted }) => {
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async (_context, _block, timestamp) =>
        timestamp <= timestamps[available - 1] ? 0.97 : null,
    });

    const result = await provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps });
    expect(result).toEqual(accepted
      ? timestamps.slice(0, available).map((timestamp) => ({ timestamp, price: 0.97 }))
      : null);
  });

  it("counts unresolved blocks against historical coverage instead of publishing a selective sample", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) =>
      timestamp >= timestamps[3] ? null : timestamp,
    );
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => 0.97,
    });

    await expect(provider.fetchHistoricalPrices!(meta, { candidateTimestamps: timestamps })).resolves.toBeNull();
  });

  it("normalizes timestamps and reuses one block quote so duplicate points cannot change the rate", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    let reads = 0;
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => ++reads === 1 ? 0.97 : 1.03,
    });

    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: [timestamps[1], 0, Number.NaN, timestamps[0], timestamps[1], -1],
    })).resolves.toEqual([
      { timestamp: timestamps[0], price: 0.97 },
      { timestamp: timestamps[1], price: 0.97 },
    ]);
  });

  it("returns unavailable history for an empty request and honors cancellation without synthesizing prices", async () => {
    const provider = createProtocolRedeemProvider({
      stablecoinId: meta.id,
      fetchLiveQuote: async () => null,
      fetchHistoricalQuote: async () => 1,
    });
    await expect(provider.fetchHistoricalPrices!(meta, { candidateTimestamps: [] })).resolves.toBeNull();

    const controller = new AbortController();
    const error = new Error("historical replay cancelled");
    controller.abort(error);
    await expect(provider.fetchHistoricalPrices!(meta, {
      candidateTimestamps: timestamps, signal: controller.signal,
    })).rejects.toBe(error);
  });
});
