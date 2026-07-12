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

  it("keeps DefiLlama casing variants in canonical chain buckets", () => {
    const canonical = canonicalizeChainCirculating({
      XDC: {
        current: 10,
        circulatingPrevDay: 9,
        circulatingPrevWeek: 8,
        circulatingPrevMonth: 7,
      },
      "ZKsync Era": {
        current: 20,
        circulatingPrevDay: 19,
        circulatingPrevWeek: 18,
        circulatingPrevMonth: 17,
      },
      Abcore: {
        current: 30,
        circulatingPrevDay: 29,
        circulatingPrevWeek: 28,
        circulatingPrevMonth: 27,
      },
      "edgeX L1": {
        current: 40,
        circulatingPrevDay: 39,
        circulatingPrevWeek: 38,
        circulatingPrevMonth: 37,
      },
    });

    expect(canonical.get("xdc")?.current).toBe(10);
    expect(canonical.get("zksync")?.current).toBe(20);
    expect(canonical.get("abcore")?.current).toBe(30);
    expect(canonical.get("edgechain")?.current).toBe(40);
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

  it("does not propagate invalid supply values from loose callers", () => {
    const canonical = canonicalizeChainCirculating({
      Ethereum: {
        current: Number.NaN,
        circulatingPrevDay: -1,
        circulatingPrevWeek: Number.POSITIVE_INFINITY,
        circulatingPrevMonth: 4,
      },
      ethereum: {
        current: 2,
        circulatingPrevDay: 3,
        circulatingPrevWeek: 4,
        circulatingPrevMonth: Number.NEGATIVE_INFINITY,
      },
    });

    expect(canonical.get("ethereum")).toEqual({
      current: 2,
      circulatingPrevDay: 3,
      circulatingPrevWeek: 4,
      circulatingPrevMonth: 4,
    });
  });

  it("keeps alias accumulation finite when numeric addition overflows", () => {
    const canonical = canonicalizeChainCirculating({
      hyperliquid: { current: Number.MAX_VALUE },
      "hyperliquid-l1": { current: Number.MAX_VALUE },
    });

    expect(canonical.get("hyperliquid")?.current).toBe(Number.MAX_VALUE);
  });
});
