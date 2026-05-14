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
  defineStaticRoute("telegram-mini-app-session", ({ db, request, telegramBotToken }) =>
    handleTelegramMiniAppSession(db, request, telegramBotToken)),
  defineStaticRoute("telegram-mini-app-mutation", ({ db, request, telegramBotToken }) =>
    handleTelegramMiniAppMutation(db, request, telegramBotToken)),
  defineStaticRoute("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious }) =>
    handleTelegramWebhook(db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious)),
] as const satisfies readonly StaticRouteDefinition[];
