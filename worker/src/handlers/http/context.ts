import type { FullRouteContext, RouteDependency } from "../../route-registry";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { resolveMintBurnFreshnessConfig } from "../../lib/mint-burn-health-config";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { Env } from "../../lib/env";

export function buildRouteContext(config: {
  request: Request;
  url: URL;
  env: Env;
  execCtx: ExecutionContext;
  trustedAdmin: boolean;
  routeDependencies: readonly RouteDependency[];
}): FullRouteContext {
  const routeCtx: FullRouteContext = {
    url: config.url,
    db: config.env.DB,
    execCtx: config.execCtx,
    request: config.request,
    trustedAdmin: config.trustedAdmin,
  };

  for (const dependency of config.routeDependencies) {
    switch (dependency) {
      case "alchemyApiKey":
        routeCtx.alchemyApiKey = config.env.ALCHEMY_API_KEY ?? null;
        break;
      case "anthropicApiKey":
        routeCtx.anthropicApiKey = config.env.ANTHROPIC_API_KEY ?? null;
        break;
      case "coingeckoApiKey":
        routeCtx.coingeckoApiKey = normalizeCgApiKey(config.env.COINGECKO_API_KEY);
        break;
      case "feedbackEnv":
        routeCtx.feedbackEnv = {
          GITHUB_PAT: config.env.GITHUB_PAT,
          GITHUB_REPO_NODE_ID: config.env.GITHUB_REPO_NODE_ID,
          GITHUB_DISCUSSION_CATEGORY_ID: config.env.GITHUB_DISCUSSION_CATEGORY_ID,
          FEEDBACK_IP_SALT: config.env.FEEDBACK_IP_SALT,
        };
        break;
      case "mintBurnFreshnessConfig":
        routeCtx.mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(config.env);
        break;
      case "telegram":
        routeCtx.telegramCreds = buildTelegramCreds(config.env);
        routeCtx.telegramWebhookSecret = config.env.TELEGRAM_WEBHOOK_SECRET;
        routeCtx.telegramBotToken = config.env.TELEGRAM_BOT_TOKEN;
        break;
    }
  }

  return routeCtx;
}
