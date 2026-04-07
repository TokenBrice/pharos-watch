import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import {
  fetchCurrentNativePegQuotes,
  getNativePegQueryCurrencies,
  getPreferredNativePegQueryCurrency,
  normalizeSupportedPegCurrency,
} from "../native-peg-quotes";

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("native-peg-quotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithRetryMock.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  it("normalizes supported fiat pegs and exposes CoinGecko query currencies", () => {
    expect(normalizeSupportedPegCurrency(" eur ")).toBe("EUR");
    expect(normalizeSupportedPegCurrency("gold")).toBeNull();
    expect(getNativePegQueryCurrencies("CNH")).toEqual(["cny", "cnh"]);
    expect(getPreferredNativePegQueryCurrency("CNH")).toBe("cny");
    expect(getPreferredNativePegQueryCurrency("BRL")).toBe("brl");
  });

  it("fetches direct native quotes for supported non-USD fiat pegs", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      "euro-coin": {
        eur: 1.0012,
        last_updated_at: 1_699_999_940,
      },
      "brz": {
        eur: 0.17,
        last_updated_at: 1_699_999_940,
      },
    }));

    const quotes = await fetchCurrentNativePegQuotes([
      { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" },
      { stablecoinId: "usdt-tether", geckoId: "tether", pegCurrency: "USD" },
    ]);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currencies=eur");
    expect(quotes.get("eurc-circle")).toMatchObject({
      stablecoinId: "eurc-circle",
      geckoId: "euro-coin",
      pegCurrency: "EUR",
      vsCurrency: "eur",
      price: 1.0012,
      updatedAt: 1_699_999_940,
    });
    expect(quotes.has("usdt-tether")).toBe(false);
  });

  it("falls through alternate CoinGecko query currencies for CNH/CNY-style pegs", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse({
        "anchorx": {
          last_updated_at: 1_699_999_940,
        },
      }))
      .mockResolvedValueOnce(makeJsonResponse({
        "anchorx": {
          cnh: 1.002,
          last_updated_at: 1_699_999_940,
        },
      }));

    const quotes = await fetchCurrentNativePegQuotes([
      { stablecoinId: "axcnh-anchorx", geckoId: "anchorx", pegCurrency: "CNH" },
    ]);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currencies=cny");
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("vs_currencies=cnh");
    expect(quotes.get("axcnh-anchorx")).toMatchObject({
      pegCurrency: "CNH",
      vsCurrency: "cnh",
      price: 1.002,
    });
  });
});
