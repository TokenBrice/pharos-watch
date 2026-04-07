import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import {
  DEFAULT_SITE_API_ORIGIN,
  SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS,
  SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS,
  SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS,
  resolveSiteDataProxyRuntimePolicy,
  resolveSiteApiOrigin,
  resolveSiteDataUpstreamLane,
  validatePagesSiteDataProxyEnv,
} from "../lib/site-api-env";

describe("site-data env contract", () => {
  it("derives the active Pages binding set from required and optional bindings", () => {
    expect(SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS).toEqual([
      ...SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS,
      ...SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS,
    ]);
  });

  it("falls back to the default site API origin only when the runtime policy allows it", () => {
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: undefined })).toBe(DEFAULT_SITE_API_ORIGIN);
    expect(DEFAULT_SITE_API_ORIGIN).toBe(API_ORIGIN);
    expect(resolveSiteDataUpstreamLane({ SITE_API_ORIGIN: undefined })).toBe("public-api-fallback");
    expect(resolveSiteDataUpstreamLane({ SITE_API_ORIGIN: "https://site-api.pharos.watch" })).toBe("site-api");
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: undefined }, { allowPublicApiFallback: false })).toBeNull();
  });

  it("requires an explicit site-api origin on production Pages hosts only", () => {
    expect(resolveSiteDataProxyRuntimePolicy(new URL("https://pharos.watch/_site-data/stablecoins"))).toEqual({
      allowPublicApiFallback: false,
      hostKind: "production",
    });
    expect(resolveSiteDataProxyRuntimePolicy(new URL("https://ops.pharos.watch/_site-data/stablecoins"))).toEqual({
      allowPublicApiFallback: false,
      hostKind: "production",
    });
    expect(resolveSiteDataProxyRuntimePolicy(new URL("https://stablecoin-dashboard.pages.dev/_site-data/stablecoins"))).toEqual({
      allowPublicApiFallback: true,
      hostKind: "preview-or-local",
    });
    expect(resolveSiteDataProxyRuntimePolicy(new URL("http://127.0.0.1:8788/_site-data/stablecoins"))).toEqual({
      allowPublicApiFallback: true,
      hostKind: "preview-or-local",
    });
  });

  it("requires the shared secret and Pages DB binding", () => {
    expect(validatePagesSiteDataProxyEnv({ SITE_API_SHARED_SECRET: undefined, DB: undefined })).toEqual([
      {
        code: "site-api-secret-missing",
        message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
      },
      {
        code: "site-data-db-missing",
        message: "DB must be bound on the Pages project for durable site-data attribution telemetry.",
      },
    ]);
  });

  it("adds a production-only config error when SITE_API_ORIGIN is missing", () => {
    expect(
      validatePagesSiteDataProxyEnv(
        { SITE_API_ORIGIN: undefined, SITE_API_SHARED_SECRET: "shared-secret", DB: {} as never },
        { requireSiteApiOrigin: true },
      ),
    ).toEqual([
      {
        code: "site-api-origin-missing",
        message: "SITE_API_ORIGIN must be configured for production site-data proxy traffic.",
      },
    ]);
  });
});
