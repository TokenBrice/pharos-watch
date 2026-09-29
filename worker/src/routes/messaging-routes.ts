import { TELEGRAM_ADOPTION_API_PATH } from "../lib/telegram/adoption-analytics";
import {
  defineLazyStaticRoute,
  type FullRouteContext,
  type RouteMatch,
  type StaticRouteDefinition,
} from "./shared";

export const TELEGRAM_ADOPTION_ROUTE = {
  dependencies: [] as const,
  methods: ["POST"] as const,
  handle: async (routeCtx: FullRouteContext) => {
    const { handleTelegramAdoption } = await import("../api/telegram-adoption");
    return handleTelegramAdoption(routeCtx);
  },
} satisfies Omit<RouteMatch, "endpoint">;

export { TELEGRAM_ADOPTION_API_PATH };

export const MESSAGING_STATIC_ROUTES = [
  defineLazyStaticRoute("feedback", () =>
    import("../api/feedback").then(
      ({ handleFeedback }) =>
        ({ db, request, feedbackEnv, execCtx }) =>
          handleFeedback(db, request, feedbackEnv, execCtx),
    ),
  ),
  defineLazyStaticRoute("donor-key-claim", () =>
    import("../api/donor-key-claims").then(
      ({ handleDonorKeyClaim }) =>
        ({ db, request, apiKeyHashPepper, donorKeyClaimRateLimit }) =>
          handleDonorKeyClaim(db, request, { rateLimiter: donorKeyClaimRateLimit, pepper: apiKeyHashPepper }),
    ),
  ),
  defineLazyStaticRoute("telegram-mini-app-session", () =>
    import("../api/telegram-mini-app").then(
      ({ handleTelegramMiniAppSession }) =>
        ({ db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout }) =>
          handleTelegramMiniAppSession(db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout),
    ),
  ),
  defineLazyStaticRoute("telegram-mini-app-mutation", () =>
    import("../api/telegram-mini-app").then(
      ({ handleTelegramMiniAppMutation }) =>
        ({ db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout }) =>
          handleTelegramMiniAppMutation(db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout),
    ),
  ),
  defineLazyStaticRoute("telegram-webhook", () =>
    import("../api/telegram-webhook").then(
      ({ handleTelegramWebhook }) =>
        ({
          db,
          request,
          telegramWebhookSecret,
          telegramBotToken,
          telegramWebhookSecretPrevious,
          telegramRecapRollout,
        }) =>
          handleTelegramWebhook(
            db,
            request,
            telegramWebhookSecret,
            telegramBotToken,
            telegramWebhookSecretPrevious,
            telegramRecapRollout,
          ),
    ),
  ),
] as const satisfies readonly StaticRouteDefinition[];
