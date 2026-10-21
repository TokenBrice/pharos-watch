import { defineLazyStaticRoute, type StaticRouteDefinition } from "./shared";

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
    import("../telegram/mini-app/telegram-mini-app").then(
      ({ handleTelegramMiniAppSession }) =>
        ({ db, request, telegramBotToken, telegramBotTokenPrevious }) =>
          handleTelegramMiniAppSession(db, request, telegramBotToken, telegramBotTokenPrevious),
    ),
  ),
  defineLazyStaticRoute("telegram-mini-app-mutation", () =>
    import("../telegram/mini-app/telegram-mini-app").then(
      ({ handleTelegramMiniAppMutation }) =>
        ({ db, request, telegramBotToken, telegramBotTokenPrevious }) =>
          handleTelegramMiniAppMutation(db, request, telegramBotToken, telegramBotTokenPrevious),
    ),
  ),
  defineLazyStaticRoute("telegram-webhook", () =>
    import("../telegram/webhook/telegram-webhook").then(
      ({ handleTelegramWebhook }) =>
        ({
          db,
          request,
          telegramWebhookSecret,
          telegramBotToken,
          telegramWebhookSecretPrevious,
        }) =>
          handleTelegramWebhook(
            db,
            request,
            telegramWebhookSecret,
            telegramBotToken,
            telegramWebhookSecretPrevious,
          ),
    ),
  ),
] as const satisfies readonly StaticRouteDefinition[];
