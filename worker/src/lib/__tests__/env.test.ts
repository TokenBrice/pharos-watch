import { describe, expect, it } from "vitest";
import {
  validateWorkerEnvContract,
  WORKER_ACTIVE_ENV_KEYS,
  WORKER_OPTIONAL_ENV_KEYS,
  WORKER_REQUIRED_ENV_KEYS,
  WORKER_RESERVED_ENV_KEYS,
} from "../env";

describe("validateWorkerEnvContract", () => {
  it("flags partial Access config", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: undefined,
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: "pepper",
      FEEDBACK_IP_SALT: undefined,
    })).toContainEqual({
      code: "ops-access-partial-config",
      message: "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
    });
  });

  it("flags partial admin D1 status config", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: "pepper",
      FEEDBACK_IP_SALT: "feedback",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_D1_STATUS_API_TOKEN: undefined,
      CLOUDFLARE_D1_DATABASE_ID: "db-id",
    })).toContainEqual({
      code: "d1-status-partial-config",
      message: "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 status metrics.",
    });
  });

  it("flags a missing site-api shared secret", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      SITE_API_SHARED_SECRET: undefined,
      API_KEY_HASH_PEPPER: "pepper",
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "site-api-secret-misconfigured",
      message: "SITE_API_SHARED_SECRET is unset; the website site-api lane cannot authenticate until the shared secret is configured.",
    });
  });

  it("keeps the site-api overlap secret in the active worker binding set", () => {
    expect(WORKER_ACTIVE_ENV_KEYS).toContain("SITE_API_SHARED_SECRET_PREVIOUS");
  });

  it("flags a missing API-key pepper", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: undefined,
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "public-api-auth-pepper-missing",
      message: "API_KEY_HASH_PEPPER must be configured; /api/* requires a valid X-API-Key.",
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
