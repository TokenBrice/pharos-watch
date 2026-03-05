import { describe, expect, it } from "vitest";
import { normalizeDefiLlamaDetailBody } from "../stablecoin-detail/defillama";

describe("normalizeDefiLlamaDetailBody", () => {
  it("normalizes non-USD peg circulating values into USD", () => {
    const body = JSON.stringify({
      price: 1.25,
      tokens: [
        {
          totalCirculatingUSD: {
            peggedEUR: 100,
            peggedUSD: 50,
          },
          circulating: {
            peggedEUR: 80,
            peggedUSD: 20,
          },
        },
      ],
    });

    const normalized = normalizeDefiLlamaDetailBody(body, {
      flags: { pegCurrency: "EUR" },
    });

    expect(JSON.parse(normalized)).toEqual({
      price: 1.25,
      tokens: [
        {
          totalCirculatingUSD: {
            peggedEUR: 125,
            peggedUSD: 50,
          },
          circulating: {
            peggedEUR: 100,
            peggedUSD: 20,
          },
        },
      ],
    });
  });

  it("returns unchanged payload for USD pegs", () => {
    const body = JSON.stringify({
      price: 0.99,
      tokens: [
        {
          totalCirculatingUSD: { peggedUSD: 100 },
          circulating: { peggedUSD: 100 },
        },
      ],
    });

    expect(
      normalizeDefiLlamaDetailBody(body, {
        flags: { pegCurrency: "USD" },
      }),
    ).toBe(body);
  });

  it("throws for invalid upstream JSON", () => {
    expect(() => normalizeDefiLlamaDetailBody("{", { flags: { pegCurrency: "EUR" } })).toThrow();
  });
});
