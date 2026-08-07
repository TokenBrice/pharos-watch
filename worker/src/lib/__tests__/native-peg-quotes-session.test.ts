import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import {
  createNativePegQuoteSession,
  fetchCurrentNativePegQuotes,
} from "../native-peg-quotes";
import type { PricingProviderAttemptDiagnostic } from "../pricing-provider-diagnostics";

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("still records per-caller diagnostics when a batch is reused", async () => {
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse(EUR_PAYLOAD));
    const session = createNativePegQuoteSession();
    const diagnostics: PricingProviderAttemptDiagnostic[] = [];

    await fetchCurrentNativePegQuotes(
      EUR_REQUESTS,
      undefined,
      undefined,
      { diagnostics, stage: "fallback" },
      session,
    );
    await fetchCurrentNativePegQuotes(
      EUR_REQUESTS,
      undefined,
      undefined,
      { diagnostics, stage: "depeg-confirmation" },
      session,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ stage: "fallback", ok: true, success: true, status: 200 });
    expect(diagnostics[1]).toMatchObject({ stage: "depeg-confirmation", ok: true, success: true, status: 200 });
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
