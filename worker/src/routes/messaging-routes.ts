import { defineLazyStaticRoute, type StaticRouteDefinition } from "./shared";

export const MESSAGING_STATIC_ROUTES = [
  defineLazyStaticRoute("feedback", () =>
    import("../api/feedback").then(
      ({ handleFeedback }) =>
        ({ db, request, feedbackEnv }) =>
          handleFeedback(db, request, feedbackEnv),
    ),
  ),
  defineLazyStaticRoute("api-key-requests", () =>
    import("../api/api-key-requests").then(
      ({ handleApiKeyRequest }) =>
        ({ db, request, apiKeySelfServeEnv, execCtx }) =>
          handleApiKeyRequest(db, request, apiKeySelfServeEnv, execCtx),
    ),
  ),
  defineLazyStaticRoute("api-key-request-verify", () =>
    import("../api/api-key-requests").then(
      ({ handleApiKeyRequestVerify }) =>
        ({ db, request, apiKeySelfServeEnv, apiKeyHashPepper, execCtx }) =>
          handleApiKeyRequestVerify(db, request, apiKeySelfServeEnv, apiKeyHashPepper, execCtx),
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
