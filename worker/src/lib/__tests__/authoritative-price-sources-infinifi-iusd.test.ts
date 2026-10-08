import { beforeEach, describe, expect, it } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  makeHistoricalMeta,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
} from "./authoritative-price-sources.test-support";
import { encodeUint256 } from "../evm-selectors";
import { iusdInfinifiProvider } from "../authoritative-price-sources/infinifi-iusd";

describe("iusdInfinifiProvider", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  it("converts six-decimal USDC settlement for an eighteen-decimal receipt into the live USD quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${encodeUint256(973_456n)}`);

    await expect(iusdInfinifiProvider.fetchLivePrice!(
      asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
      { assetsById: new Map() },
    )).resolves.toEqual({ price: 0.973456, source: "protocol-redeem", confidence: "high" });
  });

  it("publishes different historical receipt conversion rates at their requested blocks", async () => {
    const firstTimestamp = 1_710_000_000;
    const secondTimestamp = firstTimestamp + 3_600;
    resolveClosestBlockAtOrBeforeTimestampMock.mockImplementation(async (_chain, timestamp) =>
      timestamp === firstTimestamp ? 22_874_100 : 22_874_400,
    );
    fetchEvmCallHexAtBlockMock.mockImplementation(async (_chain, _target, _calldata, block) =>
      `0x${encodeUint256(block === 22_874_100 ? 973_456n : 987_654n)}`,
    );

    await expect(iusdInfinifiProvider.fetchHistoricalPrices!(
      makeHistoricalMeta("iusd-infinifi", "infiniFi USD", "iUSD"),
      { candidateTimestamps: [secondTimestamp, firstTimestamp] },
    )).resolves.toEqual([
      { timestamp: firstTimestamp, price: 0.973456 },
      { timestamp: secondTimestamp, price: 0.987654 },
    ]);
  });

  it.each([null, "0x1234", `0x${encodeUint256(0n)}`, `0x${"g".repeat(64)}`])(
    "returns no price for an unavailable, malformed or zero conversion (%s)",
    async (result) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValue(result);
      await expect(iusdInfinifiProvider.fetchLivePrice!(
        asset("iusd-infinifi"), { assetsById: new Map() },
      )).resolves.toBeNull();
    },
  );

  it("does not fabricate a quote when the redeem controller cannot be read", async () => {
    const error = new Error("redeem controller unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    await expect(iusdInfinifiProvider.fetchLivePrice!(
      asset("iusd-infinifi"), { assetsById: new Map() },
    )).rejects.toBe(error);
  });
});
