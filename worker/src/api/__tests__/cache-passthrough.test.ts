/**
 * Contract tests for cache-passthrough handlers.
 * All use createCacheHandler: cache hit -> 200 + _meta, cache miss -> 503.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import {
  handleStablecoins,
  handleStablecoinCharts,
  handleUsdsStatus,
  handleBluechipRatings,
} from "../cache-handlers";

function makeCacheDb(key: string, value: unknown, updatedAt: number) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  return mockD1([
    {
      match: "cache",
      rows: [{ key, value: jsonValue, updated_at: updatedAt }],
      first: { key, value: jsonValue, updated_at: updatedAt },
    },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cache-passthrough: handleStablecoins", () => {
  it("returns 503 when cache is empty", async () => {
    const emptyDb = mockD1();
    const res = await handleStablecoins(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with concrete _meta values and matching X-Data-Age", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("stablecoins", { peggedAssets: [] }, nowSec);
    const res = await handleStablecoins(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      _meta: { status: string; updatedAt: number; ageSeconds: number };
    };

    expect(body._meta.status).toBe("fresh");
    expect(body._meta.updatedAt).toBe(nowSec);
    expect(body._meta.ageSeconds).toBe(0);
    expect(new Date(body._meta.updatedAt * 1000).toISOString()).toBe("2026-03-06T12:00:00.000Z");
    expect(res.headers.get("X-Data-Age")).toBe(String(body._meta.ageSeconds));
  });

  it("returns 200 with stale metadata when cache exceeds 12x maxAge", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleUpdatedAt = nowSec - 8000;
    const db = makeCacheDb("stablecoins", { peggedAssets: [] }, staleUpdatedAt);
    const res = await handleStablecoins(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      _meta: { status: string; updatedAt: number; ageSeconds: number };
    };
    expect(body._meta.updatedAt).toBe(staleUpdatedAt);
    expect(body._meta.status).toBe("stale");
    expect(body._meta.ageSeconds).toBe(8000);
    expect(res.headers.get("X-Data-Age")).toBe("8000");
    expect(res.headers.get("Warning")).toContain("Response is stale");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("cache-passthrough: handleStablecoinCharts", () => {
  it("returns 503 when cache is empty", async () => {
    const emptyDb = mockD1();
    const res = await handleStablecoinCharts(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with concrete _meta on cache hit", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("stablecoin-charts", { charts: {} }, nowSec - 5);
    const res = await handleStablecoinCharts(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: { status: string; ageSeconds: number } };
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBe(5);
  });
});

describe("cache-passthrough: handleUsdsStatus", () => {
  it("returns 503 when cache is empty", async () => {
    const emptyDb = mockD1();
    const res = await handleUsdsStatus(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with concrete _meta on cache hit", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("usds-status", { status: "ok" }, nowSec - 42);
    const res = await handleUsdsStatus(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: { status: string; ageSeconds: number } };
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBe(42);
  });
});

describe("cache-passthrough: handleBluechipRatings", () => {
  it("returns 503 when cache is empty", async () => {
    const emptyDb = mockD1();
    const res = await handleBluechipRatings(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with concrete _meta on cache hit", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("bluechip-ratings", { "usdt-tether": { grade: "A" } }, nowSec - 120);
    const res = await handleBluechipRatings(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: { status: string; ageSeconds: number } };
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBe(120);
  });
});
