import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_SOURCE,
  FRED_TBILL_CSV_URL,
  TREASURY_YIELD_XML_URL,
  RISK_FREE_RATE_FALLBACK,
} from "../../lib/constants";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(),
}));

import { fetchTbillRate, parseTreasuryYieldXml } from "../fetch-tbill-rate";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getCache, setCache } from "../../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";

const TREASURY_XML_SNIPPET = `<QR_BC_CM><LIST_G_WEEK_OF_MONTH>
<G_WEEK_OF_MONTH><LIST_G_NEW_DATE>
<G_NEW_DATE><LIST_G_BC_CAT><G_BC_CAT>
<BC_3MONTH>3.71</BC_3MONTH>
</G_BC_CAT></LIST_G_BC_CAT><NEW_DATE>03-12-2026</NEW_DATE></G_NEW_DATE>
<G_NEW_DATE><LIST_G_BC_CAT><G_BC_CAT>
<BC_3MONTH>3.72</BC_3MONTH>
</G_BC_CAT></LIST_G_BC_CAT><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>
</LIST_G_NEW_DATE></G_WEEK_OF_MONTH>
</LIST_G_WEEK_OF_MONTH></QR_BC_CM>`;

function mockByUrl(mapping: Record<string, Response | null>) {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
    for (const [pattern, response] of Object.entries(mapping)) {
      if (url.includes(pattern)) return response;
    }
    return null;
  });
}

describe("fetchTbillRate", () => {
  const db = {} as D1Database;

  function latestCachePayload() {
    const calls = vi.mocked(setCache).mock.calls;
    const call = calls[calls.length - 1];
    expect(call?.[1]).toBe("risk_free_rate");
    return JSON.parse(String(call?.[2])) as {
      rate: number;
      source: string;
      fallbackMode: string | null;
      isFallback: boolean;
      recordDate: string | null;
    };
  }

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(undefined);
  });

  it("returns degraded when circuit is already open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("circuit-open");
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "circuit-open",
      isFallback: true,
    });
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns ok from FRED data", async () => {
    mockByUrl({
      "fred.stlouisfed.org": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.source).toBe("fred-dgs3mo");
    expect(metadata.rate).toBe(3.72);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: null,
      isFallback: false,
      recordDate: "2026-03-02",
    });
  });

  it("falls back to Treasury XML when FRED fails", async () => {
    mockByUrl({
      "fred.stlouisfed.org": null,
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.source).toBe("treasury-yield-xml");
    expect(metadata.rate).toBe(3.72);
    expect(metadata.fallbackMode).toBe("fred-failed-treasury-ok");
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "treasury-yield-xml",
      fallbackMode: null,
      isFallback: false,
      recordDate: "2026-03-13",
    });
  });

  it("falls back to Treasury XML when FRED returns invalid data", async () => {
    mockByUrl({
      "fred.stlouisfed.org": new Response("DATE,DGS3MO\n2026-03-02,.\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.source).toBe("treasury-yield-xml");
    expect(metadata.rate).toBe(3.72);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
  });

  it("returns degraded when both sources fail", async () => {
    mockByUrl({
      "fred.stlouisfed.org": null,
      "home.treasury.gov": null,
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("all-sources-failed");
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "all-sources-failed",
      isFallback: true,
    });
  });

  it("retains last known good rate when both sources fail", async () => {
    mockByUrl({
      "fred.stlouisfed.org": null,
      "home.treasury.gov": null,
    });
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        rate: 3.91,
        recordDate: "2026-03-07",
        fetchedAt: 1773100800,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
      }),
      updatedAt: 1773100800,
    } as never);

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("all-sources-failed-retained");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.91,
      source: "fred-dgs3mo",
      fallbackMode: "all-sources-failed-retained",
      isFallback: false,
      recordDate: "2026-03-07",
    });
  });
});

describe("parseTreasuryYieldXml", () => {
  it("extracts the latest BC_3MONTH rate and date", () => {
    const result = parseTreasuryYieldXml(TREASURY_XML_SNIPPET);
    expect(result).toEqual({ recordDate: "2026-03-13", rate: 3.72 });
  });

  it("returns null for empty or non-XML input", () => {
    expect(parseTreasuryYieldXml("")).toBeNull();
    expect(parseTreasuryYieldXml("not xml at all")).toBeNull();
  });

  it("returns null when BC_3MONTH is missing", () => {
    const xml = `<G_NEW_DATE><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>`;
    expect(parseTreasuryYieldXml(xml)).toBeNull();
  });

  it("skips entries with invalid rates", () => {
    const xml = `<G_NEW_DATE><BC_3MONTH>NaN</BC_3MONTH><NEW_DATE>03-12-2026</NEW_DATE></G_NEW_DATE>
<G_NEW_DATE><BC_3MONTH>3.65</BC_3MONTH><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>`;
    const result = parseTreasuryYieldXml(xml);
    expect(result).toEqual({ recordDate: "2026-03-13", rate: 3.65 });
  });
});
