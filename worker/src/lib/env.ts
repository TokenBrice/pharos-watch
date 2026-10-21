import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import type { RuntimeEnv } from "@shared/lib/env-contract";
import { DWELLIR_CHAINS } from "@shared/lib/dwellir-chains";
import { DWELLIR_NATIVE_ENDPOINTS } from "@shared/lib/dwellir-native-endpoints";
import { logWorkerEvent } from "./structured-log";

export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

interface WorkerBindingValues {
  string: string;
  D1Database: D1Database;
  RateLimit: RateLimit;
  WorkerVersionMetadata: WorkerVersionMetadata;
  R2Bucket: R2Bucket;
  Fetcher: Fetcher;
  "Queue<ReserveContinuationMessage>": Queue<ReserveContinuationMessage>;
}

export type Env = RuntimeEnv<"worker", WorkerBindingValues>;

/** Scheduled execution has no HTTP CORS or rate-limit bindings. */
export type ScheduledEnv = Pick<Env, "DB" | "CF_VERSION_METADATA"> &
  Partial<Omit<Env,
    | "DB"
    | "CF_VERSION_METADATA"
    | "CORS_ORIGIN"
    | "TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT"
    | "TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT"
    | "TELEGRAM_MINI_APP_SESSION_SOURCE_RATE_LIMIT"
    | "TELEGRAM_MINI_APP_MUTATION_SOURCE_RATE_LIMIT"
    | "DONOR_KEY_CLAIM_RATE_LIMIT"
    | "SAFETY_GRADES_RATE_LIMIT"
  >>;

export type HeavyEnv = Omit<ScheduledEnv, "M0_API_KEY"> & {
  SAFETY_CAPTURE_ARCHIVE: R2Bucket;
};

export interface WorkerEnvIssue {
  code:
    | "ops-access-partial-config"
    | "d1-status-partial-config"
    | "site-api-secret-misconfigured"
    | "feedback-env-misconfigured"
    | "public-api-auth-pepper-missing"
    | "api-key-pepper-noop-rotation"
    | "banxico-token-missing"
    | "telegram-env-misconfigured";
  message: string;
}

export interface CloudflareD1StatusBindings {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_STATUS_API_TOKEN?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
}

export interface CloudflareD1StatusConfig {
  accountId: string;
  apiToken: string;
  databaseId: string;
}


import { hasConfiguredValue, getConfiguredValue } from "@shared/lib/env-utils";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";

export const WORKER_RESERVED_ENV_KEYS = getRuntimeEnvKeys("worker", "reserved");
export const WORKER_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("worker");

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Normalize operator rollback IDs and report all unknown entries once per parse. */
export function parseDwellirRoutingDisabledChains(value: string | undefined): ReadonlySet<string> {
  const requested = new Set(parseCsvEnv(value).map((chain) => chain.toLowerCase()));
  const knownChains = new Set([
    ...DWELLIR_CHAINS.map((chain) => chain.chainId),
    ...DWELLIR_NATIVE_ENDPOINTS.map((endpoint) => endpoint.network),
  ]);
  const unknownChains = [...requested].filter((chain) => !knownChains.has(chain));
  if (unknownChains.length > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dwellir_routing_disabled_unknown_chains",
      message: "Dwellir routing rollback contains unknown chain IDs",
      provider: "dwellir",
      metadata: { unknownChains },
    });
  }
  return new Set([...requested].filter((chain) => knownChains.has(chain)));
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}


export interface DdrRepairTaskRunnerWarning {
  code: "invalid-ddr-repair-task-runner-enabled";
  message: string;
}

export interface DdrRepairTaskRunnerConfig {
  enabled: boolean;
  warning: DdrRepairTaskRunnerWarning | null;
}

export function resolveDdrRepairTaskRunnerConfig(
  env: Pick<Env, "DDR_REPAIR_TASK_RUNNER_ENABLED">,
): DdrRepairTaskRunnerConfig {
  const value = env.DDR_REPAIR_TASK_RUNNER_ENABLED;
  const normalized = value?.trim();
  if (!normalized) {
    return { enabled: true, warning: null };
  }

  const enabled = parseBooleanEnv(value);
  if (enabled != null) {
    return { enabled, warning: null };
  }

  return {
    enabled: false,
    warning: {
      code: "invalid-ddr-repair-task-runner-enabled",
      message:
        "DDR_REPAIR_TASK_RUNNER_ENABLED must use an accepted on/off value; the DDR repair runner is disabled for this run.",
    },
  };
}


export function hasAnyCloudflareD1StatusBinding(env: CloudflareD1StatusBindings): boolean {
  return (
    hasConfiguredValue(env.CLOUDFLARE_ACCOUNT_ID) ||
    hasConfiguredValue(env.CLOUDFLARE_D1_STATUS_API_TOKEN) ||
    hasConfiguredValue(env.CLOUDFLARE_D1_DATABASE_ID)
  );
}

export function resolveCloudflareD1StatusConfig(env: CloudflareD1StatusBindings): CloudflareD1StatusConfig | null {
  const accountId = getConfiguredValue(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = getConfiguredValue(env.CLOUDFLARE_D1_STATUS_API_TOKEN);
  const databaseId = getConfiguredValue(env.CLOUDFLARE_D1_DATABASE_ID);

  if (accountId && apiToken && databaseId) {
    return {
      accountId,
      apiToken,
      databaseId,
    };
  }
  return null;
}

export function validateWorkerEnvContract(
  env: Pick<
    Env,
    | "CF_ACCESS_OPS_API_AUD"
    | "CF_ACCESS_TEAM_DOMAIN"
    | "SITE_API_SHARED_SECRET"
    | "API_KEY_HASH_PEPPER"
    | "API_KEY_HASH_PEPPER_PREVIOUS"
    | "GITHUB_PAT"
    | "FEEDBACK_IP_SALT"
    | "BANXICO_TOKEN"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_D1_STATUS_API_TOKEN"
    | "CLOUDFLARE_D1_DATABASE_ID"
    | "TELEGRAM_BOT_TOKEN"
    | "TELEGRAM_BOT_TOKEN_PREVIOUS"
    | "TELEGRAM_WEBHOOK_SECRET"
    | "TELEGRAM_WEBHOOK_SECRET_PREVIOUS"
  >,
): WorkerEnvIssue[] {
  const issues: WorkerEnvIssue[] = [];

  const hasOpsApiAud = hasConfiguredValue(env.CF_ACCESS_OPS_API_AUD);
  const hasAccessTeamDomain = hasConfiguredValue(env.CF_ACCESS_TEAM_DOMAIN);
  if (hasOpsApiAud !== hasAccessTeamDomain) {
    issues.push({
      code: "ops-access-partial-config",
      message:
        "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
    });
  }

  const hasCloudflareD1StatusBinding = hasAnyCloudflareD1StatusBinding(env);
  const hasCloudflareD1StatusConfig = resolveCloudflareD1StatusConfig(env) != null;
  if (hasCloudflareD1StatusBinding && !hasCloudflareD1StatusConfig) {
    issues.push({
      code: "d1-status-partial-config",
      message:
        "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 status metrics.",
    });
  }

  if (!hasConfiguredValue(env.SITE_API_SHARED_SECRET)) {
    issues.push({
      code: "site-api-secret-misconfigured",
      message:
        "SITE_API_SHARED_SECRET is unset; the website site-api lane cannot authenticate until the shared secret is configured.",
    });
  }

  if (!hasConfiguredValue(env.GITHUB_PAT) || !hasConfiguredValue(env.FEEDBACK_IP_SALT)) {
    issues.push({
      code: "feedback-env-misconfigured",
      message:
        "GITHUB_PAT and FEEDBACK_IP_SALT must be configured together; POST /api/feedback returns 503 until both are set.",
    });
  }

  if (!hasConfiguredValue(env.API_KEY_HASH_PEPPER)) {
    issues.push({
      code: "public-api-auth-pepper-missing",
      message: "API_KEY_HASH_PEPPER must be configured; /api/* requires a valid X-API-Key.",
    });
  }

  if (
    hasConfiguredValue(env.API_KEY_HASH_PEPPER_PREVIOUS) &&
    hasConfiguredValue(env.API_KEY_HASH_PEPPER) &&
    env.API_KEY_HASH_PEPPER_PREVIOUS?.trim() === env.API_KEY_HASH_PEPPER?.trim()
  ) {
    issues.push({
      code: "api-key-pepper-noop-rotation",
      message: "API_KEY_HASH_PEPPER_PREVIOUS is identical to API_KEY_HASH_PEPPER — this is a no-op rotation.",
    });
  }

  if (!hasConfiguredValue(env.BANXICO_TOKEN)) {
    issues.push({
      code: "banxico-token-missing",
      message:
        "BANXICO_TOKEN must be configured; fetch-tbill-rate cannot refresh the official MXN CETES benchmark without it.",
    });
  }

  const hasTelegramBotToken = hasConfiguredValue(env.TELEGRAM_BOT_TOKEN);
  const hasTelegramBotTokenPrevious = hasConfiguredValue(env.TELEGRAM_BOT_TOKEN_PREVIOUS);
  const hasTelegramWebhookSecret = hasConfiguredValue(env.TELEGRAM_WEBHOOK_SECRET);
  const hasTelegramWebhookSecretPrevious = hasConfiguredValue(env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS);

  if (hasTelegramBotToken && !hasTelegramWebhookSecret) {
    issues.push({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_BOT_TOKEN is configured without TELEGRAM_WEBHOOK_SECRET; Telegram webhook registration is skipped until both are set.",
    });
  }

  if (hasTelegramWebhookSecret && !hasTelegramBotToken) {
    issues.push({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_WEBHOOK_SECRET is configured without TELEGRAM_BOT_TOKEN; Telegram webhook requests cannot be reconciled until both are set.",
    });
  }

  if (hasTelegramBotTokenPrevious && !hasTelegramBotToken) {
    issues.push({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_BOT_TOKEN_PREVIOUS is configured without TELEGRAM_BOT_TOKEN; remove the previous token or restore the current Telegram bot token.",
    });
  }

  if (hasTelegramWebhookSecretPrevious && !hasTelegramWebhookSecret) {
    issues.push({
      code: "telegram-env-misconfigured",
      message:
        "TELEGRAM_WEBHOOK_SECRET_PREVIOUS is configured without TELEGRAM_WEBHOOK_SECRET; remove the previous secret or restore the current Telegram webhook secret.",
    });
  }

  return issues;
}
