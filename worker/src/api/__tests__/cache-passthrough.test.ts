/**
 * Contract tests for cache-passthrough handlers.
 * All use createCacheHandler: cache hit -> 200 + _meta, cache miss -> 503.
 */
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStablecoins } from "../stablecoins";
import { handleStablecoinCharts } from "../stablecoin-charts";
import { handleUsdsStatus } from "../usds-status";
import { handleBluechipRatings } from "../bluechip";
import { handleYieldRankings } from "../yield-rankings";

const nowSec = Math.floor(Date.now() / 1000);

function makeCacheDb(key: string, value: unknown) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  return mockD1([
    {
      match: "cache",
      rows: [{ key, value: jsonValue, updated_at: nowSec }],
      first: { key, value: jsonValue, updated_at: nowSec },
    },
  ]);
}

const emptyDb = mockD1();

describe("cache-passthrough: handleStablecoins", () => {
  it("returns 503 when cache is empty", async () => {
    const res = await handleStablecoins(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with _meta when cache hit (object payload)", async () => {
    const db = makeCacheDb("stablecoins", { peggedAssets: [] });
    const res = await handleStablecoins(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: { status: string } };
    expect(body).toHaveProperty("_meta");
    expect(body._meta).toHaveProperty("status");
    expect(body._meta).toHaveProperty("updatedAt");
    expect(body._meta).toHaveProperty("ageSeconds");
  });

  it("includes X-Data-Age header on cache hit", async () => {
    const db = makeCacheDb("stablecoins", { peggedAssets: [] });
    const res = await handleStablecoins(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});

describe("cache-passthrough: handleStablecoinCharts", () => {
  it("returns 503 when cache is empty", async () => {
    const res = await handleStablecoinCharts(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with _meta on cache hit", async () => {
    const db = makeCacheDb("stablecoin-charts", { charts: {} });
    const res = await handleStablecoinCharts(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: unknown };
    expect(body).toHaveProperty("_meta");
  });
});

describe("cache-passthrough: handleUsdsStatus", () => {
  it("returns 503 when cache is empty", async () => {
    const res = await handleUsdsStatus(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with _meta on cache hit", async () => {
    const db = makeCacheDb("usds-status", { status: "ok" });
    const res = await handleUsdsStatus(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: unknown };
    expect(body).toHaveProperty("_meta");
  });
});

describe("cache-passthrough: handleBluechipRatings", () => {
  it("returns 503 when cache is empty", async () => {
    const res = await handleBluechipRatings(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with _meta on cache hit", async () => {
    const db = makeCacheDb("bluechip-ratings", { "usdt-tether": { grade: "A" } });
    const res = await handleBluechipRatings(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: unknown };
    expect(body).toHaveProperty("_meta");
  });
});

describe("cache-passthrough: handleYieldRankings", () => {
  it("returns 503 when cache is empty", async () => {
    const res = await handleYieldRankings(emptyDb);
    expect(res.status).toBe(503);
  });

  it("returns 200 with _meta on cache hit", async () => {
    const db = makeCacheDb("yield-rankings", { rankings: [] });
    const res = await handleYieldRankings(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: unknown };
    expect(body).toHaveProperty("_meta");
  });
});
