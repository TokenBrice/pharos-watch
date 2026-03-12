import { describe, expect, it } from "vitest";
import { normalizeDefiLlamaDetailBody } from "../stablecoin-detail/defillama";

describe("normalizeDefiLlamaDetailBody", () => {
  it("materializes native and USD supply fields for non-USD pegs without mutating raw circulating", () => {
    const body = JSON.stringify({
      price: 1.25,
      tokens: [
        {
          circulating: {
            peggedEUR: 80,
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
          totalCirculating: {
            peggedEUR: 80,
          },
          totalCirculatingUSD: {
            peggedEUR: 100,
          },
          circulating: {
            peggedEUR: 80,
          },
        },
      ],
    });
  });

  it("materializes consistent fields for USD pegs", () => {
    const body = JSON.stringify({
      price: 0.99,
      tokens: [
        {
          circulating: { peggedUSD: 100 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "USD" },
        }),
      ),
    ).toEqual({
      price: 0.99,
      tokens: [
        {
          totalCirculatingUSD: { peggedUSD: 100 },
          totalCirculating: { peggedUSD: 100 },
          circulating: { peggedUSD: 100 },
        },
      ],
    });
  });

  it("derives native units from USD totals when non-USD payload only exposes totalCirculatingUSD", () => {
    const body = JSON.stringify({
      price: 2,
      tokens: [
        {
          totalCirculatingUSD: { peggedEUR: 120 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "EUR" },
        }),
      ),
    ).toEqual({
      price: 2,
      tokens: [
        {
          totalCirculatingUSD: { peggedEUR: 120 },
          totalCirculating: { peggedEUR: 60 },
        },
      ],
    });
  });

  it("throws for invalid upstream JSON", () => {
    expect(() => normalizeDefiLlamaDetailBody("{", { flags: { pegCurrency: "EUR" } })).toThrow();
  });
});
