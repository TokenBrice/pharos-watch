import { describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  OPS_UI_ORIGIN,
  SITE_ORIGIN,
  isCanonicalSiteHostname,
  isPagesAppHostname,
  resolveOrigin,
} from "../runtime-origins";

describe("runtime origins", () => {

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

  it("keeps the site-data host gate narrower than the broader canonical-site helper", () => {
    expect(isPagesAppHostname("stablecoin-dashboard.pages.dev")).toBe(true);
    expect(isPagesAppHostname("branch.stablecoin-dashboard.pages.dev")).toBe(true);
  });
});
