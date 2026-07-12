import { describe, expect, it } from "vitest";
import {
  isReserveRecoveryFaultInjectionEnabled,
  resolveVaultsFyiConfig,
  validateWorkerEnvContract,
  WORKER_ACTIVE_ENV_KEYS,
  WORKER_OPTIONAL_ENV_KEYS,
  WORKER_REQUIRED_ENV_KEYS,
  WORKER_RESERVED_ENV_KEYS,
} from "../env";

describe("isReserveRecoveryFaultInjectionEnabled", () => {
  it("accepts only a normalized literal true", () => {
    expect(isReserveRecoveryFaultInjectionEnabled(" TRUE ")).toBe(true);
    expect(isReserveRecoveryFaultInjectionEnabled("1")).toBe(false);
    expect(isReserveRecoveryFaultInjectionEnabled("enabled")).toBe(false);
    expect(isReserveRecoveryFaultInjectionEnabled("false")).toBe(false);
    expect(isReserveRecoveryFaultInjectionEnabled(undefined)).toBe(false);
  });
});

describe("validateWorkerEnvContract", () => {
  it("flags partial Access config", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
      }),
    ).toContainEqual({
      code: "ops-access-partial-config",
      message:
        "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
    });
  });

  it("flags partial admin D1 status config", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_D1_STATUS_API_TOKEN: undefined,
        CLOUDFLARE_D1_DATABASE_ID: "db-id",
      }),
    ).toContainEqual({
      code: "d1-status-partial-config",
      message:
        "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 status metrics.",
    });
  });

  it("flags a missing site-api shared secret", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: undefined,
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
      }),
    ).toContainEqual({
      code: "site-api-secret-misconfigured",
      message:
        "SITE_API_SHARED_SECRET is unset; the website site-api lane cannot authenticate until the shared secret is configured.",
    });
  });

  it("keeps the site-api overlap secret in the active worker binding set", () => {
    expect(WORKER_ACTIVE_ENV_KEYS).toContain("SITE_API_SHARED_SECRET_PREVIOUS");
  });

  it("flags a missing API-key pepper", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: undefined,
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
      }),
    ).toContainEqual({
      code: "public-api-auth-pepper-missing",
      message: "API_KEY_HASH_PEPPER must be configured; /api/* requires a valid X-API-Key.",
    });
  });

  it("flags a missing Banxico token", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        BANXICO_TOKEN: undefined,
      }),
    ).toContainEqual({
      code: "banxico-token-missing",
      message:
        "BANXICO_TOKEN must be configured; fetch-tbill-rate cannot refresh the official MXN CETES benchmark without it.",
    });
  });

  it("flags missing feedback submission bindings", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: undefined,
        FEEDBACK_IP_SALT: "feedback",
      }),
    ).toContainEqual({
      code: "feedback-env-misconfigured",
      message:
        "GITHUB_PAT and FEEDBACK_IP_SALT must be configured together; POST /api/feedback returns 503 until both are set.",
    });
  });

  it("flags partial self-serve API key email verification bindings", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        API_KEY_SELF_SERVE_IP_SALT: "ip",
        API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: "email",
        API_KEY_SELF_SERVE_REQUEST_PEPPER: "request",
        API_KEY_SELF_SERVE_EMAIL_FROM: "Pharos API <api@mail.pharos.watch>",
        API_KEY_SELF_SERVE_EMAIL_REPLY_TO: undefined,
        API_KEY_SELF_SERVE_PUBLIC_BASE_URL: "https://pharos.watch/api",
        RESEND_API_KEY: "re_test",
      }),
    ).toContainEqual({
      code: "api-key-self-serve-env-misconfigured",
      message:
        "Self-serve API key email verification bindings must be configured together; POST /api/api-key-requests returns 503 until they are complete.",
    });
  });

  it("flags a Telegram bot token without a webhook secret", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_WEBHOOK_SECRET: undefined,
      }),
    ).toContainEqual({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_BOT_TOKEN is configured without TELEGRAM_WEBHOOK_SECRET; Telegram webhook registration is skipped until both are set.",
    });
  });

  it("flags a Telegram webhook secret without a bot token", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      }),
    ).toContainEqual({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_WEBHOOK_SECRET is configured without TELEGRAM_BOT_TOKEN; Telegram webhook requests cannot be reconciled until both are set.",
    });
  });

  it("flags a previous Telegram bot token without the current bot token", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN_PREVIOUS: "previous-bot-token",
        TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      }),
    ).toContainEqual({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_BOT_TOKEN_PREVIOUS is configured without TELEGRAM_BOT_TOKEN; remove the previous token or restore the current Telegram bot token.",
    });
  });

  it("flags a previous Telegram webhook secret without the current webhook secret", () => {
    expect(
      validateWorkerEnvContract({
        CF_ACCESS_OPS_API_AUD: undefined,
        CF_ACCESS_TEAM_DOMAIN: undefined,
        SITE_API_SHARED_SECRET: "site-secret",
        API_KEY_HASH_PEPPER: "pepper",
        GITHUB_PAT: "ghp_test_token",
        FEEDBACK_IP_SALT: "feedback",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_WEBHOOK_SECRET: undefined,
        TELEGRAM_WEBHOOK_SECRET_PREVIOUS: "previous-webhook-secret",
      }),
    ).toContainEqual({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_WEBHOOK_SECRET_PREVIOUS is configured without TELEGRAM_WEBHOOK_SECRET; remove the previous secret or restore the current Telegram webhook secret.",
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
    expect(WORKER_ACTIVE_ENV_KEYS).toEqual([...WORKER_REQUIRED_ENV_KEYS, ...WORKER_OPTIONAL_ENV_KEYS]);
  });
});

describe("resolveVaultsFyiConfig", () => {
  const disabledVaultsFyiConfig = (
    disabledReason: "not-enabled" | "no-key" | "invalid-enabled-flag" = "not-enabled",
  ) => ({
    enabled: false,
    disabledReason,
    apiKey: null,
    rankableVaults: [],
    maxCreditsPerRun: null,
    maxCreditsPerMonth: null,
    maxPagesPerRun: null,
  });

  it("defaults to disabled when unset", () => {
    expect(resolveVaultsFyiConfig({})).toEqual(disabledVaultsFyiConfig());
  });

  it("requires the explicit enable flag and a configured API key", () => {
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "true",
        VAULTS_FYI_API_KEY: "  vaults-key  ",
      }),
    ).toEqual({
      enabled: true,
      disabledReason: null,
      apiKey: "vaults-key",
      rankableVaults: [],
      maxCreditsPerRun: null,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    });
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_API_KEY: "vaults-key",
      }),
    ).toEqual(disabledVaultsFyiConfig());
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "true",
      }),
    ).toEqual(disabledVaultsFyiConfig("no-key"));
  });

  it("fails open by disabling malformed or false flags", () => {
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "maybe",
        VAULTS_FYI_API_KEY: "vaults-key",
      }),
    ).toEqual(disabledVaultsFyiConfig("invalid-enabled-flag"));
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "off",
        VAULTS_FYI_API_KEY: "vaults-key",
      }),
    ).toEqual(disabledVaultsFyiConfig());
  });

  it("parses optional vaults.fyi caps and rankable allowlist only when enabled", () => {
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "1",
        VAULTS_FYI_API_KEY: "vaults-key",
        VAULTS_FYI_RANKABLE_VAULTS: "base:vault-a, ethereum:vault-b",
        VAULTS_FYI_MAX_CREDITS_PER_RUN: "25",
        VAULTS_FYI_MAX_CREDITS_PER_MONTH: "1000",
        VAULTS_FYI_MAX_PAGES_PER_RUN: "4",
      }),
    ).toEqual({
      enabled: true,
      disabledReason: null,
      apiKey: "vaults-key",
      rankableVaults: ["base:vault-a", "ethereum:vault-b"],
      maxCreditsPerRun: 25,
      maxCreditsPerMonth: 1000,
      maxPagesPerRun: 4,
    });
    expect(
      resolveVaultsFyiConfig({
        VAULTS_FYI_ENABLED: "true",
        VAULTS_FYI_API_KEY: "vaults-key",
        VAULTS_FYI_MAX_CREDITS_PER_RUN: "0",
        VAULTS_FYI_MAX_CREDITS_PER_MONTH: "-1",
        VAULTS_FYI_MAX_PAGES_PER_RUN: "not-a-number",
      }),
    ).toMatchObject({
      maxCreditsPerRun: null,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    });
  });
});
