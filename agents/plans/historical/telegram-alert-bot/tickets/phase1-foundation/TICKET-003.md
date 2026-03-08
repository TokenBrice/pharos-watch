---
title: "Register webhook endpoint + route context + rate limiter exemption"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Register the `/api/telegram-webhook` endpoint, add the webhook secret to the route context, and exempt the webhook path from the IP rate limiter.

## Task

1. **`shared/lib/api-endpoints.ts`** — Add a new entry to the `ENDPOINT_DEFINITIONS` array (after the `feedback` entry, around line ~242):

```typescript
{
  path: "/api/telegram-webhook",
  methods: ["POST"],
  adminRequired: false,
  mutatingAdmin: false,
  cacheBypass: true,
},
```

2. **`worker/src/router.ts`** — Add `telegramWebhookSecret` and `telegramBotToken` to the `RouteContext` interface (line ~48) and the `route()` function signature (line ~252):

In `RouteContext` interface, add after `telegramCreds`:
```typescript
telegramWebhookSecret?: string;
telegramBotToken?: string;
```

**Why `telegramBotToken` is separate from `telegramCreds`:** The existing `telegramCreds` object is only constructed in `http.ts` when BOTH `TELEGRAM_BOT_TOKEN` AND `TELEGRAM_CHAT_ID` are set (for the digest bot). The webhook handler only needs the bot token, not the chat ID. Passing `telegramBotToken` separately ensures the webhook works even if `TELEGRAM_CHAT_ID` is unset.

In the `route()` function signature, add two new parameters after `telegramCreds`:
```typescript
telegramWebhookSecret?: string,
telegramBotToken?: string,
```

Pass both through to the context object inside `staticHandler` call (line ~275):
```typescript
telegramWebhookSecret,
telegramBotToken,
```

**Important:** Do NOT set `routerHandled: false` on the endpoint definition — the default `true` is correct and required for the startup assertion at lines 219-228 to work properly.

Note: Do NOT add a route handler for `/api/telegram-webhook` to `STATIC_ROUTE_HANDLERS` yet — that is done in Phase 3. The endpoint definition in `api-endpoints.ts` will temporarily not have a matching router handler. To prevent the startup assertion error at lines 219-228 (which checks that every router-handled path has a handler), the endpoint must be added to `STATIC_ROUTE_HANDLERS` as a placeholder that returns 501:

```typescript
["/api/telegram-webhook", () => Promise.resolve(errorResponse(501, "Not yet implemented"))],
```

This placeholder will be replaced with the real handler in Phase 3.

3. **`worker/src/handlers/http.ts`** — Two changes:

   a. **Rate limiter exemption** (line ~101): Change the condition to skip rate limiting for the webhook path:
   ```typescript
   // Before:
   if (url.pathname.startsWith("/api/") && !isAdminRequest(request, env.ADMIN_KEY)) {
   // After:
   if (url.pathname.startsWith("/api/") && url.pathname !== "/api/telegram-webhook" && !isAdminRequest(request, env.ADMIN_KEY)) {
   ```

   b. **Pass webhook secret and bot token to route()** (line ~122-134): Add `env.TELEGRAM_WEBHOOK_SECRET` and `env.TELEGRAM_BOT_TOKEN` as new arguments after `telegramCreds` in the `route()` call:
   ```typescript
   const response = await route(
     url,
     env.DB,
     ctx,
     request,
     env.ADMIN_KEY,
     env.ALCHEMY_API_KEY ?? null,
     mintBurnFreshnessConfig,
     feedbackEnv,
     env.ANTHROPIC_API_KEY ?? null,
     twitterCreds,
     telegramCreds,
     env.TELEGRAM_WEBHOOK_SECRET,  // ← new
     env.TELEGRAM_BOT_TOKEN,       // ← new (separate from telegramCreds)
   );
   ```

## Acceptance Criteria

- `grep -c 'telegram-webhook' shared/lib/api-endpoints.ts` returns at least 1
- `grep -c 'telegramWebhookSecret' worker/src/router.ts` returns at least 3 (interface + function sig + context pass-through)
- `grep -c 'telegramBotToken' worker/src/router.ts` returns at least 3 (interface + function sig + context pass-through)
- `grep -c 'telegram-webhook' worker/src/handlers/http.ts` returns at least 1
- `grep -c 'TELEGRAM_WEBHOOK_SECRET' worker/src/handlers/http.ts` returns 1
- `grep -c 'TELEGRAM_BOT_TOKEN' worker/src/handlers/http.ts` returns at least 2 (existing + new route arg)
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
