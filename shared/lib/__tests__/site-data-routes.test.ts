import { describe, expect, it } from "vitest";
import {
  SITE_DATA_ALLOWED_METHOD,
  SITE_DATA_PATH_PREFIX,
  SITE_DATA_PROXY_SECRET_HEADER,
  hostnameOfSiteDataCallerHeader,
  isSiteDataAllowedApiPath,
  isSiteDataAllowedMethod,
  isSiteDataAllowedUiHostname,
  isSiteDataPath,
  resolveSiteDataProxyPath,
  resolveSiteDataUpstreamPath,
  toSiteDataPath,
} from "../site-data-lane";

describe("site-data route mapping", () => {
  it("maps allowlisted API paths to the site-data prefix", () => {
    expect(SITE_DATA_PATH_PREFIX).toBe("/_site-data");
    expect(SITE_DATA_ALLOWED_METHOD).toBe("GET");
    expect(SITE_DATA_PROXY_SECRET_HEADER).toBe("X-Pharos-Site-Proxy-Secret");
    expect(toSiteDataPath("/api/stablecoins")).toBe("/_site-data/stablecoins");
    expect(toSiteDataPath("/api/stablecoin/usdt-tether")).toBe("/_site-data/stablecoin/usdt-tether");
    expect(toSiteDataPath("/api/public-status-history?limit=10")).toBe("/_site-data/public-status-history?limit=10");
  });

  it("resolves allowlisted site-data requests back to API paths", () => {
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoins")).toBe("/api/stablecoins");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin/usdt-tether")).toBe("/api/stablecoin/usdt-tether");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin-summary/usdt-tether")).toBe("/api/stablecoin-summary/usdt-tether");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin-reserves/iusd-infinifi")).toBe("/api/stablecoin-reserves/iusd-infinifi");
    expect(resolveSiteDataUpstreamPath("/_site-data/public-status-history")).toBe("/api/public-status-history");
    expect(resolveSiteDataUpstreamPath("/_site-data/public-status-history?limit=10")).toBe("/api/public-status-history?limit=10");
    expect(resolveSiteDataUpstreamPath("/_site-data/telegram-pulse")).toBe("/api/telegram-pulse");
  });

  it("exposes a GET-only allowlist-aware proxy path resolver", () => {
    expect(isSiteDataAllowedMethod("GET")).toBe(true);
    expect(isSiteDataAllowedMethod(undefined)).toBe(true);
    expect(isSiteDataAllowedMethod("post")).toBe(false);
    expect(isSiteDataAllowedApiPath("/api/stablecoins?limit=10")).toBe(true);
    expect(isSiteDataAllowedApiPath("/api/api-key-requests")).toBe(false);
    expect(isSiteDataAllowedApiPath("/api/report-cards/v9-preview")).toBe(false);
    expect(isSiteDataAllowedApiPath("/api/report-cards/v9-preview-412d818c031b7bc5")).toBe(false);
    expect(resolveSiteDataProxyPath("/api/stablecoins?limit=10", "GET")).toBe("/_site-data/stablecoins?limit=10");
    expect(resolveSiteDataProxyPath("/api/report-cards/v9-preview", "GET")).toBeNull();
    expect(resolveSiteDataProxyPath("/api/stablecoins", "POST")).toBeNull();
    expect(resolveSiteDataProxyPath("/api/api-key-requests", "GET")).toBeNull();
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoins", "POST")).toBeNull();
  });

  it("rejects non-allowlisted or malformed site-data paths", () => {
    expect(resolveSiteDataUpstreamPath("/_site-data")).toBeNull();
    expect(resolveSiteDataUpstreamPath("/_site-data/status")).toBeNull();
    expect(resolveSiteDataUpstreamPath("/api/stablecoins")).toBeNull();
    expect(isSiteDataPath("/_site-data/stablecoins")).toBe(true);
    expect(isSiteDataPath("/_site-data/stablecoins", "POST")).toBe(false);
    expect(isSiteDataPath("/_site-data/status")).toBe(false);
  });

  it("throws when mapping a non-API path into the site-data namespace", () => {
    expect(() => toSiteDataPath("/status")).toThrow("Site-data mapping requires an /api/* path");
  });

  it("checks site-data UI hostnames and caller headers without runtime secrets", () => {
    expect(isSiteDataAllowedUiHostname("pharos.watch")).toBe(true);
    expect(isSiteDataAllowedUiHostname("ops.pharos.watch")).toBe(true);
    expect(isSiteDataAllowedUiHostname("preview.stablecoin-dashboard.pages.dev")).toBe(true);
    expect(isSiteDataAllowedUiHostname("custom.example", {
      SITE_ORIGIN: "https://custom.example",
      OPS_UI_ORIGIN: "https://ops.example",
    })).toBe(true);
    expect(isSiteDataAllowedUiHostname("evil.example")).toBe(false);
    expect(hostnameOfSiteDataCallerHeader("https://pharos.watch/stablecoins")).toBe("pharos.watch");
    expect(hostnameOfSiteDataCallerHeader("null")).toBeNull();
    expect(hostnameOfSiteDataCallerHeader("not-a-url")).toBeNull();
  });
});
