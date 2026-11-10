import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type * as FetchRetry from "../fetch-retry";

const fetchWithRetryMock = vi.fn();

vi.mock("../fetch-retry", async (importOriginal) => ({
  ...await importOriginal<typeof FetchRetry>(),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import {
  createNativePegQuoteSession,
  fetchCurrentNativePegQuotes,
  getNativePegQueryCurrencies,
  normalizeSupportedPegCurrency,
} from "../native-peg-quotes";
import type { PricingProviderAttemptDiagnostic } from "../pricing-provider-diagnostics";

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const T0 = 1_700_000_000;
const SLOW_FAN_OUT_SEC = 600;
let nowMs = T0 * 1000;

describe("native-peg-quotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithRetryMock.mockReset();
    nowMs = T0 * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });
  it("keeps over-cap native quote data unavailable", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));
    const quotes = await fetchCurrentNativePegQuotes([
      { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" },
    ]);
    expect(quotes.size).toBe(0);
  });


  it("normalizes supported fiat pegs and exposes CoinGecko query currencies", () => {
    expect(normalizeSupportedPegCurrency(" eur ")).toBe("EUR");
    expect(normalizeSupportedPegCurrency("gold")).toBeNull();
    expect(getNativePegQueryCurrencies("CNH")).toEqual(["cny", "cnh"]);
    expect(getNativePegQueryCurrencies("ARS")).toEqual(["ars"]);
    expect(getNativePegQueryCurrencies("BRL")).toEqual(["brl"]);
    expect(getNativePegQueryCurrencies("KGS")).toEqual([]);
    expect(getNativePegQueryCurrencies("NGN")).toEqual(["ngn"]);
    expect(getNativePegQueryCurrencies("XOF")).toEqual([]);
  });

  it("keeps every active non-USD peg covered by a native-peg mapping or exception", () => {
    // CoinGecko does not expose native vs-currency quotes for these registry labels.
    const intentionallyUnsupported: Record<string, true> = {
      COP: true,
      GHS: true,
      GOLD: true,
      KES: true,
      KGS: true,
      OTHER: true,
      PEN: true,
      SILVER: true,
      VAR: true,
      XOF: true,
    };

    for (const coin of ACTIVE_STABLECOINS) {
      const currency = coin.flags.pegCurrency;
      if (currency === "USD" || intentionallyUnsupported[currency]) continue;
      expect(getNativePegQueryCurrencies(currency), `${coin.id} (${currency})`).not.toHaveLength(0);
    }
  });

  it("fetches direct native quotes for supported non-USD fiat pegs", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse({
        "euro-coin": {
          eur: 1.0012,
          last_updated_at: 1_699_999_940,
        },
        "brz": {
          eur: 0.17,
          last_updated_at: 1_699_999_940,
        },
      }))
      .mockResolvedValueOnce(makeJsonResponse({
        "chilean-peso": {
          clp: 1.0001,
          last_updated_at: 1_699_999_940,
        },
      }));

    const quotes = await fetchCurrentNativePegQuotes([
      { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" },
      { stablecoinId: "wclp-ripio", geckoId: "chilean-peso", pegCurrency: "CLP" },
      { stablecoinId: "usdt-tether", geckoId: "tether", pegCurrency: "USD" },
    ]);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currencies=eur");
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("vs_currencies=clp");
    expect(quotes.get("eurc-circle")).toMatchObject({
      stablecoinId: "eurc-circle",
      geckoId: "euro-coin",
      pegCurrency: "EUR",
      vsCurrency: "eur",
      price: 1.0012,
      updatedAt: 1_699_999_940,
    });
    expect(quotes.get("wclp-ripio")).toMatchObject({
      stablecoinId: "wclp-ripio",
      geckoId: "chilean-peso",
      pegCurrency: "CLP",
      vsCurrency: "clp",
      price: 1.0001,
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

  it("records diagnostics for stale native quote responses", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      "euro-coin": {
        eur: 1.0012,
        last_updated_at: 1_699_900_000,
      },
    }));
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    const quotes = await fetchCurrentNativePegQuotes(
      [{ stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" }],
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
    );

    expect(quotes.size).toBe(0);
    expect(diagnostics[0]).toMatchObject({
      source: "native-peg",
      stage: "fallback",
      ok: true,
      success: false,
      rejectionReasonCounts: { stale: 1 },
    });
  });

  it("rejects future-dated native quote responses", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      "euro-coin": {
        eur: 1.0012,
        last_updated_at: 1_700_000_601,
      },
    }));
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    const quotes = await fetchCurrentNativePegQuotes(
      [{ stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" }],
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
    );

    expect(quotes.size).toBe(0);
    expect(diagnostics[0]).toMatchObject({
      source: "native-peg",
      stage: "fallback",
      ok: true,
      success: false,
      rejectionReasonCounts: { future: 1 },
    });
  });

  it("records diagnostics for failed native quote fetches", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    const quotes = await fetchCurrentNativePegQuotes(
      [{ stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" }],
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
    );

    expect(quotes.size).toBe(0);
    expect(diagnostics[0]).toMatchObject({
      source: "native-peg",
      status: 403,
      ok: false,
      success: false,
      snippet: "blocked",
      rejectionReasonCounts: { "non-ok": 1 },
    });
  });

  function mockSlowNativePegFanOut(jpyPrice: number, jpyLastUpdatedAt: number): void {
    fetchWithRetryMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("vs_currencies=eur")) {
        // A degraded provider: the first EUR batch consumes its timeouts, so
        // the JPY batch is read SLOW_FAN_OUT_SEC after the call started.
        nowMs = (T0 + SLOW_FAN_OUT_SEC) * 1000;
        return makeJsonResponse({
          "euro-coin": { eur: 1.0012, last_updated_at: T0 - 30 },
        });
      }
      return makeJsonResponse({
        "jpy-coin": { jpy: jpyPrice, last_updated_at: jpyLastUpdatedAt },
      });
    });
  }

  const mixedPegRequests = [
    { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" },
    { stablecoinId: "jpyc", geckoId: "jpy-coin", pegCurrency: "JPY" },
  ];

  it("measures freshness at each batch read time, not at fan-out start", async () => {
    // Read at T0+600, the quote is 200 s old: not future-dated, not stale.
    mockSlowNativePegFanOut(1.0004, T0 + 400);
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    const quotes = await fetchCurrentNativePegQuotes(
      mixedPegRequests,
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
    );

    expect(quotes.get("jpyc")).toMatchObject({ price: 1.0004, updatedAt: T0 + 400 });
    expect(diagnostics[1]).toMatchObject({ source: "native-peg", ok: true, success: true });
  });

  it("rejects a quote beyond the 30-minute budget at its batch read time", async () => {
    // Read at T0+600, the quote is 2350 s old: beyond DEPEG_PRIMARY_PRICE_MAX_AGE_SEC.
    mockSlowNativePegFanOut(0.9701, T0 - 1750);
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    const quotes = await fetchCurrentNativePegQuotes(
      mixedPegRequests,
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
    );

    expect(quotes.has("jpyc")).toBe(false);
    expect(diagnostics[1]).toMatchObject({
      source: "native-peg",
      ok: true,
      success: false,
      rejectionReasonCounts: { stale: 1 },
    });
  });
});

const EUR_PAYLOAD = {
  "euro-coin": { eur: 1.0012, last_updated_at: 1_699_999_940 },
  "stasis-eurs": { eur: 0.9987, last_updated_at: 1_699_999_940 },
};

const EUR_REQUESTS = [
  { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR" },
  { stablecoinId: "eurs-stasis", geckoId: "stasis-eurs", pegCurrency: "EUR" },
];

describe("native-peg quote session", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithRetryMock.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  it("fetches a shared batch once and returns identical quotes to both callers", async () => {
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();

    const first = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const second = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(second.get("eurc-circle")).toMatchObject({ price: 1.0012, vsCurrency: "eur" });
  });

  it("coalesces concurrent callers onto one in-flight batch", async () => {
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();

    const [first, second] = await Promise.all([
      fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session),
      fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session),
    ]);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("reuses a memoized batch that already covers a later caller's narrower id set", async () => {
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();

    await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const narrow = await fetchCurrentNativePegQuotes(
      [EUR_REQUESTS[1]],
      undefined,
      undefined,
      undefined,
      session,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(narrow.size).toBe(1);
    expect(narrow.get("eurs-stasis")).toMatchObject({ price: 0.9987, vsCurrency: "eur" });
  });

  it("fetches again for a different currency set", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse(EUR_PAYLOAD))
      .mockResolvedValueOnce(makeJsonResponse({
        "jpy-coin": { jpy: 1.0004, last_updated_at: 1_699_999_940 },
      }));
    const session = createNativePegQuoteSession();

    await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const jpy = await fetchCurrentNativePegQuotes(
      [{ stablecoinId: "jpyc", geckoId: "jpy-coin", pegCurrency: "JPY" }],
      undefined,
      undefined,
      undefined,
      session,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("vs_currencies=jpy");
    expect(jpy.get("jpyc")).toMatchObject({ price: 1.0004, vsCurrency: "jpy" });
  });

  it("fetches again when the same currency needs ids the memoized batch lacks", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse(EUR_PAYLOAD))
      .mockResolvedValueOnce(makeJsonResponse({
        "monerium-eur-money": { eur: 1.0, last_updated_at: 1_699_999_940 },
      }));
    const session = createNativePegQuoteSession();

    await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const other = await fetchCurrentNativePegQuotes(
      [{ stablecoinId: "eure-monerium", geckoId: "monerium-eur-money", pegCurrency: "EUR" }],
      undefined,
      undefined,
      undefined,
      session,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(other.get("eure-monerium")).toMatchObject({ price: 1.0 });
  });

  it("does not memoize non-ok responses, so a later caller retries", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response("blocked", { status: 403 }))
      .mockResolvedValueOnce(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();

    const blocked = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const recovered = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(blocked.size).toBe(0);
    expect(recovered.get("eurc-circle")).toMatchObject({ price: 1.0012 });
  });

  it("does not memoize transport failures, so a later caller retries", async () => {
    fetchWithRetryMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const failed = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);
    const recovered = await fetchCurrentNativePegQuotes(EUR_REQUESTS, undefined, undefined, undefined, session);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(failed.size).toBe(0);
    expect(recovered.get("eurc-circle")).toMatchObject({ price: 1.0012 });
  });

  it("leaves behavior unchanged when no session is supplied", async () => {
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse(EUR_PAYLOAD));

    await fetchCurrentNativePegQuotes(EUR_REQUESTS);
    await fetchCurrentNativePegQuotes(EUR_REQUESTS);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });
});
