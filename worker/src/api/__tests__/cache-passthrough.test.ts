/**
 * Contract tests for cache-backed public handlers.
 * Object payload handlers add `_meta`; array payload handlers keep header-only freshness.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  handleStablecoins,
  handleStablecoinCharts,
  handleUsdsStatus,
  handleBluechipRatings,
} from "../cache-handlers";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../lib/response-ready-cache-contracts";

function makeBluechipRating(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    grade: "A",
    slug: "tether",
    collateralization: 95,
    smartContractAudit: true,
    dateOfRating: "2026-03-01",
    dateLastChange: null,
    smidge: {
      stability: "stable",
      management: null,
      implementation: null,
      decentralization: null,
      governance: null,
      externals: null,
    },
    ...overrides,
  };
}

function makeUsdsStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    freezeCapabilityPresent: false,
    implementationAddress: "0x1923dfee706a8e78157416c29cbccfde7cdf4102",
    lastChecked: 1_762_000_000,
    ...overrides,
  };
}

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

  it("returns 503 when cached stablecoins JSON fails schema validation", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("stablecoins", { peggedAssets: "not-an-array" }, nowSec);
    const res = await handleStablecoins(db);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cached stablecoins payload is malformed" });
  });

  it("serves response-ready stablecoins body when it matches the canonical cache timestamp", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const responseReadyValue = encodeResponseReadyCacheValue(
      JSON.stringify({ peggedAssets: [] }),
      RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins,
    );
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: "{malformed", updated_at: nowSec },
          { key: getResponseReadyCacheKey("stablecoins"), value: responseReadyValue, updated_at: nowSec },
        ],
      },
    ]);

    const res = await handleStablecoins(db);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      peggedAssets: unknown[];
      _meta: { updatedAt: number; ageSeconds: number };
    };
    expect(body.peggedAssets).toEqual([]);
    expect(body._meta.updatedAt).toBe(nowSec);
    expect(body._meta.ageSeconds).toBe(0);
  });

  it("ignores untrusted response-ready stablecoins rows and validates the canonical cache", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: JSON.stringify({ peggedAssets: "not-an-array" }), updated_at: nowSec },
          { key: getResponseReadyCacheKey("stablecoins"), value: JSON.stringify({ peggedAssets: [] }), updated_at: nowSec },
        ],
      },
    ]);

    const res = await handleStablecoins(db);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cached stablecoins payload is malformed" });
  });

  it("falls back to canonical stablecoins cache when response-ready lookup fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: nowSec }],
      },
      {
        match: "cache",
        matchBinds: [getResponseReadyCacheKey("stablecoins")],
        rows: [],
        throwError: new Error("response-ready cache unavailable"),
      },
    ]);

    const res = await handleStablecoins(db);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      peggedAssets: unknown[];
      _meta: { updatedAt: number; ageSeconds: number };
    };
    expect(body.peggedAssets).toEqual([]);
    expect(body._meta.updatedAt).toBe(nowSec);
  });

  it("ignores stale response-ready stablecoins body and keeps canonical schema validation", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const responseReadyValue = JSON.stringify({ peggedAssets: [] });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: JSON.stringify({ peggedAssets: "not-an-array" }), updated_at: nowSec },
          { key: getResponseReadyCacheKey("stablecoins"), value: responseReadyValue, updated_at: nowSec - 1 },
        ],
      },
    ]);

    const res = await handleStablecoins(db);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cached stablecoins payload is malformed" });
  });
});

describe("cache-passthrough: handleStablecoinCharts", () => {
  it("returns 503 when cache is empty", async () => {
    const emptyDb = mockD1();
    const res = await handleStablecoinCharts(emptyDb);
    expect(res.status).toBe(503);
  });

  it("marks legacy provider history and does not append a mixed-universe live point", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoin-charts"],
        rows: [{
          key: "stablecoin-charts",
          value: JSON.stringify([{ date: String(nowSec - 3600), totalCirculatingUSD: { peggedUSD: 100 } }]),
          updated_at: nowSec - 5,
        }],
        first: {
          key: "stablecoin-charts",
          value: JSON.stringify([{ date: String(nowSec - 3600), totalCirculatingUSD: { peggedUSD: 100 } }]),
          updated_at: nowSec - 5,
        },
      },
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                pegType: "peggedUSD",
                price: 1,
                circulating: { peggedUSD: 120 },
              },
            ],
          }),
          updated_at: nowSec,
        }],
        first: {
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                pegType: "peggedUSD",
                price: 1,
                circulating: { peggedUSD: 120 },
              },
            ],
          }),
          updated_at: nowSec,
        },
      },
    ]);
    const res = await handleStablecoinCharts(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      date: number;
      totalCirculatingUSD: Record<string, number>;
      aggregateUniverse: string;
    }>;

    expect(body).toEqual([
      {
        date: nowSec - 3600,
        totalCirculatingUSD: { peggedUSD: 100 },
        aggregateUniverse: "legacy-provider-all-stablecoins-v1",
      },
    ]);
    expect(typeof body[0]?.date).toBe("number");
    expect(res.headers.get("X-Data-Age")).toBe("5");
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
    const db = makeCacheDb("usds-status", makeUsdsStatus(), nowSec - 42);
    const res = await handleUsdsStatus(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      freezeCapabilityPresent: boolean;
      implementationAddress: string;
      lastChecked: number;
      _meta: { status: string; ageSeconds: number };
    };
    expect(body.freezeCapabilityPresent).toBe(false);
    expect(body.implementationAddress).toBe("0x1923dfee706a8e78157416c29cbccfde7cdf4102");
    expect(body.lastChecked).toBe(1_762_000_000);
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBe(42);
  });

  it("sanitizes malformed freeze capability and lastChecked fields", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("usds-status", makeUsdsStatus({
      freezeCapabilityPresent: "yes",
      implementationAddress: "0x1923DFEe706A8E78157416C29CBCCFDE7CDF4102",
      lastChecked: "not-a-number",
    }), nowSec - 42);

    const res = await handleUsdsStatus(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      freezeCapabilityPresent: boolean;
      implementationAddress: string;
      lastChecked: number;
      _meta: { ageSeconds: number };
    };
    expect(body.freezeCapabilityPresent).toBe(false);
    expect(body.implementationAddress).toBe("0x1923dfee706a8e78157416c29cbccfde7cdf4102");
    expect(body.lastChecked).toBe(nowSec - 42);
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
    const db = makeCacheDb("bluechip-ratings", { "usdt-tether": makeBluechipRating() }, nowSec - 120);
    const res = await handleBluechipRatings(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _meta: { status: string; ageSeconds: number } };
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBe(120);
  });

  it("returns 503 when cached bluechip payload shape is malformed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeCacheDb("bluechip-ratings", { "usdt-tether": { grade: "A" } }, nowSec - 120);
    const res = await handleBluechipRatings(db);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached bluechip-ratings payload is malformed",
    });
  });
});
