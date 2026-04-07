import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  errorResponse,
  parseFloatParam,
  parseIntParam,
  parseOptionalEnumParam,
  parseOptionalRequestJsonObject,
  parseEnumParam,
  parseRequiredStablecoinIdParam,
  parseQueryParams,
  parseStablecoinHistoryQuery,
  jsonResponse,
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
                    { key: "treasury-stable-exposure", updated_at: nowSec - 60, value: "[]" },
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
