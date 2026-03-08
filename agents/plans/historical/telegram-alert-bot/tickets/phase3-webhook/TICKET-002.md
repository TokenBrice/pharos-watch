---
title: "Wire webhook handler into router"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Replace the placeholder 501 handler for `/api/telegram-webhook` in the router with the real webhook handler.

## Task

1. **`worker/src/router.ts`**:

   a. Add import at the top of the file (after other api imports):
   ```typescript
   import { handleTelegramWebhook } from "./api/telegram-webhook";
   ```

   b. Replace the placeholder route in `STATIC_ROUTE_HANDLERS` (which currently returns 501):
   ```typescript
   // Replace:
   ["/api/telegram-webhook", () => Promise.resolve(errorResponse(501, "Not yet implemented"))],
   // With:
   ["/api/telegram-webhook", withErrorHandler("telegram-webhook", ({ db, request, telegramWebhookSecret, telegramBotToken }) =>
     handleTelegramWebhook(db, request!, telegramWebhookSecret, telegramBotToken),
   )],
   ```

   **Important:** Use `telegramBotToken` (the standalone field), NOT `telegramCreds?.botToken`. The `telegramCreds` object requires `TELEGRAM_CHAT_ID` to be set, but the webhook handler only needs `TELEGRAM_BOT_TOKEN`. Using `telegramCreds?.botToken` would silently break the bot when `TELEGRAM_CHAT_ID` is unset.

## Acceptance Criteria

- `grep -c 'handleTelegramWebhook' worker/src/router.ts` returns at least 2 (import + usage)
- `grep -c '501' worker/src/router.ts` returns 0 (placeholder removed)
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
