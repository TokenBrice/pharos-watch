import { describe, expect, it } from "vitest";
import { buildHeldCardIds, parseUsdInput } from "./model";

describe("portfolio page model", () => {
  it("parses supported USD input formats", () => {
    expect(parseUsdInput("$1,234.50")).toBe(1234.5);
    expect(parseUsdInput("2500")).toBe(2500);
    expect(parseUsdInput("12abc")).toBe(0);
  });

  it("builds held card id sets from holdings", () => {
    expect(
      buildHeldCardIds([
        { coinId: "usdc-circle", amount: 10 },
        { coinId: "usdt-tether", amount: 20 },
      ]),
    ).toEqual(new Set(["usdc-circle", "usdt-tether"]));
  });
});
