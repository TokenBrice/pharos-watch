import { describe, expect, it } from "vitest";
import {
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

describe("validateWorkerEnvContract", () => {
  it("flags partial Access config", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: "public",
      FEEDBACK_IP_SALT: undefined,
    })).toEqual([
      {
        code: "ops-access-partial-config",
        message: "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
      },
    ]);
  });

  it("flags missing public API rate-limit salt", () => {
    expect(validateWorkerEnvContract({
      CF_ACCESS_OPS_API_AUD: undefined,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      PUBLIC_API_RATE_LIMIT_SALT: undefined,
      FEEDBACK_IP_SALT: "feedback",
    })).toContainEqual({
      code: "public-api-rate-limit-misconfigured",
      message: "PUBLIC_API_RATE_LIMIT_SALT is unset; public API rate limiting is disabled until the dedicated salt is configured.",
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
