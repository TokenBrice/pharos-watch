import { describe, expect, it } from "vitest";
import {
  SITE_DATA_PATH_PREFIX,
  isSiteDataPath,
  resolveSiteDataUpstreamPath,
  toSiteDataPath,
} from "../site-data-routes";

describe("site-data route mapping", () => {
  it("maps allowlisted API paths to the site-data prefix", () => {
    expect(SITE_DATA_PATH_PREFIX).toBe("/_site-data");
    expect(toSiteDataPath("/api/stablecoins")).toBe("/_site-data/stablecoins");
    expect(toSiteDataPath("/api/stablecoin/usdt-tether")).toBe("/_site-data/stablecoin/usdt-tether");
  });

  it("resolves allowlisted site-data requests back to API paths", () => {
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoins")).toBe("/api/stablecoins");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin/usdt-tether")).toBe("/api/stablecoin/usdt-tether");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin-summary/usdt-tether")).toBe("/api/stablecoin-summary/usdt-tether");
    expect(resolveSiteDataUpstreamPath("/_site-data/stablecoin-reserves/iusd-infinifi")).toBe("/api/stablecoin-reserves/iusd-infinifi");
    expect(resolveSiteDataUpstreamPath("/_site-data/public-status-history")).toBe("/api/public-status-history");
    expect(resolveSiteDataUpstreamPath("/_site-data/telegram-pulse")).toBe("/api/telegram-pulse");
  });

  it("rejects non-allowlisted or malformed site-data paths", () => {
    expect(resolveSiteDataUpstreamPath("/_site-data")).toBeNull();
    expect(resolveSiteDataUpstreamPath("/_site-data/status")).toBeNull();
    expect(resolveSiteDataUpstreamPath("/api/stablecoins")).toBeNull();
    expect(isSiteDataPath("/_site-data/stablecoins")).toBe(true);
    expect(isSiteDataPath("/_site-data/status")).toBe(false);
  });

  it("throws when mapping a non-API path into the site-data namespace", () => {
    expect(() => toSiteDataPath("/status")).toThrow("Site-data mapping requires an /api/* path");
  });
});
