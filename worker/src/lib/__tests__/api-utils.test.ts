import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  errorResponse,
  fetchPaginatedEvents,
  handleStablecoinHistoryRequest,
  parseClampedIntegerParam,
  parseFloatParam,
  parseIntParam,
  parseOptionalNonNegativeIntegerParam,
  parseOptionalEnumParam,
  parseOptionalPositiveIntegerParam,
  parseOptionalRequestJsonObject,
  parseEnumParam,
  parseRequiredStablecoinIdParam,
  parseQueryParams,
  parseStablecoinHistoryQuery,
  jsonResponse,
  jsonFreshResponse,
  validatePayloadWithSchema,
  buildCacheStatuses,
  readCachedJson,
} from "../api-utils";

describe("errorResponse", () => {
  it("returns JSON error with given status", async () => {
    const res = errorResponse(400, "Bad request");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Bad request" });
  });

  it("returns 503 for service unavailable", async () => {
    const res = errorResponse(503, "Data not yet available");
    expect(res.status).toBe(503);
  });
});

describe("readCachedJson", () => {
  it("returns missing when the cache row is absent", () => {
    expect(readCachedJson("status", "stablecoins", null)).toEqual({ status: "missing" });
  });

  it("returns parsed data for valid cached json", () => {
    expect(readCachedJson<{ ok: boolean }>("status", "stablecoins", {
      value: JSON.stringify({ ok: true }),
    })).toEqual({
      status: "ok",
      data: { ok: true },
    });
  });

  it("returns malformed when the cached json is invalid", () => {
    const result = readCachedJson("status", "stablecoins", { value: "{bad-json" });
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.message).toMatch(/Unexpected|JSON|Expected/i);
    }
  });
});

describe("parseIntParam", () => {
  it("returns default for null input", () => {
    expect(parseIntParam(null, 100, 1, 1000)).toBe(100);
  });

  it("returns default for undefined input", () => {
    expect(parseIntParam(undefined, 50, 1, 500)).toBe(50);
  });

  it("parses valid integer", () => {
    expect(parseIntParam("25", 100, 1, 1000)).toBe(25);
  });

  it("clamps below min", () => {
    expect(parseIntParam("-5", 100, 0, 1000)).toBe(0);
  });

  it("clamps above max", () => {
    expect(parseIntParam("9999", 100, 1, 500)).toBe(500);
  });

  it("rejects out-of-range integers when rangePolicy is reject", async () => {
    const result = parseIntParam("9999", 100, 1, 500, "limit", { rangePolicy: "reject" });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid limit: must be between 1 and 500" });
  });

  it("returns 400 response for malformed input", async () => {
    const result = parseIntParam("abc", 100, 1, 1000, "limit");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid limit: must be a number" });
  });

  it("returns 400 response for empty string", async () => {
    const result = parseIntParam("", 100, 1, 1000, "offset");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid offset: must be a number" });
  });
});

describe("integer query helpers", () => {
  it("defaults malformed clamped integer params and clamps out-of-range values", () => {
    expect(parseClampedIntegerParam("abc", 50, 1, 200)).toBe(50);
    expect(parseClampedIntegerParam("999", 50, 1, 200)).toBe(200);
    expect(parseClampedIntegerParam("0", 50, 1, 200)).toBe(1);
  });

  it("can preserve zero-as-default behavior for legacy clamped params", () => {
    expect(parseClampedIntegerParam("0", 1825, 30, 1825, { zeroAsDefault: true })).toBe(1825);
  });

  it("parses optional non-negative integer params with a fallback default", () => {
    expect(parseOptionalNonNegativeIntegerParam("0", 90)).toBe(0);
    expect(parseOptionalNonNegativeIntegerParam("-1", 90)).toBe(90);
  });

  it("rejects malformed optional positive integer params", async () => {
    const result = parseOptionalPositiveIntegerParam("25abc", "limit");
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: "Invalid limit: must be a positive integer" });
    }
  });
});

describe("parseFloatParam", () => {
  it("returns default for null input", () => {
    expect(parseFloatParam(null, 1.5, 0, 10)).toBe(1.5);
  });

  it("parses valid floats", () => {
    expect(parseFloatParam("25.75", 0, 0, 100, "minAmount")).toBe(25.75);
  });

  it("returns 400 for malformed float input", async () => {
    const result = parseFloatParam("oops", 0, 0, 100, "minAmount");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid minAmount: must be a number" });
  });

  it("rejects out-of-range floats when rangePolicy is reject", async () => {
    const result = parseFloatParam("100.5", 0, 0, 100, "minAmount", { rangePolicy: "reject" });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid minAmount: must be between 0 and 100" });
  });
});

describe("parseQueryParams", () => {
  it("parses multiple params into an object", () => {
    const params = new URLSearchParams("limit=25&offset=10");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  it("returns 400 Response for invalid param", () => {
    const params = new URLSearchParams("limit=abc");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
    });
    expect(result).toBeInstanceOf(Response);
  });

  it("uses defaults for missing params", () => {
    const params = new URLSearchParams("");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  it("supports float params", () => {
    const params = new URLSearchParams("threshold=0.5");
    const result = parseQueryParams(params, {
      threshold: { type: "float", default: 1.0, min: 0, max: 10 },
    });
    expect(result).toEqual({ threshold: 0.5 });
  });

  it("rejects out-of-range values when a spec opts into reject mode", async () => {
    const params = new URLSearchParams("limit=250");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200, rangePolicy: "reject" },
    });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid limit: must be between 1 and 200" });
  });
});

describe("parseOptionalEnumParam", () => {
  const validModes = new Set(["strict", "relaxed"] as const);

  it("returns null for missing or blank values", () => {
    expect(parseOptionalEnumParam(null, validModes, "mode")).toBeNull();
    expect(parseOptionalEnumParam(undefined, validModes, "mode")).toBeNull();
    expect(parseOptionalEnumParam("   ", validModes, "mode")).toBeNull();
  });

  it("returns the trimmed enum value when valid", () => {
    expect(parseOptionalEnumParam(" strict ", validModes, "mode")).toBe("strict");
  });

  it("returns a 400 response for invalid values", async () => {
    const result = parseOptionalEnumParam("legacy", validModes, "mode");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid mode parameter" });
  });
});

describe("parseOptionalRequestJsonObject", () => {
  it("returns an empty object when no request is provided", async () => {
    await expect(parseOptionalRequestJsonObject()).resolves.toEqual({});
  });

  it("returns an empty object for empty post bodies", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({});
  });

  it("returns the parsed object for valid JSON objects", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, limit: 10 }),
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({ dryRun: true, limit: 10 });
  });

  it("returns 400 for malformed json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 for non-object json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not-an-object"]),
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});

describe("parseEnumParam", () => {
  const validModes = new Set(["strict", "relaxed"] as const);

  it("returns the default when the value is missing", () => {
    expect(parseEnumParam(null, validModes, "mode", "strict")).toBe("strict");
  });

  it("returns the parsed enum value when valid", () => {
    expect(parseEnumParam("relaxed", validModes, "mode", "strict")).toBe("relaxed");
  });

  it("returns a 400 response for invalid values", async () => {
    const result = parseEnumParam("legacy", validModes, "mode", "strict");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid mode parameter" });
  });
});

describe("parseRequiredStablecoinIdParam", () => {
  it("returns a 400 response when the parameter is missing", async () => {
    const result = parseRequiredStablecoinIdParam(new URLSearchParams(""), "stablecoin");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing required parameter: stablecoin" });
  });

  it("returns a 404 response when the stablecoin is unknown", async () => {
    const result = parseRequiredStablecoinIdParam(
      new URLSearchParams("stablecoin=not-a-stablecoin"),
      "stablecoin",
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("returns the canonical stablecoin id when the parameter is valid", () => {
    expect(parseRequiredStablecoinIdParam(new URLSearchParams("stablecoin=usdt-tether"), "stablecoin")).toBe(
      "usdt-tether",
    );
  });
});

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

describe("fetchPaginatedEvents", () => {
  it("builds count and data queries with validated pagination inputs", async () => {
    type BoundStatement = { sql: string; binds: unknown[] };
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds }),
      }),
      batch: vi.fn(async (stmts: BoundStatement[]) => {
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toEqual({
          sql: "SELECT COUNT(*) as total FROM blacklist_events WHERE stablecoin_id = ?",
          binds: ["usdt-tether"],
        });
        expect(stmts[1]).toEqual({
          sql: "SELECT * FROM blacklist_events WHERE stablecoin_id = ? ORDER BY timestamp DESC, id ASC LIMIT ? OFFSET ?",
          binds: ["usdt-tether", 25, 50],
        });

        return [
          { results: [{ total: 2 }] },
          { results: [{ id: "a" }, { id: "b" }] },
        ];
      }),
    } as unknown as D1Database;

    const result = await fetchPaginatedEvents<{ id: string }, string>(db, {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC, id ASC",
      conditions: ["stablecoin_id = ?"],
      filterBindings: ["usdt-tether"],
      limit: 25,
      offset: 50,
      mapRow: (row) => row.id,
    });

    expect(result).toEqual({
      total: 2,
      events: ["a", "b"],
    });
  });

  it("rejects non-allowlisted tables and malformed order clauses", async () => {
    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "cache",
      orderBy: "timestamp DESC",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid table: cache");

    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "blacklist_events",
      orderBy: "timestamp DOWN",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy direction: DOWN");

    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC NULLS LAST",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy: timestamp DESC NULLS LAST");
  });
});

describe("jsonResponse", () => {
  it("returns JSON with default headers", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("merges custom headers", async () => {
    const res = jsonResponse({ ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("supports status, no-store, and Retry-After options", async () => {
    const res = jsonResponse({ ok: true }, {
      status: 202,
      noStore: true,
      retryAfterSec: 3,
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("3");
  });
});

describe("jsonFreshResponse", () => {
  it("returns plain JSON when freshness metadata is not provided", async () => {
    const res = jsonFreshResponse({ ok: true }, {
      cacheControl: "public, max-age=60",
      headers: { "X-Test": "1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("X-Data-Age")).toBeNull();
  });
});

describe("validatePayloadWithSchema", () => {
  it("returns parsed data when schema matches", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: true }, "test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ ok: true });
  });

  it("returns issues when schema fails", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: "yes" }, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("buildCacheStatuses", () => {
  function makeDb(nowSec: number) {
    const seenSql: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        const first = async <T>() => {
          if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
            return { age: 120 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [{ key: "stablecoins", updated_at: nowSec - 60 }] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;
    return { db, seenSql };
  }

  it("queries table-backed freshness using latest timestamps", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { db, seenSql } = makeDb(nowSec);

    await buildCacheStatuses(db, nowSec);

    const dexSql = seenSql.find((s) => s.includes("dex_liquidity"));
    const yieldSql = seenSql.find((s) => s.includes("yield_data"));
    const dewsSql = seenSql.find((s) => s.includes("stress_signals"));

    expect(dexSql).toContain("? - MAX(updated_at)");
    expect(yieldSql).toContain("? - MAX(updated_at)");
    expect(yieldSql).toContain("is_best = 1");
    expect(dewsSql).toContain("? - MAX(computed_at)");
  });

  it("uses freshness sentinels when present and skips hot-table freshness queries", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const seenSql: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        const first = async <T>() => null as T | null;
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [
                    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
                    { key: "freshness:dex-liquidity", updated_at: nowSec - 120, value: "{}" },
                    { key: "freshness:yield-data", updated_at: nowSec - 180, value: "{}" },
                    { key: "freshness:dews", updated_at: nowSec - 240, value: "{}" },
                  ] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, diagnostics } = await buildCacheStatuses(db, nowSec);

    expect(caches["dex-liquidity"]?.ageSeconds).toBe(120);
    expect(caches["dex-liquidity"]).toMatchObject({
      producerJob: "sync-dex-liquidity",
      producerIntervalSec: 1800,
      endpointMaxAge: 3600,
      availabilityMaxAge: 43200,
    });
    expect(caches["yield-data"]?.ageSeconds).toBe(180);
    expect(caches["yield-data"]).toMatchObject({
      producerJob: "sync-yield-data",
      producerIntervalSec: 3600,
      endpointMaxAge: 3600,
      availabilityMaxAge: 3600,
    });
    expect(caches.dews?.ageSeconds).toBe(240);
    expect(caches.dews).toMatchObject({
      producerJob: "compute-dews",
      producerIntervalSec: 1800,
      endpointMaxAge: 1800,
      availabilityMaxAge: 1800,
    });
    expect(diagnostics).toEqual([]);
    expect(seenSql.some((sql) => sql.includes("FROM dex_liquidity"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM yield_data"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("clamps negative table ages to zero", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
            return { age: -30 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches } = await buildCacheStatuses(db, nowSec);
    expect(caches["dex-liquidity"]?.ageSeconds).toBe(0);
    expect(caches["yield-data"]?.ageSeconds).toBe(0);
    expect(caches.dews?.ageSeconds).toBe(0);
  });

  it("reports cache freshness query failures instead of throwing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("stress_signals")) {
            throw new Error("stress query failed");
          }
          if (sql.includes("MAX(updated_at)")) {
            return { age: 60 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, failures } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBeNull();
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "stress query failed",
      },
    ]);
  });

  it("falls back to producer cron timestamps when freshness diagnostics fail", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("stress_signals")) {
            throw new Error("stress query failed");
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("FROM cron_runs")) {
                return {
                  results: [{ job: "compute-dews", started_at: nowSec - 300 }] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBe(300);
    expect(caches.dews?.warning).toBe("dews: freshness table query failed; using cron fallback");
    expect(diagnostics).toContainEqual({
      key: "dews",
      freshnessSource: "cron-fallback",
      warning: "dews: freshness table query failed; using cron fallback",
      failureSource: "table-freshness",
    });
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "stress query failed",
      },
    ]);
    expect(warnings).toContain("dews: freshness table query failed; using cron fallback");
  });

  it("uses table fallback warnings when the cache lookup fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: 45 } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("cache WHERE key IN")) {
                  throw new Error("cache lookup failed");
                }
                if (sql.includes("FROM cron_runs")) {
                  return { results: [] as T[], success: true, meta: {} };
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(45);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using table fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "table-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using table fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using table fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        "[api-freshness] dex-liquidity: freshness sentinel lookup failed; using table fallback",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("uses cron fallback warnings when cache lookup fails and table freshness is unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: null } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("cache WHERE key IN")) {
                  throw new Error("cache lookup failed");
                }
                if (sql.includes("FROM cron_runs")) {
                  return {
                    results: [
                      { job: "sync-dex-liquidity", started_at: nowSec - 90 },
                      { job: "sync-yield-data", started_at: nowSec - 120 },
                      { job: "compute-dews", started_at: nowSec - 150 },
                    ] as T[],
                    success: true,
                    meta: {},
                  };
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(90);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "cron-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using cron fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        "[api-freshness] dex-liquidity: freshness sentinel lookup failed; using cron fallback",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("records cron fallback failures when both table and producer fallback lookups are unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: null } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("FROM cron_runs")) {
                  throw new Error("cron lookup failed");
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { failures } = await buildCacheStatuses(db, nowSec);

      expect(failures).toContainEqual({
        key: "dex-liquidity",
        source: "cron-fallback",
        message: "cron lookup failed",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[api-freshness] Failed to read producer cron fallbacks",
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses fx-rates-meta usableSyncAt for cache freshness and keeps cadence-aware source warnings separate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
            return { age: 60 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [
                    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
                    { key: "stablecoin-charts", updated_at: nowSec - 60, value: "{}" },
                    { key: "usds-status", updated_at: nowSec - 60, value: "{}" },
                    { key: "fx-rates", updated_at: nowSec - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
                    {
                      key: "fx-rates-meta",
                      updated_at: nowSec - 60,
                      value: JSON.stringify({
                        usableSyncAt: nowSec - 60,
                        mode: "cached-fallback",
                        sourceUpdatedAtByPeg: { peggedEUR: nowSec - 8 * 3600 },
                        sourceModeByPeg: { peggedEUR: "cached" },
                        sourceCadenceByPeg: { peggedEUR: "intraday" },
                        consecutiveFallbackRuns: 4,
                      }),
                    },
                    { key: "bluechip-ratings", updated_at: nowSec - 60, value: "{}" },
                  ] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, statusFloor, warnings } = await buildCacheStatuses(db, nowSec);

    expect(caches["fx-rates"]?.ageSeconds).toBe(60);
    expect(caches["fx-rates"]?.mode).toBe("cached-fallback");
    expect(caches["fx-rates"]?.sourceStatus).toBe("degraded");
    expect(caches["fx-rates"]?.consecutiveFallbackRuns).toBe(4);
    expect(statusFloor).toBe("degraded");
    expect(warnings[0]).toContain("cached fallback FX rates");
  });
});
