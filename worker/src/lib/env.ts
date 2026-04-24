export interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  SELF_URL?: string;
  OPS_UI_ORIGIN?: string;
  OPS_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
  SITE_API_SHARED_SECRET_PREVIOUS?: string;
  API_KEY_HASH_PEPPER?: string;
  API_KEY_HASH_PEPPER_PREVIOUS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_OPS_UI_AUD?: string;
  CF_ACCESS_OPS_API_AUD?: string;
  ETHERSCAN_API_KEY?: string;
  TRONGRID_API_KEY?: string;
  DRPC_API_KEY?: string;
  ALCHEMY_API_KEY?: string;
  GRAPH_API_KEY?: string;
  ALERT_WEBHOOK_URL?: string;
  ANTHROPIC_API_KEY?: string;
  CMC_API_KEY?: string;
  COINGECKO_API_KEY?: string;
  GITHUB_PAT?: string;
  FEEDBACK_IP_SALT?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET_PREVIOUS?: string;
  MINT_BURN_DISABLED_IDS?: string;
  MINT_BURN_DISABLED_SYMBOLS?: string;
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
  OPENEXCHANGERATES_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_STATUS_API_TOKEN?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  MAINTENANCE_MODE?: string;
}

export interface WorkerEnvIssue {
  code:
    | "ops-access-partial-config"
    | "d1-status-partial-config"
    | "site-api-secret-misconfigured"
    | "public-api-auth-pepper-missing"
    | "api-key-pepper-noop-rotation";
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

export function hasAnyCloudflareD1StatusBinding(env: CloudflareD1StatusBindings): boolean {
  return hasConfiguredValue(env.CLOUDFLARE_ACCOUNT_ID)
    || hasConfiguredValue(env.CLOUDFLARE_D1_STATUS_API_TOKEN)
    || hasConfiguredValue(env.CLOUDFLARE_D1_DATABASE_ID);
}

export function resolveCloudflareD1StatusConfig(
  env: CloudflareD1StatusBindings,
): CloudflareD1StatusConfig | null {
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
    | "FEEDBACK_IP_SALT"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_D1_STATUS_API_TOKEN"
    | "CLOUDFLARE_D1_DATABASE_ID"
  >,
): WorkerEnvIssue[] {
  const issues: WorkerEnvIssue[] = [];

  const hasOpsApiAud = hasConfiguredValue(env.CF_ACCESS_OPS_API_AUD);
  const hasAccessTeamDomain = hasConfiguredValue(env.CF_ACCESS_TEAM_DOMAIN);
  if (hasOpsApiAud !== hasAccessTeamDomain) {
    issues.push({
      code: "ops-access-partial-config",
      message: "CF_ACCESS_OPS_API_AUD and CF_ACCESS_TEAM_DOMAIN must be configured together for ops-api Access JWT verification.",
    });
  }

  const hasCloudflareD1StatusBinding = hasAnyCloudflareD1StatusBinding(env);
  const hasCloudflareD1StatusConfig = resolveCloudflareD1StatusConfig(env) != null;
  if (hasCloudflareD1StatusBinding && !hasCloudflareD1StatusConfig) {
    issues.push({
      code: "d1-status-partial-config",
      message: "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 status metrics.",
    });
  }

  if (!hasConfiguredValue(env.SITE_API_SHARED_SECRET)) {
    issues.push({
      code: "site-api-secret-misconfigured",
      message: "SITE_API_SHARED_SECRET is unset; the website site-api lane cannot authenticate until the shared secret is configured.",
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

  return issues;
}
