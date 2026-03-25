import type { EndpointDependency } from "@shared/lib/api-endpoints";
import type { FullRouteContext } from "../../route-registry";
import { buildChainRpcs } from "../../lib/chain-registry";
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
  routeDependencies: readonly EndpointDependency[];
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
      case "chainRpcs":
        routeCtx.chainRpcs = buildChainRpcs(config.env.ALCHEMY_API_KEY, config.env.DRPC_API_KEY);
        break;
      case "coingeckoApiKey":
        routeCtx.coingeckoApiKey = normalizeCgApiKey(config.env.COINGECKO_API_KEY);
        break;
      case "feedbackEnv":
        routeCtx.feedbackEnv = {
          GITHUB_PAT: config.env.GITHUB_PAT,
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
