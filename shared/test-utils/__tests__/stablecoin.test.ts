import { describe, expect, it } from "vitest";
import { makeAltPegCoin, makeStablecoin } from "../stablecoin";

describe("makeStablecoin", () => {
  it("keeps the default supply bucket aligned with an overridden peg type", () => {
    expect(makeStablecoin({ pegType: "peggedEUR" }).circulating).toEqual({ peggedEUR: 1_000_000 });
  });
});

describe("makeAltPegCoin", () => {
  it("uses the supplied identity and USD supply for alt-peg market fixtures", () => {
    expect(makeAltPegCoin("eurc-circle", 55_000_000)).toMatchObject({
      id: "eurc-circle",
      name: "eurc-circle",
      symbol: "EURC-CIRCLE",
      pegMechanism: "",
      supplySource: "test",
      circulating: { usd: 55_000_000 },
    });
  });
});
