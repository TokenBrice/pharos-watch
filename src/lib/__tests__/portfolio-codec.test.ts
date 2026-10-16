import { describe, expect, it } from "vitest";
import {
  encodePortfolioHoldings,
  migratePortfolioIds,
  parsePortfolioUrlParam,
} from "../portfolio-codec";
import type { PortfolioHolding } from "../portfolio-codec";

describe("portfolio codec", () => {
  it("parses and re-encodes canonical holdings", () => {
    const holdings = parsePortfolioUrlParam("usdc-circle:25,usdt-tether:75");

    expect(holdings).toEqual([
      { coinId: "usdc-circle", amount: 25 },
      { coinId: "usdt-tether", amount: 75 },
    ]);
    expect(encodePortfolioHoldings(holdings)).toBe("usdc-circle:25,usdt-tether:75");
  });

  it("accepts canonical ids and rejects non-canonical ones", () => {
    expect(parsePortfolioUrlParam("usdc-circle:25")).toEqual([
      { coinId: "usdc-circle", amount: 25 },
    ]);
    expect(parsePortfolioUrlParam("usdc:25")).toEqual([]);
    expect(parsePortfolioUrlParam("1:25")).toEqual([]);
    expect(parsePortfolioUrlParam("usdf:25")).toEqual([]);
  });

  it("merges duplicate canonical ids only", () => {
    expect(migratePortfolioIds([
      { coinId: "usdt-tether", amount: 10 },
      { coinId: "usdt-tether", amount: 40 },
      { coinId: "usdc-circle", amount: 50 },
    ])).toEqual([
      { coinId: "usdt-tether", amount: 50 },
      { coinId: "usdc-circle", amount: 50 },
    ]);
  });

  it("drops a coin whose duplicate amounts would overflow instead of emitting Infinity", () => {
    const maxAmount = Number.MAX_VALUE;
    expect(
      migratePortfolioIds([
        { coinId: "usdt-tether", amount: maxAmount },
        { coinId: "usdt-tether", amount: maxAmount },
      ]),
    ).toEqual([]);
    expect(parsePortfolioUrlParam(`usdt-tether:${maxAmount},usdt-tether:${maxAmount}`)).toEqual([]);
    expect(
      encodePortfolioHoldings([
        { coinId: "usdt-tether", amount: maxAmount },
        { coinId: "usdt-tether", amount: maxAmount },
      ]),
    ).toBe("");
  });

  it("merges duplicates without mutating caller-supplied holdings", () => {
    const first: PortfolioHolding = { coinId: "usdt-tether", amount: 10 };
    const second: PortfolioHolding = { coinId: "usdt-tether", amount: 40 };
    Object.freeze(first);
    Object.freeze(second);

    expect(migratePortfolioIds([first, second])).toEqual([{ coinId: "usdt-tether", amount: 50 }]);
    expect([first, second]).toEqual([
      { coinId: "usdt-tether", amount: 10 },
      { coinId: "usdt-tether", amount: 40 },
    ]);
  });

  it("drops non-canonical zero-amount draft holdings", () => {
    expect(migratePortfolioIds([
      { coinId: "not-a-coin", amount: 0 },
      { coinId: "usdt-tether", amount: 10 },
    ])).toEqual([
      { coinId: "usdt-tether", amount: 10 },
    ]);

    expect(encodePortfolioHoldings([{ coinId: "usdt-tether", amount: 0 }])).toBe("usdt-tether:0");
  });
});

describe("parsePortfolioUrlParam edge cases", () => {
  it("keeps zero amounts and filters invalid amounts", () => {
    const result = parsePortfolioUrlParam(
      "usdc-circle:0,usdt-tether:-5,dai-makerdao:Infinity,frax-frax:NaN,pyusd-paypal:1abc,lusd-liquity:1:2",
    );
    expect(result).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });
});
