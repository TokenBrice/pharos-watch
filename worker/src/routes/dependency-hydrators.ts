import type { EndpointDependency } from "@shared/lib/api-endpoints";
import { buildChainRpcs } from "../lib/chain-registry";
import { normalizeCgApiKey } from "../lib/coingecko";
import type { Env } from "../lib/env";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { buildTelegramCreds } from "../lib/runtime-credentials";
import type { FullRouteContext } from "./shared";

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
  feedbackEnv(routeCtx, env) {
    routeCtx.feedbackEnv = {
      GITHUB_PAT: env.GITHUB_PAT,
      FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
    };
  },
  mintBurnFreshnessConfig(routeCtx, env) {
    routeCtx.mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  },
  telegram(routeCtx, env) {
    routeCtx.telegramCreds = buildTelegramCreds(env);
    routeCtx.telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    routeCtx.telegramWebhookSecretPrevious = env.TELEGRAM_WEBHOOK_SECRET_PREVIOUS;
    routeCtx.telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  },
} satisfies Record<EndpointDependency, RouteDependencyHydrator>;
