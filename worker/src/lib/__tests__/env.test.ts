import { describe, expect, it } from "vitest";
import {
  resolvePublicApiAuthMode,
  resolvePublicApiRateLimitSalt,
  validateWorkerEnvContract,
  WORKER_ACTIVE_ENV_KEYS,
  WORKER_OPTIONAL_ENV_KEYS,
  WORKER_REQUIRED_ENV_KEYS,
  WORKER_RESERVED_ENV_KEYS,
} from "../env";

describe("resolvePublicApiRateLimitSalt", () => {
  it("prefers the dedicated public API salt", () => {
    expect(resolvePublicApiRateLimitSalt({
      PUBLIC_API_RATE_LIMIT_SALT: "public",
    })).toEqual({
      salt: "public",
      source: "public-api-rate-limit-salt",
    });
  });

  it("returns null when the dedicated public API salt is unset", () => {
    expect(resolvePublicApiRateLimitSalt({
      PUBLIC_API_RATE_LIMIT_SALT: undefined,
    })).toBeNull();
  });
});

describe("resolvePublicApiAuthMode", () => {
  it("defaults to off", () => {
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: undefined })).toBe("off");
  });

  it("accepts the supported auth modes", () => {
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: "report-only" })).toBe("report-only");
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: "enforce" })).toBe("enforce");
  });
});

describe("validateWorkerEnvContract", () => {
  it("flags partial Access config", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: "public",
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: undefined,
      PUBLIC_API_AUTH_MODE: undefined,
      FEEDBACK_IP_SALT: undefined,
    })).toEqual([
      {
        code: "ops-access-partial-config",
        message: "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
      },
    ]);
  });

  it("flags partial admin D1 status config", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: "public",
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: undefined,
      PUBLIC_API_AUTH_MODE: undefined,
      FEEDBACK_IP_SALT: "feedback",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_D1_STATUS_API_TOKEN: undefined,
      CLOUDFLARE_D1_DATABASE_ID: "db-id",
    })).toContainEqual({
      code: "d1-status-partial-config",
      message: "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 status metrics.",
    });
  });

  it("flags missing public API rate-limit salt", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: undefined,
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: undefined,
      PUBLIC_API_AUTH_MODE: undefined,
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "public-api-rate-limit-misconfigured",
      message: "PUBLIC_API_RATE_LIMIT_SALT is unset; public API rate limiting is disabled until the dedicated salt is configured.",
    });
  });

  it("flags a missing site-api shared secret", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: "public",
      SITE_API_SHARED_SECRET: undefined,
      API_KEY_HASH_PEPPER: undefined,
      PUBLIC_API_AUTH_MODE: undefined,
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "site-api-secret-misconfigured",
      message: "SITE_API_SHARED_SECRET is unset; the website site-api lane cannot authenticate until the shared secret is configured.",
    });
  });

  it("flags auth modes beyond off when the API-key pepper is missing", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: "public",
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: undefined,
      PUBLIC_API_AUTH_MODE: "report-only",
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "public-api-auth-pepper-missing",
      message: "API_KEY_HASH_PEPPER must be configured before public API auth mode can move beyond off.",
    });
  });
});

describe("worker env key groups", () => {
  it("keeps active and reserved bindings disjoint", () => {
    const active = new Set<string>(WORKER_ACTIVE_ENV_KEYS);
    for (const key of WORKER_RESERVED_ENV_KEYS) {
      expect(active.has(key)).toBe(false);
    }
  });

  it("derives the active set from required and optional bindings", () => {
    expect(WORKER_ACTIVE_ENV_KEYS).toEqual([
      ...WORKER_REQUIRED_ENV_KEYS,
      ...WORKER_OPTIONAL_ENV_KEYS,
    ]);
  });
});
