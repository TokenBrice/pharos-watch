import { describe, expect, it } from "vitest";
import {
  getProbePaths,
  getStatusPageActions,
  isAdminPath,
  isCacheBypassPath,
  isMutatingAdminPath,
  matchDynamicAdminEndpoint,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/api-endpoints";
import { ENDPOINT_ASSERTIONS, assertPathCoverage } from "../../../scripts/smoke-api.mjs";

describe("api endpoint registry", () => {
  it("keeps probe path groups stable", () => {
    expect(getProbePaths("public")).toEqual([
      "/api/stablecoins",
      "/api/stablecoin/pyusd-paypal",
      "/api/stablecoin-summary/usdt-tether",
      "/api/stablecoin-reserves/iusd-infinifi",
      "/api/stablecoin-charts",
      "/api/peg-summary",
      "/api/health",
      "/api/blacklist",
      "/api/blacklist-summary",
      "/api/depeg-events",
      "/api/usds-status",
      "/api/bluechip-ratings",
      "/api/dex-liquidity",
      "/api/dex-liquidity-history?stablecoin=usdt-tether",
      "/api/supply-history?stablecoin=usdt-tether",
      "/api/daily-digest",
      "/api/digest-archive",
      "/api/yield-rankings",
      "/api/yield-history?stablecoin=usdt-tether",
      "/api/safety-score-history?stablecoin=usdt-tether",
      "/api/stability-index",
      "/api/report-cards",
      "/api/redemption-backstops",
      "/api/treasury-stable-exposure",
      "/api/mint-burn-flows",
      "/api/mint-burn-events?stablecoin=usdt-tether",
      "/api/stress-signals",
      "/api/chains",
      "/api/non-usd-share?days=90",
    ]);

    expect(getProbePaths("admin")).toEqual([
      "/api/status",
      "/api/status-history?limit=10",
      "/api/debug-sync-state",
      "/api/discovery-candidates",
    ]);

    expect(getProbePaths("manual")).toEqual([
      "/api/trigger-digest",
      "/api/reset-blacklist-sync",
      "/api/remediate-blacklist-amount-gaps",
      "/api/backfill-blacklist-current-balances",
      "/api/backfill-depegs",
      "/api/backfill-supply-history",
      "/api/backfill-cg-prices",
      "/api/backfill-stability-index",
      "/api/backfill-mint-burn-prices",
      "/api/backfill-mint-burn",
      "/api/reclassify-atomic-roundtrips",
      "/api/audit-depeg-history?dry-run=true",
      "/api/backfill-dews",
    ]);
  });

  it("excludes digest snapshot from auto-probe coverage because it requires an explicit date", () => {
    expect(getProbePaths("public")).not.toContain("/api/digest-snapshot");
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
    expect(isCacheBypassPath("/api/feedback")).toBe(true);
    expect(isCacheBypassPath("/api/stablecoins")).toBe(false);
  });

  it("matches dynamic admin routes from the shared registry", () => {
    expect(matchDynamicAdminEndpoint("/api/discovery-candidates/42/dismiss")).toEqual({
      key: "discovery-candidate-dismiss",
      path: "/api/discovery-candidates/42/dismiss",
      candidateId: 42,
      methods: ["POST"],
    });
    expect(matchDynamicAdminEndpoint("/api/discovery-candidates/not-a-number/dismiss")).toBeNull();
    expect(isAdminPath("/api/status")).toBe(true);
    expect(isAdminPath("/api/request-source-stats")).toBe(true);
    expect(isAdminPath("/api/discovery-candidates/42/dismiss")).toBe(true);
    expect(isAdminPath("/api/stablecoins")).toBe(false);
  });

  it("validates endpoint methods from shared definitions", () => {
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/feedback"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/request-source-stats"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoin/1"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoin-summary/1"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/discovery-candidates/1/dismiss"), "POST")).toBeNull();
    expect(
      validateEndpointMethod(new URL("https://api.pharos.watch/api/audit-depeg-history?dry-run=true"), "GET"),
    ).toBeNull();

    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "POST")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/trigger-digest"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/audit-depeg-history"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/feedback"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/discovery-candidates/1/dismiss"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/unknown"), "POST")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "DELETE")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET", "POST"],
    });
  });

  it("provides status-page actions in UI order", () => {
    expect(getStatusPageActions()).toEqual([
      {
        label: "Trigger Digest",
        path: "/api/trigger-digest",
        confirm: "Trigger daily digest? Bypasses 1h dedup window.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Reset Blacklist Sync",
        path: "/api/reset-blacklist-sync",
        confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
        destructive: true,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Debug Sync State",
        path: "/api/debug-sync-state",
        confirm: "Fetch sync state debug dump?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Remediate Blacklist Gaps",
        path: "/api/remediate-blacklist-amount-gaps",
        confirm: "Run targeted blacklist amount-gap remediation? Prefer dry-run first.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Backfill Blacklist Balances",
        path: "/api/backfill-blacklist-current-balances",
        confirm: "Backfill current-balance cache for coins missing balance rows? Prefer dry-run first (?dryRun=true).",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Backfill Depegs",
        path: "/api/backfill-depegs",
        confirm: "Run depeg backfill? This may take several minutes.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
      },
      {
        label: "Backfill Supply",
        path: "/api/backfill-supply-history",
        confirm: "Backfill supply history snapshots?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
      },
      {
        label: "Backfill CG Prices",
        path: "/api/backfill-cg-prices",
        confirm: "Backfill CoinGecko prices?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
      },
      {
        label: "Backfill PSI",
        path: "/api/backfill-stability-index",
        confirm: "Backfill stability index history?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Backfill Mint/Burn Prices",
        path: "/api/backfill-mint-burn-prices",
        confirm: "Backfill mint/burn USD prices for NULL events?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Backfill Mint/Burn",
        path: "/api/backfill-mint-burn",
        confirm: "Run mint/burn backfill job?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Reclassify Roundtrips",
        path: "/api/reclassify-atomic-roundtrips",
        confirm: "Reclassify atomic roundtrips in mint/burn data?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Audit Depegs",
        path: "/api/audit-depeg-history?dry-run=true",
        confirm: "Run depeg history audit (dry-run)?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: false,
      },
      {
        label: "Backfill DEWS",
        path: "/api/backfill-dews",
        confirm: "Run DEWS historical backfill validation?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: false,
      },
    ]);
  });

  it("keeps strict contract path list unique", () => {
    expect(new Set(STRICT_CONTRACT_PATHS_LIST).size).toBe(STRICT_CONTRACT_PATHS_LIST.length);
  });

  it("keeps smoke endpoint assertions aligned with strict contract paths", () => {
    expect(() => assertPathCoverage(STRICT_CONTRACT_PATHS_LIST, ENDPOINT_ASSERTIONS)).not.toThrow();
  });
});
