import { describe, expect, it } from "vitest";
import type { Env, WorkerEnvIssue } from "../env";
import {
  resolveDdrRepairTaskRunnerConfig,
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

