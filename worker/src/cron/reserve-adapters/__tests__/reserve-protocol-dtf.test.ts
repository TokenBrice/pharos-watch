import { describe, expect, it } from "vitest";
import { adaptReserveProtocolDtfRows } from "../reserve-protocol-dtf";

const coin = {
  id: "usd3-reserve-protocol",
  symbol: "USD3",
  contracts: [
    { chain: "ethereum", address: "0x0d86883faf4ffd7aeb116390af37746f45b6f378", decimals: 18 },
  ],
};

describe("reserve-protocol-dtf adapter", () => {
  it("maps reviewed basket components by address and preserves unverified freshness", () => {
    const result = adaptReserveProtocolDtfRows(
      [
        {
          address: "0x0d86883FAf4FfD7aEb116390af37746F45b6f378",
          name: "Web 3 Dollar",
          symbol: "USD3",
          price: 1.09,
          marketCap: 4_500_000,
          chainId: 1,
          status: "active",
          basket: [
            { address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", symbol: "sUSDS", name: "Savings USDS", weight: "50" },
            { address: "0x27F2f159Fe990Ba83D57f39Fd69661764BEbf37a", symbol: "wcUSDCv3", name: "Wrapped cUSDCv3", weight: "50" },
          ],
        },
      ],
      coin as never,
      [
        {
          address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
          name: "Savings USDS",
          risk: "low",
          coinId: "susds-sky",
          depType: "collateral",
        },
        {
          address: "0x27F2f159Fe990Ba83D57f39Fd69661764BEbf37a",
          name: "Wrapped Compound USDCv3",
          risk: "medium",
          coinId: "usdc-circle",
          depType: "wrapper",
        },
      ],
      "https://api.reserve.org/discover/dtfs",
    );

    expect(result.slices).toEqual([
      { name: "Savings USDS", pct: 50, risk: "low", coinId: "susds-sky", depType: "collateral" },
      { name: "Wrapped Compound USDCv3", pct: 50, risk: "medium", coinId: "usdc-circle", depType: "wrapper" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.unknownExposurePct).toBe(0);
  });

  it("degrades material unmapped basket exposure", () => {
    const result = adaptReserveProtocolDtfRows(
      [
        {
          address: "0x0d86883faf4ffd7aeb116390af37746f45b6f378",
          symbol: "USD3",
          basket: [
            { address: "0x0000000000000000000000000000000000000001", symbol: "UNKNOWN", weight: 100 },
          ],
        },
      ],
      coin as never,
      [],
      "https://api.reserve.org/discover/dtfs",
    );

    expect(result.slices[0]).toMatchObject({
      name: "Unmapped Reserve Protocol DTF asset: UNKNOWN",
      risk: "high",
      pct: 100,
    });
    expect(result.warnings?.[0]).toMatchObject({
      code: "reserve-protocol-dtf-unknown-component",
      effect: "degraded",
    });
  });
});
