import { handleFeedback } from "../api/feedback";
import { handleTelegramWebhook } from "../api/telegram-webhook";
import { defineStaticRoute, type StaticRouteDefinition } from "./shared";

export const MESSAGING_STATIC_ROUTES = [
  defineStaticRoute("feedback", ({ db, request, feedbackEnv }) => handleFeedback(db, request, feedbackEnv)),
  defineStaticRoute("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious }) =>
    handleTelegramWebhook(db, request, telegramWebhookSecret, telegramBotToken, telegramWebhookSecretPrevious)),
] as const satisfies readonly StaticRouteDefinition[];
