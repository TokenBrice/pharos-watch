import { describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  OPS_API_ORIGIN,
  OPS_UI_ORIGIN,
  PAGES_APP_ORIGIN,
  SITE_ORIGIN,
  isCanonicalSiteHostname,
  resolveOrigin,
} from "../runtime-origins";

describe("runtime origins", () => {
  it("uses the canonical production origins", () => {
    expect(SITE_ORIGIN).toBe("https://pharos.watch");
    expect(API_ORIGIN).toBe("https://api.pharos.watch");
    expect(OPS_UI_ORIGIN).toBe("https://ops.pharos.watch");
    expect(OPS_API_ORIGIN).toBe("https://ops-api.pharos.watch");
    expect(PAGES_APP_ORIGIN).toBe("https://stablecoin-dashboard.pages.dev");
  });

  it("normalizes configured origins and falls back on invalid input", () => {
    expect(resolveOrigin("ops.pharos.watch/admin", SITE_ORIGIN)).toBe("https://ops.pharos.watch");
    expect(resolveOrigin("not a valid host name", API_ORIGIN)).toBe(API_ORIGIN);
    expect(resolveOrigin(undefined, OPS_UI_ORIGIN)).toBe(OPS_UI_ORIGIN);
  });

  it("recognizes canonical site and Pages hostnames", () => {
    expect(isCanonicalSiteHostname("pharos.watch")).toBe(true);
    expect(isCanonicalSiteHostname("preview.pharos.watch")).toBe(true);
    expect(isCanonicalSiteHostname("stablecoin-dashboard.pages.dev")).toBe(true);
    expect(isCanonicalSiteHostname("branch.stablecoin-dashboard.pages.dev")).toBe(true);
    expect(isCanonicalSiteHostname("example.com")).toBe(false);
  });
});
