import { describe, expect, it } from "vitest";
import { resolveSiteApiOrigin } from "../lib/site-api-env";

describe("site-data env contract", () => {
  it("returns null when SITE_API_ORIGIN is unset or malformed", () => {
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: undefined })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "not a url" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "http://site-api.pharos.watch" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "ftp://site-api.pharos.watch" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "https://attacker.example" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "https://site-api.pharos.watch/path" })).toBeNull();
  });

});
