import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_SOURCE,
  FRED_FETCH_MAX_RETRIES,
  FRED_FETCH_TIMEOUT_MS,
  RISK_FREE_RATE_FALLBACK,
} from "../../lib/constants";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual("../../lib/db");
  return {
    ...actual,
    setCache: vi.fn(),
  };
});

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(),
}));

import { fetchTbillRate } from "../fetch-tbill-rate";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { setCache } from "../../lib/db";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";

describe("fetchTbillRate", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
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
    expect(setCache).toHaveBeenCalledWith(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns ok from FRED data", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
    );

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.source).toBe("fred-dgs3mo");
    expect(metadata.rate).toBe(3.72);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    expect(setCache).toHaveBeenCalledWith(db, "risk_free_rate", "3.72");
    expect(fetchWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.any(Object) }),
      FRED_FETCH_MAX_RETRIES,
      { timeoutMs: FRED_FETCH_TIMEOUT_MS },
    );
  });

  it("returns degraded on FRED API error", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("fred-api-error");
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    expect(setCache).toHaveBeenCalledWith(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
  });

  it("returns degraded when FRED data has no valid numeric row", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response("DATE,DGS3MO\n2026-03-02,.\n", { status: 200 }),
    );

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("fred-invalid-data");
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    expect(setCache).toHaveBeenCalledWith(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
  });
});
