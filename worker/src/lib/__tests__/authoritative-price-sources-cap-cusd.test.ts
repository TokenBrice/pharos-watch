import { beforeEach, describe, expect, it } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  makeHistoricalMeta,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
} from "./authoritative-price-sources.test-support";
import { capCusdProvider } from "../authoritative-price-sources/cap-cusd";

function quote(outputUsdcRaw: bigint): `0x${string}` {
  return `0x${outputUsdcRaw.toString(16).padStart(64, "0")}`;
}

const context = { assetsById: new Map() };

describe("capCusdProvider", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  it.each([
    { supply: 90_000, output: 980_000_000n },
    { supply: 100_000, output: 980_000_000n },
    { supply: 100_100, output: 980_980_000n },
    { supply: 2_500_000, output: 24_500_000_000n },
    { supply: 99_999_900, output: 979_999_020_000n },
    { supply: 100_000_000, output: 980_000_000_000n },
    { supply: 200_000_000, output: 980_000_000_000n },
  ])("decodes a supply-sized redemption quote at supply $supply", async ({ supply, output }) => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(output));

    await expect(capCusdProvider.fetchLivePrice!(
      asset("cusd-cap", { circulating: { peggedUSD: supply } }),
      context,
    )).resolves.toEqual({ price: 0.98, source: "protocol-redeem", confidence: "high" });
  });

  it("uses the bounded maximum quote when current supply is unavailable", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(980_000_000_000n));

    await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).resolves.toEqual({
      price: 0.98, source: "protocol-redeem", confidence: "high",
    });
  });

  it("sizes historical redemption from the nearest historical supply, not the current maximum", async () => {
    const timestamp = 1_710_000_000;
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValue(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(quote(1_960_000_000n));

    await expect(capCusdProvider.fetchHistoricalPrices!(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD"),
      {
        candidateTimestamps: [timestamp],
        supplySnapshots: [
          { ts: timestamp - 1_000, supply: 5_000_000 },
          { ts: timestamp + 100, supply: 200_000 },
        ],
      },
    )).resolves.toEqual([{ timestamp, price: 0.98 }]);
  });

  it.each([null, "0x", `0x${"0".repeat(64)}`, `0x${"z".repeat(64)}`])(
    "does not publish an unavailable, zero or malformed redemption quote (%s)",
    async (result) => {
      fetchEvmCallHexAtBlockMock.mockResolvedValue(result);
      await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).resolves.toBeNull();
    },
  );

  it("propagates an RPC failure rather than substituting a par price", async () => {
    const error = new Error("redemption RPC unavailable");
    fetchEvmCallHexAtBlockMock.mockRejectedValue(error);
    await expect(capCusdProvider.fetchLivePrice!(asset("cusd-cap"), context)).rejects.toBe(error);
  });
});
