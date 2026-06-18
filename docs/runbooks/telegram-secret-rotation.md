# Telegram Secret Rotation

Rotate Telegram secrets one at a time. The webhook secret supports a short overlap window; the bot token supports a constant-time overlap window for Mini App `initData` only — outbound Bot API sends always use the current token.

## Webhook Secret

1. Generate a new high-entropy `TELEGRAM_WEBHOOK_SECRET`.
2. Move the current value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and set the new value as `TELEGRAM_WEBHOOK_SECRET`.
3. Deploy the Worker. During the overlap window the webhook accepts either secret, while registration emits only the new secret.
4. Verify registration and live acceptance:

   ```bash
   cd worker
   npx wrangler tail stablecoin-api --format pretty
   ```

   Then send a benign Telegram command and confirm normal `telegram-webhook` handling. Missing- or invalid-secret probes should still return `200 ok` without side effects while emitting throttled `auth-missing-secret` / `auth-invalid-secret` warning records.
5. After Telegram has used the new secret for at least one successful webhook delivery, remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and redeploy.

## Bot Token

1. Create the replacement token in BotFather. Do not revoke the old token until the new Worker is ready.
2. Set `TELEGRAM_BOT_TOKEN_PREVIOUS` to the current token as an operator marker, then set `TELEGRAM_BOT_TOKEN` to the new token.
3. Deploy the Worker. During the `TELEGRAM_BOT_TOKEN_PREVIOUS` overlap, Mini App `initData` signed with the old token remains valid subject to the normal 24-hour read and 5-minute mutation freshness windows. Old-token `initData` is invalidated once the previous token is not configured or is removed.
4. Verify:

   ```bash
   cd worker
   npx wrangler tail stablecoin-api --format pretty
   curl -sS -H "CF-Access-Client-Id: $CF_ID" \
           -H "CF-Access-Client-Secret: $CF_SECRET" \
           https://ops-api.pharos.watch/api/status | jq '.telegramBot'
   ```

   Confirm the five-minute Telegram slot can send, the registration reconciliation succeeds, and `POST /api/telegram-mini-app/session` accepts fresh Mini App launches.
5. Revoke the old token in BotFather only after verification. Remove `TELEGRAM_BOT_TOKEN_PREVIOUS` in a follow-up deploy.

## Rollback

If sends, registration, or Mini App auth fail after token rotation, restore the previous `TELEGRAM_BOT_TOKEN` and redeploy. Existing Mini App sessions signed by the failed new token will become invalid after rollback; ask operators to relaunch the Mini App for validation.

## Mini App impact

- `validateTelegramMiniAppInitData` tries `TELEGRAM_BOT_TOKEN` first, then `TELEGRAM_BOT_TOKEN_PREVIOUS` when configured. Both branches compare with the same constant-time routine.
- Keep `TELEGRAM_BOT_TOKEN_PREVIOUS` set until the session window expires for users still on the old token (24h). Mutation auth resets every 5 minutes regardless, so live mutations migrate quickly.
- Remove `TELEGRAM_BOT_TOKEN_PREVIOUS` after at least 24h to fail closed for stale leaked tokens. Outbound Bot API sends never use the previous token.
