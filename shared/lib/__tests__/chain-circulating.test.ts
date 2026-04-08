import { describe, expect, it } from "vitest";
import {
  canonicalizeChainCirculating,
  findCanonicalChainData,
  type RawChainCirculating,
} from "../chain-circulating";

describe("chain-circulating", () => {
  it("canonicalizes aliases into one chain bucket", () => {
    const chainCirculating: RawChainCirculating = {
      hyperliquid: {
        current: 60,
        circulatingPrevDay: 55,
        circulatingPrevWeek: 50,
        circulatingPrevMonth: 45,
      },
      "hyperliquid-l1": {
        current: 40,
        circulatingPrevDay: 35,
        circulatingPrevWeek: 30,
        circulatingPrevMonth: 25,
      },
    };

    const canonical = canonicalizeChainCirculating(chainCirculating);
    expect(canonical.get("hyperliquid")).toEqual({
      current: 100,
      circulatingPrevDay: 90,
      circulatingPrevWeek: 80,
      circulatingPrevMonth: 70,
    });
  });

  it("finds canonical chain data for display-name inputs", () => {
    const chainCirculating: RawChainCirculating = {
      Ethereum: {
        current: 120,
        circulatingPrevDay: 110,
        circulatingPrevWeek: 100,
        circulatingPrevMonth: 90,
      },
    };

    expect(findCanonicalChainData(chainCirculating, "ethereum")).toEqual({
      current: 120,
      circulatingPrevDay: 110,
      circulatingPrevWeek: 100,
      circulatingPrevMonth: 90,
    });

    expect(
      findCanonicalChainData(
        {
          "Citrea Mainnet": {
            current: 42,
            circulatingPrevDay: 41,
            circulatingPrevWeek: 40,
            circulatingPrevMonth: 39,
          },
        },
        "citrea",
      ),
    ).toEqual({
      current: 42,
      circulatingPrevDay: 41,
      circulatingPrevWeek: 40,
      circulatingPrevMonth: 39,
    });
  });

  it("drops unknown chain keys", () => {
    const chainCirculating: RawChainCirculating = {
      "totally-unknown-chain": {
        current: 99,
        circulatingPrevDay: 88,
        circulatingPrevWeek: 77,
        circulatingPrevMonth: 66,
      },
    };

    expect(canonicalizeChainCirculating(chainCirculating).size).toBe(0);
    expect(findCanonicalChainData(chainCirculating, "ethereum")).toBeNull();
  });
});
