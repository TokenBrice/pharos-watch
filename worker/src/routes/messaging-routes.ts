import { handleApiKeyRequest, handleApiKeyRequestVerify } from "../api/api-key-requests";
import { handleFeedback } from "../api/feedback";
import { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } from "../api/telegram-mini-app";
import { handleTelegramWebhook } from "../api/telegram-webhook";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const MESSAGING_STATIC_ROUTES = [
  defineStaticRoute("feedback", ({ db, request, feedbackEnv }) => handleFeedback(db, request, feedbackEnv)),
  defineStaticRoute("api-key-requests", ({ db, request, apiKeySelfServeEnv, execCtx }) =>
    handleApiKeyRequest(db, request, apiKeySelfServeEnv, execCtx)),
  defineStaticRoute("api-key-request-verify", ({ db, request, apiKeySelfServeEnv, apiKeyHashPepper, execCtx }) =>
    handleApiKeyRequestVerify(db, request, apiKeySelfServeEnv, apiKeyHashPepper, execCtx)),
  defineStaticRoute("telegram-mini-app-session", ({ db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout }) =>
    handleTelegramMiniAppSession(db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout)),
  defineStaticRoute("telegram-mini-app-mutation", ({ db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout }) =>
    handleTelegramMiniAppMutation(db, request, telegramBotToken, telegramBotTokenPrevious, telegramRecapRollout)),
  defineStaticRoute("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious, telegramRecapRollout }) =>
    handleTelegramWebhook(db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious, telegramRecapRollout)),
] as const satisfies readonly StaticRouteDefinition[];
