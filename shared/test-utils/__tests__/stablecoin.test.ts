import { describe, expect, it } from "vitest";
import { makeStablecoin } from "../stablecoin";

describe("makeStablecoin", () => {
  it("keeps the default supply bucket aligned with an overridden peg type", () => {
    expect(makeStablecoin({ pegType: "peggedEUR" }).circulating).toEqual({ peggedEUR: 1_000_000 });
  });
});
