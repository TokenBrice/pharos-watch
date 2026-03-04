import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  errorResponse,
  parseIntParam,
  parseStablecoinHistoryQuery,
  jsonResponse,
  validatePayloadWithSchema,
  buildCacheStatuses,
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

  it("returns default for NaN input", () => {
    expect(parseIntParam("abc", 100, 1, 1000)).toBe(100);
  });

  it("returns default for empty string", () => {
    expect(parseIntParam("", 100, 1, 1000)).toBe(100);
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

  it("returns 400 with stable message when stablecoin ID is invalid", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=DROP TABLE"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid stablecoin ID" });
  });

  it("applies endpoint-specific default and bounds for days", () => {
    const bounded = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=1&days=9999"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    if (bounded instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(bounded.days).toBe(1825);

    const withDefault = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=1&days=abc"),
      { defaultDays: 90, minDays: 1, maxDays: 365 },
    );
    if (withDefault instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(withDefault.days).toBe(90);
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
});
