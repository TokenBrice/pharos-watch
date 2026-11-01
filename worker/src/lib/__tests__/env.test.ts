import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Env, HeavyEnv, ScheduledEnv, WorkerEnvIssue, WorkerVersionMetadata } from "../env";
import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import type { SlotCatchUpMessage } from "@shared/types/slot-catch-up";
import {
  parseDwellirRoutingDisabledChains,
  resolveDdrRepairTaskRunnerConfig,
  validateWorkerEnvContract,
  WORKER_ACTIVE_ENV_KEYS,
  WORKER_RESERVED_ENV_KEYS,
} from "../env";

type RequiredKeys<Value> = {
  [Key in keyof Value]-?: Record<never, never> extends Pick<Value, Key> ? never : Key;
}[keyof Value];

it("preserves manifest-derived HTTP, scheduled and heavy ingress types", () => {
  expectTypeOf<RequiredKeys<Env>>().toEqualTypeOf<
    | "DB" | "CF_VERSION_METADATA" | "CORS_ORIGIN"
    | "TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT" | "TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT"
    | "TELEGRAM_MINI_APP_SESSION_SOURCE_RATE_LIMIT" | "TELEGRAM_MINI_APP_MUTATION_SOURCE_RATE_LIMIT"
    | "DONOR_KEY_CLAIM_RATE_LIMIT" | "SAFETY_GRADES_RATE_LIMIT" | "FEEDBACK_PREAUTH_RATE_LIMIT"
  >();
  expectTypeOf<Pick<Env, "GITHUB_PAT" | "FEEDBACK_IP_SALT" | "BANXICO_TOKEN">>()
    .toEqualTypeOf<{ GITHUB_PAT?: string; FEEDBACK_IP_SALT?: string; BANXICO_TOKEN?: string }>();
  expectTypeOf<Env["DB"]>().toEqualTypeOf<D1Database>();
  expectTypeOf<Env["CF_VERSION_METADATA"]>().toEqualTypeOf<WorkerVersionMetadata>();
  expectTypeOf<Env["TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT"]>().toEqualTypeOf<RateLimit>();
  expectTypeOf<Env["SAFETY_CAPTURE_ARCHIVE"]>().toEqualTypeOf<R2Bucket | undefined>();
  expectTypeOf<Env["HEAVY_EXECUTOR"]>().toEqualTypeOf<Fetcher | undefined>();
  expectTypeOf<Env["RESERVE_CONTINUATION_QUEUE"]>().toEqualTypeOf<Queue<ReserveContinuationMessage | SlotCatchUpMessage> | undefined>();
  expectTypeOf<RequiredKeys<ScheduledEnv>>().toEqualTypeOf<"DB" | "CF_VERSION_METADATA">();
  expectTypeOf<Extract<keyof ScheduledEnv, "CORS_ORIGIN" | "SAFETY_GRADES_RATE_LIMIT" | "FEEDBACK_PREAUTH_RATE_LIMIT">>().toEqualTypeOf<never>();
  expectTypeOf<RequiredKeys<HeavyEnv>>().toEqualTypeOf<"DB" | "CF_VERSION_METADATA" | "SAFETY_CAPTURE_ARCHIVE">();
  expectTypeOf<HeavyEnv["SAFETY_CAPTURE_ARCHIVE"]>().toEqualTypeOf<R2Bucket>();
  expectTypeOf<Extract<keyof HeavyEnv, "M0_API_KEY">>().toEqualTypeOf<never>();
});

describe("parseDwellirRoutingDisabledChains", () => {
  it("trims, lowercases and deduplicates known IDs", () => {
    expect([...parseDwellirRoutingDisabledChains(" Gnosis,BASE, gnosis, ,Mantle ")])
      .toEqual(["gnosis", "base", "mantle"]);
    expect([...parseDwellirRoutingDisabledChains(undefined)]).toEqual([]);
  });

  it("recognizes all reviewed native network rollback IDs", () => {
    expect([...parseDwellirRoutingDisabledChains(" Aptos, MOVEMENT, tron, Starknet, aptos ")])
      .toEqual(["aptos", "movement", "tron", "starknet"]);
  });

  it("logs one structured warning for all unknown IDs without admitting them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect([...parseDwellirRoutingDisabledChains("Gnosis,typo, TYPO,missing")]).toEqual(["gnosis"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "dwellir_routing_disabled_unknown_chains",
        metadata: { unknownChains: ["typo", "missing"] },
      });
    } finally {
      warn.mockRestore();
    }
  });
});

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

});
