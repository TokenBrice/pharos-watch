import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import {
  DEFAULT_SITE_API_ORIGIN,
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

  it("falls back to the default site API origin", () => {
    expect(resolveSiteApiOrigin({ SITE_API_ORIGIN: undefined })).toBe(DEFAULT_SITE_API_ORIGIN);
    expect(DEFAULT_SITE_API_ORIGIN).toBe(API_ORIGIN);
  });

  it("requires the shared secret", () => {
    expect(validatePagesSiteDataProxyEnv({ SITE_API_SHARED_SECRET: undefined })).toEqual([
      {
        code: "site-api-secret-missing",
        message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
      },
    ]);
  });
});
