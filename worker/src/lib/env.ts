export interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  SELF_URL?: string;
  OPS_UI_ORIGIN?: string;
  OPS_API_ORIGIN?: string;
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
  PUBLIC_API_RATE_LIMIT_SALT?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MINT_BURN_DISABLED_IDS?: string;
  MINT_BURN_DISABLED_SYMBOLS?: string;
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
  OPENEXCHANGERATES_API_KEY?: string;
  MAINTENANCE_MODE?: string;
}

export const PUBLIC_API_RATE_LIMIT_SALT_FALLBACK = "pharos-public-api-rate-limit";

export const WORKER_REQUIRED_ENV_KEYS = [
  "DB",
  "CORS_ORIGIN",
] as const;

export const WORKER_OPTIONAL_ENV_KEYS = [
  "SELF_URL",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_OPS_API_AUD",
  "ETHERSCAN_API_KEY",
  "TRONGRID_API_KEY",
  "DRPC_API_KEY",
  "ALCHEMY_API_KEY",
  "GRAPH_API_KEY",
  "ALERT_WEBHOOK_URL",
  "ANTHROPIC_API_KEY",
  "CMC_API_KEY",
  "COINGECKO_API_KEY",
  "GITHUB_PAT",
  "FEEDBACK_IP_SALT",
  "PUBLIC_API_RATE_LIMIT_SALT",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "MINT_BURN_DISABLED_IDS",
  "MINT_BURN_DISABLED_SYMBOLS",
  "MINT_BURN_MAJOR_SYMBOLS",
  "MINT_BURN_STALE_WARN_SEC",
  "MINT_BURN_STALE_CRIT_SEC",
  "MINT_BURN_ALERT_COOLDOWN_SEC",
  "OPENEXCHANGERATES_API_KEY",
  "MAINTENANCE_MODE",
] as const;

export const WORKER_RESERVED_ENV_KEYS = [
  "OPS_UI_ORIGIN",
  "OPS_API_ORIGIN",
  "CF_ACCESS_OPS_UI_AUD",
] as const;

export const WORKER_ACTIVE_ENV_KEYS = [
  ...WORKER_REQUIRED_ENV_KEYS,
  ...WORKER_OPTIONAL_ENV_KEYS,
] as const;

export interface WorkerEnvIssue {
  code:
    | "ops-access-partial-config"
    | "public-api-rate-limit-fallback";
  message: string;
}

export interface ResolvedPublicApiRateLimitSalt {
  salt: string;
  source: "public-api-rate-limit-salt" | "feedback-ip-salt" | "built-in-fallback";
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function hasConfiguredValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolvePublicApiRateLimitSalt(
  env: Pick<Env, "PUBLIC_API_RATE_LIMIT_SALT" | "FEEDBACK_IP_SALT">,
): ResolvedPublicApiRateLimitSalt {
  if (hasConfiguredValue(env.PUBLIC_API_RATE_LIMIT_SALT)) {
    return {
      salt: env.PUBLIC_API_RATE_LIMIT_SALT!.trim(),
      source: "public-api-rate-limit-salt",
    };
  }

  if (hasConfiguredValue(env.FEEDBACK_IP_SALT)) {
    return {
      salt: env.FEEDBACK_IP_SALT!.trim(),
      source: "feedback-ip-salt",
    };
  }

  return {
    salt: PUBLIC_API_RATE_LIMIT_SALT_FALLBACK,
    source: "built-in-fallback",
  };
}

export function validateWorkerEnvContract(
  env: Pick<Env, "CF_ACCESS_OPS_API_AUD" | "CF_ACCESS_TEAM_DOMAIN" | "PUBLIC_API_RATE_LIMIT_SALT" | "FEEDBACK_IP_SALT">,
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

  if (resolvePublicApiRateLimitSalt(env).source === "built-in-fallback") {
    issues.push({
      code: "public-api-rate-limit-fallback",
      message: "PUBLIC_API_RATE_LIMIT_SALT and FEEDBACK_IP_SALT are both unset; public API rate limiting is using the built-in fallback salt.",
    });
  }

  return issues;
}
