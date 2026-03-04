import { describe, expect, it } from "vitest";
import {
  getProbePaths,
  getStatusPageActions,
  isCacheBypassPath,
  isMutatingAdminPath,
} from "../api-endpoints";

describe("api endpoint registry", () => {
  it("keeps probe path groups stable", () => {
    expect(getProbePaths("public")).toEqual([
      "/api/stablecoins",
      "/api/stablecoin/1",
      "/api/stablecoin-charts",
      "/api/peg-summary",
      "/api/health",
      "/api/blacklist",
      "/api/depeg-events",
      "/api/usds-status",
      "/api/bluechip-ratings",
      "/api/dex-liquidity",
      "/api/dex-liquidity-history?stablecoin=1",
      "/api/supply-history?stablecoin=1",
      "/api/daily-digest",
      "/api/digest-archive",
      "/api/yield-rankings",
      "/api/yield-history?stablecoin=1",
      "/api/stability-index",
      "/api/report-cards",
      "/api/mint-burn-flows",
      "/api/mint-burn-events",
      "/api/stress-signals",
    ]);

    expect(getProbePaths("admin")).toEqual([
      "/api/status",
      "/api/status-history?limit=10",
      "/api/debug-sync-state",
    ]);

    expect(getProbePaths("manual")).toEqual([
      "/api/trigger-digest",
      "/api/reset-blacklist-sync",
      "/api/backfill-depegs",
      "/api/backfill-supply-history",
      "/api/backfill-cg-prices",
      "/api/backfill-stability-index",
      "/api/backfill-mint-burn-prices",
      "/api/backfill-mint-burn",
      "/api/audit-depeg-history?dry-run=true",
      "/api/backfill-dews",
    ]);
  });

  it("flags mutating admin paths for method guards", () => {
    expect(isMutatingAdminPath("/api/backfill-depegs")).toBe(true);
    expect(isMutatingAdminPath("/api/backfill-mint-burn")).toBe(true);
    expect(isMutatingAdminPath("/api/trigger-digest")).toBe(true);
    expect(isMutatingAdminPath("/api/stablecoins")).toBe(false);
    expect(isMutatingAdminPath("/api/backfill-dews")).toBe(false);
  });

  it("flags cache-bypass paths for edge cache skip rules", () => {
    expect(isCacheBypassPath("/api/health")).toBe(true);
    expect(isCacheBypassPath("/api/status")).toBe(true);
    expect(isCacheBypassPath("/api/backfill-dews")).toBe(true);
    expect(isCacheBypassPath("/api/stablecoins")).toBe(false);
  });

  it("provides status-page actions in UI order", () => {
    expect(getStatusPageActions()).toEqual([
      {
        label: "Trigger Digest",
        path: "/api/trigger-digest",
        confirm: "Trigger daily digest? Bypasses 1h dedup window.",
        destructive: false,
        method: "POST",
      },
      {
        label: "Reset Blacklist Sync",
        path: "/api/reset-blacklist-sync",
        confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
        destructive: true,
        method: "POST",
      },
      {
        label: "Debug Sync State",
        path: "/api/debug-sync-state",
        confirm: "Fetch sync state debug dump?",
        destructive: false,
        method: "GET",
      },
      {
        label: "Backfill Depegs",
        path: "/api/backfill-depegs",
        confirm: "Run depeg backfill? This may take several minutes.",
        destructive: false,
        method: "POST",
      },
      {
        label: "Backfill Supply",
        path: "/api/backfill-supply-history",
        confirm: "Backfill supply history snapshots?",
        destructive: false,
        method: "POST",
      },
      {
        label: "Backfill CG Prices",
        path: "/api/backfill-cg-prices",
        confirm: "Backfill CoinGecko prices?",
        destructive: false,
        method: "POST",
      },
      {
        label: "Backfill PSI",
        path: "/api/backfill-stability-index",
        confirm: "Backfill stability index history?",
        destructive: false,
        method: "POST",
      },
      {
        label: "Backfill Mint/Burn Prices",
        path: "/api/backfill-mint-burn-prices",
        confirm: "Backfill mint/burn USD prices for NULL events?",
        destructive: false,
        method: "POST",
      },
      {
        label: "Backfill Mint/Burn",
        path: "/api/backfill-mint-burn",
        confirm: "Run mint/burn backfill job?",
        destructive: false,
        method: "POST",
      },
      {
        label: "Audit Depegs",
        path: "/api/audit-depeg-history?dry-run=true",
        confirm: "Run depeg history audit (dry-run)?",
        destructive: false,
        method: "GET",
      },
      {
        label: "Backfill DEWS",
        path: "/api/backfill-dews",
        confirm: "Run DEWS historical backfill validation?",
        destructive: false,
        method: "GET",
      },
    ]);
  });
});
