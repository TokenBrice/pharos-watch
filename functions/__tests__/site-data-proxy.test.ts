import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { onRequest } from "../_site-data/[[path]].ts";
import { resetSiteDataRequestAttributionStateForTests } from "../lib/request-attribution";

interface TestD1Database extends D1Database {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
}

function makeTestDb(): TestD1Database {
  const history: Array<{ sql: string; binds: unknown[] }> = [];

  function buildStatement(sql: string, binds: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...nextBinds: unknown[]) => buildStatement(sql, nextBinds),
      run: async () => {
        history.push({ sql, binds: [...binds] });
        return { success: true, meta: { changes: sql.includes("DELETE") ? 0 : 1 } };
      },
      first: async () => {
        history.push({ sql, binds: [...binds] });
        return null;
      },
      all: async () => {
        history.push({ sql, binds: [...binds] });
        return { results: [], success: true, meta: {} };
      },
    } as D1PreparedStatement;
  }

  return {
    prepare: (sql: string) => buildStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
  } as unknown as TestD1Database;
}

function makeEnv(db = makeTestDb(), overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    SITE_ORIGIN: "https://pharos.watch",
    OPS_UI_ORIGIN: "https://ops.pharos.watch",
    SITE_API_ORIGIN: "https://site-api.pharos.watch",
    SITE_API_SHARED_SECRET: "shared-secret",
    ...overrides,
  };
}

describe("site-data proxy", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
    resetSiteDataRequestAttributionStateForTests();
    cacheMatch.mockReset();
    cachePut.mockReset();
    vi.stubGlobal("caches", {
      default: {
        match: cacheMatch,
        put: cachePut,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects requests without Origin or Referer", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins"),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects requests from foreign origins", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://evil.example.com" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted paths", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/status", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "status" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("enforces GET-only method rules", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        method: "POST",
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("returns a cached response and records a Pages cache-hit request", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestDb();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats")
      && entry.binds[1] === "stablecoins"
      && entry.binds[2] === "/api/stablecoins"
      && entry.binds[3] === "pages-cache-hit"
      && entry.binds[4] === "")).toBe(true);
  });

  it("bypasses the Pages cache for conditional requests", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { ETag: "\"stablecoins-v1\"" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { "If-None-Match": "\"stablecoins-v1\"", Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(304);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies allowlisted requests to the site API with the shared secret and records an upstream fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "application/json",
        Warning: '199 - "advisory"',
        "X-Data-Age": "12",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestDb();

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/_site-data/stablecoin-summary/usdt-tether", {
        headers: { Accept: "application/json", Origin: "https://ops.pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: ["stablecoin-summary", "usdt-tether"] },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/stablecoin-summary/usdt-tether",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );

    const fetchInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const forwardedHeaders = fetchInit.headers as Headers;
    expect(forwardedHeaders.get("Accept")).toBe("application/json");
    expect(forwardedHeaders.get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Warning")).toContain("advisory");
    expect(response.headers.get("X-Data-Age")).toBe("12");
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats")
      && entry.binds[1] === "stablecoin-summary"
      && entry.binds[2] === "/api/stablecoin-summary/:id"
      && entry.binds[3] === "pages-upstream-fetch"
      && entry.binds[4] === "site-api")).toBe(true);
  });

  it("does not cache upstream responses marked no-store", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("does not cache stale upstream responses with Warning 110", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "application/json",
        Warning: '110 - "Response is stale"',
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Warning")).toContain("Response is stale");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("preserves upstream Retry-After headers on site-data rate limits", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "45",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    await expect(response.json()).resolves.toEqual({ error: "Rate limit exceeded" });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies public-status-history through the site-data lane", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestDb();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/public-status-history", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "public-status-history" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/public-status-history",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats")
      && entry.binds[1] === "public-status-history"
      && entry.binds[2] === "/api/public-status-history"
      && entry.binds[3] === "pages-upstream-fetch"
      && entry.binds[4] === "site-api")).toBe(true);
  });

  it("proxies telegram-pulse through the site-data lane", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestDb();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/telegram-pulse", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "telegram-pulse" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/telegram-pulse",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats")
      && entry.binds[1] === "telegram-pulse"
      && entry.binds[2] === "/api/telegram-pulse"
      && entry.binds[3] === "pages-upstream-fetch"
      && entry.binds[4] === "site-api")).toBe(true);
  });

  it("fails closed on production site hosts when SITE_API_ORIGIN is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestDb(), { SITE_API_ORIGIN: undefined }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("returns 500 when the site-proxy secret is missing", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestDb(), { SITE_API_SHARED_SECRET: " " }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
