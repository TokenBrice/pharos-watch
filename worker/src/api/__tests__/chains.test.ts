import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// Mock stablecoins to avoid importing full metadata tree
vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
  TRACKED_STABLECOINS: [],
}));

import { handleChains } from "../chains";

function freshCache(payload: unknown, ageSeconds = 60) {
  return {
    match: "cache",
    matchBinds: ["stablecoins"],
    rows: [],
    first: {
      key: "stablecoins",
      value: JSON.stringify(payload),
      updated_at: Math.floor(Date.now() / 1000) - ageSeconds,
    },
  };
}

function reportCardCache(
  scores: Record<string, { score: number; grade: string }>,
  payloadAgeSeconds = 60,
  rowAgeSeconds = payloadAgeSeconds,
) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    match: "cache",
    matchBinds: ["report_card_cache"],
    rows: [],
    first: {
      key: "report_card_cache",
      value: JSON.stringify({
        scores,
        updatedAt: nowSec - payloadAgeSeconds,
      }),
      updated_at: nowSec - rowAgeSeconds,
    },
  };
}

describe("handleChains", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("returns chains sorted by totalUsd", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
          circulating: { peggedUSD: 500 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 290, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
            bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
          },
        },
        {
          id: "usdc-circle", symbol: "USDC", name: "USD Coin", price: 0.999, pegType: "peggedUSD",
          circulating: { peggedUSD: 300 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 300, circulatingPrevWeek: 300, circulatingPrevMonth: 300 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" }, "usdc-circle": { score: 88, grade: "A" } }),
    ]);

    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      chains: Array<{ id: string; totalUsd: number; healthScore: number | null }>;
      _meta: {
        ageSeconds: number;
        status: "fresh" | "degraded" | "stale";
        dependencies: {
          reportCards: {
            status: "fresh" | "degraded" | "stale" | "unavailable";
          };
        };
      };
    };
    expect(body.chains[0].id).toBe("ethereum");
    expect(body.chains[0].totalUsd).toBe(600);
    expect(body.chains[0].healthScore).toBeTypeOf("number");
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body._meta.dependencies.reportCards.status).toBe("fresh");
    expect(response.headers.get("Warning")).toBeNull();
  });

  it("returns null healthScore when report card cache is missing", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([freshCache(payload)]);
    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      chains: Array<{ healthScore: number | null }>;
      _meta: {
        status: "fresh" | "degraded" | "stale";
        dependencies: {
          reportCards: {
            status: "fresh" | "degraded" | "stale" | "unavailable";
            reason?: string | null;
          };
        };
      };
    };
    // No report card cache → quality null → healthScore null
    expect(body.chains[0].healthScore).toBeNull();
    expect(body._meta.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.status).toBe("unavailable");
    expect(body._meta.dependencies.reportCards.reason).toBe("missing cache");
    expect(response.headers.get("Warning")).toContain("report-card cache missing cache");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the response degraded when the stablecoins snapshot is older than the 600s chains budget", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([
      freshCache(payload, 601),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as {
      _meta: { ageSeconds: number; status: "fresh" | "degraded" | "stale" };
    };

    expect(response.status).toBe(200);
    expect(body._meta.ageSeconds).toBeGreaterThanOrEqual(601);
    expect(body._meta.status).toBe("degraded");
    expect(response.headers.get("Warning")).toContain("Response is degraded");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the response degraded when the report card cache is stale", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }, 3 * 60 * 60),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as {
      chains: Array<{ healthScore: number | null }>;
      _meta: {
        status: "fresh" | "degraded" | "stale";
        dependencies: {
          reportCards: {
            ageSeconds?: number | null;
            status: "fresh" | "degraded" | "stale" | "unavailable";
            reason?: string | null;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.chains[0].healthScore).toBeNull();
    expect(body._meta.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.status).toBe("stale");
    expect(body._meta.dependencies.reportCards.ageSeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(body._meta.dependencies.reportCards.reason).toBe("stale cache");
    expect(response.headers.get("Warning")).toContain("report-card cache stale cache");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports report-card dependency age from the payload snapshot, not the cache-row write time", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }, 3 * 60 * 60, 60),
    ]);

    const response = await handleChains(db);
    const body = await response.json() as {
      _meta: {
        dependencies: {
          reportCards: {
            ageSeconds?: number | null;
            status: "fresh" | "degraded" | "stale" | "unavailable";
          };
        };
      };
    };

    expect(body._meta.dependencies.reportCards.status).toBe("stale");
    expect(body._meta.dependencies.reportCards.ageSeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
  });
});
