import type { EndpointDependency } from "@shared/lib/api-endpoints";
import type { FullRouteContext } from "../../route-registry";
import { buildChainRpcs } from "../../lib/chain-registry";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { resolveMintBurnFreshnessConfig } from "../../lib/mint-burn-health-config";
import { buildTelegramCreds } from "../../lib/runtime-credentials";
import type { Env } from "../../lib/env";

type RouteDependencyHydrator = (routeCtx: FullRouteContext, env: Env) => void;

const ROUTE_DEPENDENCY_HYDRATORS = {
  alchemyApiKey(routeCtx, env) {
    routeCtx.alchemyApiKey = env.ALCHEMY_API_KEY ?? null;
  },
  anthropicApiKey(routeCtx, env) {
    routeCtx.anthropicApiKey = env.ANTHROPIC_API_KEY ?? null;
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
    routeCtx.telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  },
} satisfies Record<EndpointDependency, RouteDependencyHydrator>;

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
    ROUTE_DEPENDENCY_HYDRATORS[dependency](routeCtx, config.env);
  }

  return routeCtx;
}
