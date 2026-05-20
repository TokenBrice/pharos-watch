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

  it("overrides stale DefiLlama top-level address with the curated registry contract", () => {
    const body = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
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
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toMatchObject({
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
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
