import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

// The raw wrapper is deliberately its own spy rather than the JSON wrapper's
// base: one test asserts the JSON path never falls through to it.
const fetchRetryMocks = vi.hoisted(() => {
  const passthrough = async (url: string, opts?: RequestInit) => fetch(url, opts);
  return { passthrough, fetchWithRetry: vi.fn(passthrough) };
});

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchRetryMocks.fetchWithRetry,
  fetchJsonWithRetry: mockFetchRetry({ failureAsNull: true }).fetchJsonWithRetry,
}));

import { fetchJsonWithRetry } from "../../lib/fetch-retry";

function resetFetchRetryMocks(): void {
  fetchRetryMocks.fetchWithRetry.mockReset().mockImplementation(fetchRetryMocks.passthrough);
  vi.mocked(fetchJsonWithRetry).mockClear();
}

import { loadExchangeRateApiPayload, loadSecondaryCurrencyCandidate } from "../sync-fx-rates-sources";

describe("syncFxRates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    resetFetchRetryMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads secondary and ExchangeRate-API fallback JSON through body-aware retry helpers", async () => {
    mockFetch([
      {
        match: "cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest",
        body: { date: "2025-06-15", usd: { cnh: 7.28 } },
      },
      {
        match: "latest.currency-api.pages.dev",
        body: { date: "2025-06-14", usd: { cnh: 7.29 } },
      },
      {
        match: "cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2025.6.15",
        body: { date: "2025-06-15", usd: { cnh: 7.27 } },
      },
      {
        match: "open.er-api.com",
        body: { result: "success", time_last_update_unix: 1_750_000_000, rates: { EUR: 0.92 } },
      },
    ]);
    fetchRetryMocks.fetchWithRetry.mockImplementation(async () => {
      throw new Error("raw fetchWithRetry JSON path should not be used");
    });

    const secondary = await loadSecondaryCurrencyCandidate();
    const tertiary = await loadExchangeRateApiPayload();

    expect(secondary?.endpoint).toBe("jsdelivr");
    expect(tertiary?.rates.EUR).toBe(0.92);
    expect(fetchRetryMocks.fetchWithRetry).not.toHaveBeenCalled();
    const jsonUrls = vi.mocked(fetchJsonWithRetry).mock.calls.map(([url]) => String(url));
    expect(jsonUrls).toEqual(expect.arrayContaining([
      expect.stringContaining("@fawazahmed0/currency-api@latest"),
      expect.stringContaining("latest.currency-api.pages.dev"),
      expect.stringContaining("@fawazahmed0/currency-api@2025.6.15"),
      expect.stringContaining("open.er-api.com"),
    ]));
  });

  it("fires all secondary FX mirror fetches concurrently", async () => {
    vi.useRealTimers();
    const callStartedAt: Record<string, number> = {};
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch([{ match: () => true, respond: async (request) => {
      const url = request.url;
      if (
        url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest")
        || (
          url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@")
          && !url.includes("@latest")
        )
        || url.includes("latest.currency-api.pages.dev")
      ) {
        const endpoint = url.includes("latest.currency-api.pages.dev")
          ? "pagesDev"
          : url.includes("@latest")
            ? "jsdelivrLatest"
            : "jsdelivrVersioned";
        callStartedAt[endpoint] = performance.now();
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight--;
        return new Response(
          JSON.stringify({ date: "2025-06-15", usd: { cnh: 7.28, rub: 90, uah: 41, ars: 1400, kgs: 87, ngn: 1370, xof: 560 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    } }]);

    await loadSecondaryCurrencyCandidate();

    expect(callStartedAt.jsdelivrLatest).toBeDefined();
    expect(callStartedAt.jsdelivrVersioned).toBeDefined();
    expect(callStartedAt.pagesDev).toBeDefined();
    expect(maxInFlight).toBe(3);
    expect(Math.abs(callStartedAt.jsdelivrLatest - callStartedAt.pagesDev)).toBeLessThan(20);
    expect(Math.abs(callStartedAt.jsdelivrLatest - callStartedAt.jsdelivrVersioned)).toBeLessThan(20);
  });

  it("uses the date-pinned jsdelivr package when @latest is behind", async () => {
    vi.setSystemTime(new Date("2026-05-20T07:30:00Z"));
    const fetchSpy = mockFetch([{ match: () => true, respond: async (request) => {
      const url = request.url;
      if (url.includes("@2026.5.20/")) {
        return new Response(
          JSON.stringify({ date: "2026-05-20", usd: { cnh: 7.18 } }),
          { status: 200 },
        );
      }
      if (url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest")) {
        return new Response(
          JSON.stringify({ date: "2025-05-19", usd: { cnh: 7.28 } }),
          { status: 200 },
        );
      }
      if (url.includes("latest.currency-api.pages.dev")) {
        return new Response(
          JSON.stringify({ date: "2025-05-19", usd: { cnh: 7.28 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    } }]);

    const candidate = await loadSecondaryCurrencyCandidate();

    expect(candidate?.endpoint).toBe("jsdelivr-versioned");
    expect(candidate?.payload.date).toBe("2026-05-20");
    expect(candidate?.payload.usd.cnh).toBe(7.18);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("@2026.5.20/"))).toBe(true);
  });

  it("ignores malformed optional date-pinned secondary FX payloads when other mirrors are healthy", async () => {
    vi.setSystemTime(new Date("2026-05-20T07:30:00Z"));
    mockFetch([{ match: () => true, respond: async (request) => {
      const url = request.url;
      if (url.includes("@2026.5.20/")) {
        return new Response("definitely not json", { status: 200 });
      }
      if (url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest")) {
        return new Response(
          JSON.stringify({ date: "2026-05-19", usd: { cnh: 7.28 } }),
          { status: 200 },
        );
      }
      if (url.includes("latest.currency-api.pages.dev")) {
        return new Response(
          JSON.stringify({ date: "2026-05-18", usd: { cnh: 7.29 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    } }]);

    const candidate = await loadSecondaryCurrencyCandidate();

    expect(candidate?.endpoint).toBe("jsdelivr");
    expect(candidate?.payload.date).toBe("2026-05-19");
    expect(candidate?.payload.usd.cnh).toBe(7.28);
  });
});
