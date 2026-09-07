export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface Env {
  DB: D1Database;
  TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT: RateLimit;
  TELEGRAM_WEBHOOK_SOURCE_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_SESSION_SOURCE_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_MUTATION_SOURCE_RATE_LIMIT: RateLimit;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  CORS_ORIGIN: string;
  SELF_URL?: string;
  OPS_UI_ORIGIN?: string;
  OPS_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
  SITE_API_SHARED_SECRET_PREVIOUS?: string;
  API_KEY_HASH_PEPPER?: string;
  API_KEY_HASH_PEPPER_PREVIOUS?: string;
  API_KEY_SELF_SERVE_IP_SALT?: string;
  API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER?: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER?: string;
  API_KEY_SELF_SERVE_EMAIL_FROM?: string;
  API_KEY_SELF_SERVE_EMAIL_REPLY_TO?: string;
  API_KEY_SELF_SERVE_PUBLIC_BASE_URL?: string;
  RESEND_API_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_OPS_UI_AUD?: string;
  CF_ACCESS_OPS_API_AUD?: string;
  ETHERSCAN_API_KEY?: string;
  TRONGRID_API_KEY?: string;
  DRPC_API_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ADDRESS_PRICE_PROVIDERS_ENABLED?: string;
  GRAPH_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CMC_API_KEY?: string;
  JUPITER_API_KEY?: string;
  M0_API_KEY?: string;
  COINGECKO_API_KEY?: string;
  VAULTS_FYI_API_KEY?: string;
  VAULTS_FYI_ENABLED?: string;
  VAULTS_FYI_RANKABLE_VAULTS?: string;
  VAULTS_FYI_MAX_CREDITS_PER_RUN?: string;
  VAULTS_FYI_MAX_CREDITS_PER_MONTH?: string;
  VAULTS_FYI_MAX_PAGES_PER_RUN?: string;
  GITHUB_PAT?: string;
  FEEDBACK_IP_SALT?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN_PREVIOUS?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_OPERATOR_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET_PREVIOUS?: string;
  TELEGRAM_RECAP_ROLLOUT_MODE?: string;
  TELEGRAM_RECAP_ROLLOUT_CHAT_IDS?: string;
  MINT_BURN_DISABLED_IDS?: string;
  MINT_BURN_DISABLED_SYMBOLS?: string;
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
  OPENEXCHANGERATES_API_KEY?: string;
  BANXICO_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_STATUS_API_TOKEN?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  MAINTENANCE_MODE?: string;
  REQUEST_SOURCE_ATTRIBUTION_DISABLED?: string;
  API_KEY_REQUEST_ATTRIBUTION_DISABLED?: string;
  DDR_REPAIR_TASK_RUNNER_ENABLED?: string;
  WORKER_RESERVE_RECOVERY_MODE?: string;
  WORKER_CANARY_MODE?: string;
  WORKER_V9_WORKFLOW_MODE?: string;
}

export interface WorkerEnvIssue {
  code:
    | "ops-access-partial-config"
    | "d1-status-partial-config"
    | "site-api-secret-misconfigured"
    | "feedback-env-misconfigured"
    | "api-key-self-serve-env-misconfigured"
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

export type VaultsFyiRuntimeConfig =
  | {
      enabled: false;
      disabledReason: "not-enabled" | "no-key" | "invalid-enabled-flag";
      apiKey: null;
      rankableVaults: [];
      maxCreditsPerRun: null;
      maxCreditsPerMonth: null;
      maxPagesPerRun: null;
    }
  | {
      enabled: true;
      disabledReason: null;
      apiKey: string;
      rankableVaults: string[];
      maxCreditsPerRun: number | null;
      maxCreditsPerMonth: number | null;
      maxPagesPerRun: number | null;
    };

import { hasConfiguredValue, getConfiguredValue } from "@shared/lib/env-utils";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";

export const WORKER_REQUIRED_ENV_KEYS = getRuntimeEnvKeys("worker", "required");
export const WORKER_OPTIONAL_ENV_KEYS = getRuntimeEnvKeys("worker", "optional");
export const WORKER_RESERVED_ENV_KEYS = getRuntimeEnvKeys("worker", "reserved");
export const WORKER_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("worker");

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function parsePositiveIntegerEnv(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
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

export function resolveVaultsFyiConfig(
  env: Pick<
    Env,
    | "VAULTS_FYI_API_KEY"
    | "VAULTS_FYI_ENABLED"
    | "VAULTS_FYI_RANKABLE_VAULTS"
    | "VAULTS_FYI_MAX_CREDITS_PER_RUN"
    | "VAULTS_FYI_MAX_CREDITS_PER_MONTH"
    | "VAULTS_FYI_MAX_PAGES_PER_RUN"
  >,
): VaultsFyiRuntimeConfig {
  const enabledFlag = parseBooleanEnv(env.VAULTS_FYI_ENABLED);
  const explicitlyEnabled = enabledFlag === true;
  const apiKey = getConfiguredValue(env.VAULTS_FYI_API_KEY);
  if (!explicitlyEnabled || !apiKey) {
    const hasEnableValue = Boolean(env.VAULTS_FYI_ENABLED?.trim());
    return {
      enabled: false,
      disabledReason: explicitlyEnabled
        ? "no-key"
        : hasEnableValue && enabledFlag === null
          ? "invalid-enabled-flag"
          : "not-enabled",
      apiKey: null,
      rankableVaults: [],
      maxCreditsPerRun: null,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    };
  }
  return {
    enabled: true,
    disabledReason: null,
    apiKey,
    rankableVaults: parseCsvEnv(env.VAULTS_FYI_RANKABLE_VAULTS),
    maxCreditsPerRun: parsePositiveIntegerEnv(env.VAULTS_FYI_MAX_CREDITS_PER_RUN),
    maxCreditsPerMonth: parsePositiveIntegerEnv(env.VAULTS_FYI_MAX_CREDITS_PER_MONTH),
    maxPagesPerRun: parsePositiveIntegerEnv(env.VAULTS_FYI_MAX_PAGES_PER_RUN),
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
    | "API_KEY_SELF_SERVE_IP_SALT"
    | "API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER"
    | "API_KEY_SELF_SERVE_REQUEST_PEPPER"
    | "API_KEY_SELF_SERVE_EMAIL_FROM"
    | "API_KEY_SELF_SERVE_EMAIL_REPLY_TO"
    | "API_KEY_SELF_SERVE_PUBLIC_BASE_URL"
    | "RESEND_API_KEY"
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

  const hasSelfServeBinding =
    hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT) ||
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER) ||
    hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER) ||
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_FROM) ||
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO) ||
    hasConfiguredValue(env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL) ||
    hasConfiguredValue(env.RESEND_API_KEY);
  const hasSelfServeConfig =
    hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT) &&
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER) &&
    hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER) &&
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_FROM) &&
    hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO) &&
    hasConfiguredValue(env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL) &&
    hasConfiguredValue(env.RESEND_API_KEY);
  if (hasSelfServeBinding && !hasSelfServeConfig) {
    issues.push({
      code: "api-key-self-serve-env-misconfigured",
      message:
        "Self-serve API key email verification bindings must be configured together; POST /api/api-key-requests returns 503 until they are complete.",
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
