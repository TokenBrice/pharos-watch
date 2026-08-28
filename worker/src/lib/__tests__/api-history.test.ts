import { describe, expect, it, vi } from "vitest";
import {
  handleStablecoinHistoryRequest,
  parseStablecoinHistoryQuery,
} from "../api-history";

describe("parseStablecoinHistoryQuery", () => {
  it("returns 400 with stable message when stablecoin is missing", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 404 with stable message when stablecoin ID is unknown", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=DROP TABLE"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("applies endpoint-specific defaults and keeps legacy clamp behavior unless reject mode is requested", () => {
    const bounded = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=9999"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    if (bounded instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(bounded.days).toBe(1825);

    const withDefault = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether"),
      { defaultDays: 90, minDays: 1, maxDays: 365 },
    );
    if (withDefault instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(withDefault.days).toBe(90);
  });

  it("rejects out-of-range days when a public endpoint opts into reject mode", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=9999"),
      { defaultDays: 90, minDays: 1, maxDays: 365, rangePolicy: "reject" },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid days: must be between 1 and 365" });
  });

  it("returns 400 when days is malformed", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=abc"),
      { defaultDays: 90, minDays: 1, maxDays: 365 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid days: must be a number" });
  });
});

describe("handleStablecoinHistoryRequest", () => {
  it("returns mapped history with cache and extra headers when freshness is omitted", async () => {
    const db = {} as D1Database;
    const fetchRows = vi.fn(async () => [
      { timestamp: 100, value: 1.25 },
      { timestamp: 200, value: 1.5 },
    ]);

    const response = await handleStablecoinHistoryRequest(
      db,
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=30"),
      {
        query: { defaultDays: 90, minDays: 1, maxDays: 365, rangePolicy: "reject" },
        cacheControl: "public, max-age=300",
        fetchRows,
        mapRow: (row) => ({ at: row.timestamp, value: row.value }),
        buildHeaders: ({ stablecoinId, history }) => ({
          "X-Stablecoin-Id": stablecoinId,
          "X-History-Count": String(history.length),
        }),
      },
    );

    expect(fetchRows).toHaveBeenCalledWith(expect.objectContaining({
      db,
      stablecoinId: "usdt-tether",
      cutoff: expect.any(Number),
    }));
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("X-Stablecoin-Id")).toBe("usdt-tether");
    expect(response.headers.get("X-History-Count")).toBe("2");
    expect(await response.json()).toEqual([
      { at: 100, value: 1.25 },
      { at: 200, value: 1.5 },
    ]);
  });

  it("adds freshness headers when the handler supplies updatedAt metadata", async () => {
    const nowSec = 1_765_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    try {
      const response = await handleStablecoinHistoryRequest(
        {} as D1Database,
        new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=7"),
        {
          query: { defaultDays: 365, minDays: 1, maxDays: 1825, rangePolicy: "reject" },
          cacheControl: "public, max-age=60",
          fetchRows: async () => [{ timestamp: nowSec - 5, value: 100 }],
          mapRow: (row) => row,
          freshness: ({ stablecoinId, cutoff, rows, history }) => {
            expect(stablecoinId).toBe("usdt-tether");
            expect(cutoff).toBe(nowSec - 7 * 86_400);
            expect(rows).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
            expect(history).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
            return {
              updatedAt: nowSec - 10,
              maxAgeSec: 60,
            };
          },
        },
      );

      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(response.headers.get("X-Data-Age")).toBe("10");
      expect(response.headers.get("Warning")).toBeNull();
      expect(await response.json()).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
