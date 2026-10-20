import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { buildPopularStablecoinIds, buildStablecoinLiveMetadata } from "./live-metadata";

const nowMs = Date.parse("2026-09-06T12:00:00Z");
const query = {
  dataUpdatedAt: nowMs,
  meta: { updatedAt: nowMs / 1000, ageSeconds: 0, status: "fresh" as const, freshBudgetSec: 60, degradedBudgetSec: 120 },
};

describe("command palette live supply metadata", () => {
  it("omits unavailable caps while preserving explicit zero and independent price health", () => {
    const data = { peggedAssets: [
      makeStablecoin({ id: "usdc-circle", price: 1, circulating: {} }),
      makeStablecoin({ id: "usdt-tether", price: 1, circulating: { peggedUSD: 0 } }),
      makeStablecoin({ id: "dai-makerdao", price: 1, circulating: { peggedUSD: Number.NaN } }),
    ] };
    const metadata = buildStablecoinLiveMetadata(data, query, nowMs);
    expect(metadata.get("usdc-circle")?.marketCapUsd).toBeUndefined();
    expect(metadata.get("dai-makerdao")?.marketCapUsd).toBeUndefined();
    expect(metadata.get("usdt-tether")?.marketCapUsd).toBe(0);
    expect(metadata.get("usdc-circle")?.health).toBeDefined();
    expect(buildPopularStablecoinIds(data, metadata)[0]).toBe("usdt-tether");
  });

  it("does not fabricate live caps when the entire supply query is unavailable", () => {
    expect(buildStablecoinLiveMetadata(undefined, query, nowMs).size).toBe(0);
    expect(buildPopularStablecoinIds(undefined, new Map())).toEqual([]);
  });

  it.each(["aged", "failed", "warning", "server-stale"] as const)("dates retained caps and suppresses current peg claims for %s evidence", (reason) => {
    const data = { peggedAssets: [makeStablecoin({ id: "usdc-circle", price: 1, circulating: { peggedUSD: 0 } })] };
    const state = {
      ...query,
      error: reason === "failed" ? new Error("offline") : undefined,
      meta: { ...query.meta, ...(reason === "warning" ? { warning: "upstream unavailable" } : {}), ...(reason === "server-stale" ? { status: "stale" as const } : {}) },
    };
    const metadata = buildStablecoinLiveMetadata(data, state, nowMs + (reason === "aged" ? 60_001 : 0));
    expect(metadata.get("usdc-circle")).toEqual({ marketCapUsd: 0, marketCapAsOf: nowMs / 1000 });
  });

  it("admits peg health only through the inclusive canonical fresh budget", () => {
    const data = { peggedAssets: [makeStablecoin({ id: "usdc-circle", price: 1 })] };
    expect(buildStablecoinLiveMetadata(data, query, nowMs + 60_000).get("usdc-circle")?.health).toEqual({ kind: "peg", status: "calm" });
    expect(buildStablecoinLiveMetadata(data, query, nowMs + 60_001).get("usdc-circle")?.health).toBeUndefined();
  });

  it("does not turn a fresh request receipt into a producer generation, while retaining NAV classification", () => {
    const data = { peggedAssets: [
      makeStablecoin({ id: "usdc-circle", price: 1 }),
      makeStablecoin({ id: "susds-sky", price: 1.09 }),
    ] };
    const metadata = buildStablecoinLiveMetadata(data, { dataUpdatedAt: nowMs, meta: null }, nowMs);
    expect(metadata.has("usdc-circle")).toBe(false);
    expect(metadata.get("susds-sky")).toEqual({ health: { kind: "nav" } });
  });
});
