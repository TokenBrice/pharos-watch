import { describe, expect, it } from "vitest";
import type { Env, WorkerEnvIssue } from "../env";
import {
  resolveDdrRepairTaskRunnerConfig,
  resolveVaultsFyiConfig,
  validateWorkerEnvContract,
  WORKER_ACTIVE_ENV_KEYS,
  WORKER_OPTIONAL_ENV_KEYS,
  WORKER_REQUIRED_ENV_KEYS,
  WORKER_RESERVED_ENV_KEYS,
} from "../env";

describe("resolveDdrRepairTaskRunnerConfig", () => {
  it.each(["1", "true", "yes", "on", "enabled", " TRUE "])('%s enables the repair runner', (value) => {
    expect(resolveDdrRepairTaskRunnerConfig({ DDR_REPAIR_TASK_RUNNER_ENABLED: value })).toEqual({
      enabled: true,
      warning: null,
    });
  });

  it.each(["0", "false", "no", "off", "disabled", " OFF "])('%s disables the repair runner', (value) => {
    expect(resolveDdrRepairTaskRunnerConfig({ DDR_REPAIR_TASK_RUNNER_ENABLED: value })).toEqual({
      enabled: false,
      warning: null,
    });
  });

  it.each([undefined, "", "   "])('defaults absent/empty value %j to enabled', (value) => {
    expect(resolveDdrRepairTaskRunnerConfig({ DDR_REPAIR_TASK_RUNNER_ENABLED: value })).toEqual({
      enabled: true,
      warning: null,
    });
  });

  it("fails closed with a structured warning for an invalid non-empty value", () => {
    expect(resolveDdrRepairTaskRunnerConfig({ DDR_REPAIR_TASK_RUNNER_ENABLED: "maybe" })).toEqual({
      enabled: false,
      warning: {
        code: "invalid-ddr-repair-task-runner-enabled",
        message:
          "DDR_REPAIR_TASK_RUNNER_ENABLED must use an accepted on/off value; the DDR repair runner is disabled for this run.",
      },
    });
  });
});

describe("validateWorkerEnvContract", () => {
  function validEnv(overrides: Partial<Env> = {}) {
    return {
      CF_ACCESS_OPS_API_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "team",
      SITE_API_SHARED_SECRET: "site-secret",
      API_KEY_HASH_PEPPER: "pepper",
      GITHUB_PAT: "ghp_test_token",
      FEEDBACK_IP_SALT: "feedback",
      BANXICO_TOKEN: "banxico",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_D1_STATUS_API_TOKEN: "status-token",
      CLOUDFLARE_D1_DATABASE_ID: "db-id",
      API_KEY_SELF_SERVE_IP_SALT: "ip",
      API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: "email",
      API_KEY_SELF_SERVE_REQUEST_PEPPER: "request",
      API_KEY_SELF_SERVE_EMAIL_FROM: "Pharos API <api@mail.pharos.watch>",
      API_KEY_SELF_SERVE_EMAIL_REPLY_TO: "help@pharos.watch",
      API_KEY_SELF_SERVE_PUBLIC_BASE_URL: "https://pharos.watch/api",
      RESEND_API_KEY: "re_test",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      ...overrides,
    };
  }

  const cases: Array<[string, Partial<Env>, WorkerEnvIssue["code"][]]> = [
    ["complete config", {}, []],
    ["partial Access", { CF_ACCESS_TEAM_DOMAIN: undefined }, ["ops-access-partial-config"]],
    ["partial D1 status", { CLOUDFLARE_D1_STATUS_API_TOKEN: undefined }, ["d1-status-partial-config"]],
    ["missing site secret", { SITE_API_SHARED_SECRET: undefined }, ["site-api-secret-misconfigured"]],
    ["missing API pepper", { API_KEY_HASH_PEPPER: undefined }, ["public-api-auth-pepper-missing"]],
    ["missing Banxico token", { BANXICO_TOKEN: undefined }, ["banxico-token-missing"]],
    ["missing feedback binding", { GITHUB_PAT: undefined }, ["feedback-env-misconfigured"]],
    ["partial email verification", { API_KEY_SELF_SERVE_EMAIL_REPLY_TO: undefined }, ["api-key-self-serve-env-misconfigured"]],
    ["bot without webhook", { TELEGRAM_WEBHOOK_SECRET: undefined }, ["telegram-env-misconfigured"]],
    ["webhook without bot", { TELEGRAM_BOT_TOKEN: undefined }, ["telegram-env-misconfigured"]],
    ["previous bot without current", { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, TELEGRAM_BOT_TOKEN_PREVIOUS: "previous" }, ["telegram-env-misconfigured"]],
    ["previous webhook without current", { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, TELEGRAM_WEBHOOK_SECRET_PREVIOUS: "previous" }, ["telegram-env-misconfigured"]],
    ["valid rotation overlap", { TELEGRAM_BOT_TOKEN_PREVIOUS: "previous-bot", TELEGRAM_WEBHOOK_SECRET_PREVIOUS: "previous-secret" }, []],
  ];
  it.each(cases)("reports only structured warnings for %s", (_label, overrides, codes) => {
    expect(validateWorkerEnvContract(validEnv(overrides)).map(({ code }) => code)).toEqual(codes);
  });

  it("keeps the site-api overlap secret in the active worker binding set", () => {
    expect(WORKER_ACTIVE_ENV_KEYS).toContain("SITE_API_SHARED_SECRET_PREVIOUS");
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
