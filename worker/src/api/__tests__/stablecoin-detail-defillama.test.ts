import { describe, expect, it, vi } from "vitest";
import { applyCuratedDetailAddress, normalizeDefiLlamaDetailBody } from "../stablecoin-detail/defillama";

describe("applyCuratedDetailAddress", () => {
  it("returns already-normalized cached bodies unchanged without parsing", () => {
    const curatedAddress = "0x57ab1e0003f623289cd798b1824be09a793e4bec";
    const body = JSON.stringify({
      price: 0.99,
      address: curatedAddress,
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      expect(
        applyCuratedDetailAddress(body, {
          contracts: [{ chain: "ethereum", address: curatedAddress, decimals: 18 }],
        }),
      ).toBe(body);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("adds the curated address to token-built cached bodies", () => {
    const body = JSON.stringify({
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });

    expect(
      JSON.parse(
        applyCuratedDetailAddress(body, {
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toEqual({
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
    });
  });

  it("overrides stale cached addresses when the curated address is absent", () => {
    const body = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });

    expect(
      JSON.parse(
        applyCuratedDetailAddress(body, {
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toEqual({
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });
  });
});

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

  it("strips the chainBalances blob while preserving other passthrough fields", () => {
    // chainBalances is ~98% of the upstream payload for large coins and once
    // pushed cached rows past D1's 2 MiB value cap (silently freezing them).
    const body = JSON.stringify({
      price: 1,
      pegMechanism: "fiat-backed",
      currentChainBalances: { Ethereum: { peggedUSD: 50 } },
      chainBalances: { Ethereum: { tokens: [{ date: 1, circulating: { peggedUSD: 100 } }] } },
      tokens: [{ totalCirculating: { peggedUSD: 100 } }],
    });

    const normalized = JSON.parse(
      normalizeDefiLlamaDetailBody(body, { flags: { pegCurrency: "USD" } }),
    ) as Record<string, unknown>;

    expect(normalized.chainBalances).toBeUndefined();
    expect(normalized.pegMechanism).toBe("fiat-backed");
    expect(normalized.currentChainBalances).toEqual({ Ethereum: { peggedUSD: 50 } });
  });

  it("strips chainBalances even when the payload has no tokens array", () => {
    const body = JSON.stringify({
      price: 1,
      chainBalances: { Ethereum: { tokens: [] } },
    });

    const normalized = JSON.parse(normalizeDefiLlamaDetailBody(body, undefined)) as Record<string, unknown>;

    expect(normalized.chainBalances).toBeUndefined();
    expect(normalized.price).toBe(1);
  });
});
