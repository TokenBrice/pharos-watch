import type { EndpointDependency } from "@shared/lib/api-endpoints";
import { buildChainRpcs } from "../lib/chain-registry";
import { normalizeCgApiKey } from "../lib/coingecko";
import type { Env } from "../lib/env";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { buildTelegramCreds } from "../lib/runtime-credentials";
import { resolveTelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";
import type { FullRouteContext } from "./shared";
import { normalizeWorkerCanaryMode } from "../lib/worker-canary-mode";

type RouteDependencyHydrator = (routeCtx: FullRouteContext, env: Env) => void;

export const ROUTE_DEPENDENCY_HYDRATORS = {
  apiKeyHashPepper(routeCtx, env) {
    routeCtx.apiKeyHashPepper = env.API_KEY_HASH_PEPPER;
  },
  alchemyApiKey(routeCtx, env) {
    routeCtx.alchemyApiKey = env.ALCHEMY_API_KEY ?? null;
  },
  anthropicApiKey(routeCtx, env) {
    routeCtx.anthropicApiKey = env.ANTHROPIC_API_KEY ?? null;
  },
  cloudflareD1StatusConfig(routeCtx, env) {
    routeCtx.cloudflareD1StatusBindings = {
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_D1_STATUS_API_TOKEN: env.CLOUDFLARE_D1_STATUS_API_TOKEN,
      CLOUDFLARE_D1_DATABASE_ID: env.CLOUDFLARE_D1_DATABASE_ID,
    };
  },
  chainRpcs(routeCtx, env) {
    routeCtx.chainRpcs = buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  },
  coingeckoApiKey(routeCtx, env) {
    routeCtx.coingeckoApiKey = normalizeCgApiKey(env.COINGECKO_API_KEY);
  },
  apiKeySelfServeEnv(routeCtx, env) {
    routeCtx.apiKeySelfServeEnv = {
      API_KEY_SELF_SERVE_IP_SALT: env.API_KEY_SELF_SERVE_IP_SALT,
      API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER,
      API_KEY_SELF_SERVE_REQUEST_PEPPER: env.API_KEY_SELF_SERVE_REQUEST_PEPPER,
      API_KEY_SELF_SERVE_EMAIL_FROM: env.API_KEY_SELF_SERVE_EMAIL_FROM,
      API_KEY_SELF_SERVE_EMAIL_REPLY_TO: env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO,
      API_KEY_SELF_SERVE_PUBLIC_BASE_URL: env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL,
      RESEND_API_KEY: env.RESEND_API_KEY,
    };
  },
  feedbackEnv(routeCtx, env) {
    routeCtx.feedbackEnv = {
      GITHUB_PAT: env.GITHUB_PAT,
      FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
    };
  },
  mintBurnFreshnessConfig(routeCtx, env) {
    routeCtx.mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  },
  workerStatusConfig(routeCtx, env) {
    routeCtx.workerCanaryMode = normalizeWorkerCanaryMode(env.WORKER_CANARY_MODE);
  },
  workerVersion(routeCtx, env) {
    routeCtx.workerVersion = env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id || null;
  },
  telegram(routeCtx, env) {
    routeCtx.telegramCreds = buildTelegramCreds(env);
    routeCtx.telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    routeCtx.telegramWebhookSecretPrevious = env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
    routeCtx.telegramBotToken = env.TELEGRAM_BOT_TOKEN;
    routeCtx.telegramBotTokenPrevious = env.TELEGRAM_BOT_TOKEN_PREVIOUS;
  },
  telegramRecapRollout(routeCtx, env) {
    routeCtx.telegramRecapRollout = resolveTelegramRecapRolloutPolicy(env);
  },
  // The `satisfies Record<EndpointDependency, …>` above is the coverage proof:
  // a declared dependency without a hydrator fails to typecheck.
} satisfies Record<EndpointDependency, RouteDependencyHydrator>;
