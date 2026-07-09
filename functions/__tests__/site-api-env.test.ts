import { describe, expect, it } from "vitest";
import {
  SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS,
  SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS,
  SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS,
  resolveSiteApiOrigin,
  validatePagesSiteDataProxyEnv,
} from "../lib/site-api-env";

describe("site-data env contract", () => {
  it("derives the active Pages binding set from required and optional bindings", () => {
    expect(SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS).toEqual([
      ...SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS,
      ...SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS,
    ]);
  });

  it("returns null when SITE_API_ORIGIN is unset or malformed", () => {
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: undefined })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "not a url" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "http://site-api.pharos.watch" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "ftp://site-api.pharos.watch" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "https://attacker.example" })).toBeNull();
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "https://site-api.pharos.watch/path" })).toBeNull();
  });

  it("normalizes a configured SITE_API_ORIGIN", () => {
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "https://site-api.pharos.watch" }))
      .toBe("https://site-api.pharos.watch");
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: "site-api.pharos.watch" }))
      .toBe("https://site-api.pharos.watch");
  });

  it("flags missing SITE_API_ORIGIN, secret, and DB", () => {
    expect(
      validatePagesSiteDataProxyEnv({
        SITE_API_ORIGIN: undefined,
        SITE_API_SHARED_SECRET: undefined,
        DB: undefined,
      }),
    ).toEqual([
      {
        code: "site-api-origin-missing",
        message: "SITE_API_ORIGIN must be configured for the site-data proxy.",
      },
      {
        code: "site-api-secret-missing",
        message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
      },
      {
        code: "site-data-db-missing",
        message: "DB is optional for the Pages site-data proxy, but attribution telemetry is disabled when it is not bound.",
      },
    ]);
  });

  it("passes validation when all bindings are configured", () => {
    expect(
      validatePagesSiteDataProxyEnv({
        SITE_API_ORIGIN: "https://site-api.pharos.watch",
        SITE_API_SHARED_SECRET: "shared-secret",
        DB: {} as never,
      }),
    ).toEqual([]);
  });

  it("flags non-canonical credential-bearing origins", () => {
    expect(
      validatePagesSiteDataProxyEnv({
        SITE_API_ORIGIN: "https://attacker.example",
        SITE_API_SHARED_SECRET: "shared-secret",
        DB: {} as never,
      }),
    ).toContainEqual({
      code: "site-api-origin-invalid",
      message: "SITE_API_ORIGIN must be the canonical HTTPS origin https://site-api.pharos.watch.",
    });
  });
});
