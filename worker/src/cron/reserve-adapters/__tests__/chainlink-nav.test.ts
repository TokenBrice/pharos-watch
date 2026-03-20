import { describe, it, expect } from "vitest";
import { parseChainlinkLatestRoundData } from "../chainlink";
import { adaptChainlinkNavResponse, type ChainlinkNavParams } from "../chainlink-nav";

describe("adaptChainlinkNavResponse", () => {
  const params: ChainlinkNavParams = {
    oracleAddress: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53",
    tokenAddress: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
    assetLabel: "U.S. Treasury Bills",
    assetRisk: "very-low",
  };

  it("returns single 100% slice", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toBe("U.S. Treasury Bills");
  });

  it("calculates AUM in metadata", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    // NAV = 1.119, Supply = 500
    expect(result.metadata?.navPerToken).toBe("1.119");
    expect(result.metadata?.totalSupplyFormatted).toBe("500");
  });

  it("throws on zero NAV", () => {
    expect(() =>
      adaptChainlinkNavResponse(
        { navPerToken: 0n, navDecimals: 6, totalSupply: 500n, tokenDecimals: 6, roundId: 1n, updatedAt: 0 },
        params,
      ),
    ).toThrow();
  });
});

describe("parseChainlinkLatestRoundData", () => {
  const validHex = "0x"
    + "0000000000000000000000000000000000000000000000000000000000000001" // roundId
    + "000000000000000000000000000000000000000000000000000000003b9aca00" // answer (1e9)
    + "0000000000000000000000000000000000000000000000000000000065a8f000" // startedAt
    + "0000000000000000000000000000000000000000000000000000000065a8f100" // updatedAt
    + "0000000000000000000000000000000000000000000000000000000000000001"; // answeredInRound

  it("parses a valid 5-word hex response", () => {
    const result = parseChainlinkLatestRoundData(validHex, "test");
    expect(result.roundId).toBe(1n);
    expect(result.answer).toBe(1_000_000_000n);
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("throws on short hex response (< 256 chars)", () => {
    const shortHex = "0x" + "00".repeat(80); // 160 hex chars
    expect(() => parseChainlinkLatestRoundData(shortHex, "test")).toThrow("too short");
  });

  it("throws on zero answer", () => {
    const zeroAnswer = "0x"
      + "0000000000000000000000000000000000000000000000000000000000000001"
      + "0000000000000000000000000000000000000000000000000000000000000000" // answer = 0
      + "0000000000000000000000000000000000000000000000000000000065a8f000"
      + "0000000000000000000000000000000000000000000000000000000065a8f100"
      + "0000000000000000000000000000000000000000000000000000000000000001";
    expect(() => parseChainlinkLatestRoundData(zeroAnswer, "test")).toThrow("non-positive answer");
  });

  it("throws on zero updatedAt", () => {
    const zeroUpdatedAt = "0x"
      + "0000000000000000000000000000000000000000000000000000000000000001"
      + "000000000000000000000000000000000000000000000000000000003b9aca00"
      + "0000000000000000000000000000000000000000000000000000000065a8f000"
      + "0000000000000000000000000000000000000000000000000000000000000000" // updatedAt = 0
      + "0000000000000000000000000000000000000000000000000000000000000001";
    expect(() => parseChainlinkLatestRoundData(zeroUpdatedAt, "test")).toThrow("non-positive updatedAt");
  });
});
