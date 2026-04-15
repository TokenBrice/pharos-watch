import { describe, it, expect } from "vitest";
import { adaptChainlinkPorResponse, type ChainlinkPorParams } from "../chainlink-por";

describe("adaptChainlinkPorResponse", () => {
  const params: ChainlinkPorParams = {
    porFeedAddress: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
    assetLabel: "USD Cash Reserves",
    assetRisk: "very-low",
  };

  it("returns single 100% slice with configured label and risk", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toEqual({
      name: "USD Cash Reserves",
      pct: 100,
      risk: "very-low",
    });
  });

  it("includes metadata with reserves and feed info", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        raw: 144_000_000_000_000_000_000_000_000n,
        decimals: 18,
        tokenAddress: "0x0000000000000000000000000000000000000001",
      },
    );
    expect(result.metadata?.totalReservesRaw).toBe("145000000000");
    expect(result.metadata?.feedDecimals).toBe(8);
    expect(result.metadata?.feedRoundId).toBe("42");
    expect(result.metadata?.feedUpdatedAt).toBe(1710000000);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1450,
      supplyUsd: 144_000_000,
      supplyRaw: "144000000000000000000000000",
      supplyDecimals: 18,
      supplyTokenAddress: "0x0000000000000000000000000000000000000001",
    });
  });

  it("degrades when reserves do not cover same-chain token supply", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 99_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
      {
        raw: 1000_000000000000000000n,
        decimals: 18,
        tokenAddress: "0x0000000000000000000000000000000000000001",
      },
    );

    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings?.[0]).toMatchObject({
      code: "por-reserve-under-supply",
      effect: "degraded",
    });
  });

  it("throws on zero reserves", () => {
    expect(() =>
      adaptChainlinkPorResponse(
        { reserves: 0n, decimals: 8, roundId: 1n, updatedAt: 1710000000 },
        params,
      ),
    ).toThrow();
  });
});
