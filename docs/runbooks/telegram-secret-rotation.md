# Telegram Secret Rotation

Rotate Telegram secrets one at a time. The webhook secret supports a short overlap window; the bot token does not, because Telegram Mini App `initData` HMACs and outbound Bot API sends use only the current token.

## Webhook Secret

1. Generate a new high-entropy `TELEGRAM_WEBHOOK_SECRET`.
2. Move the current value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and set the new value as `TELEGRAM_WEBHOOK_SECRET`.
3. Deploy the Worker. During the overlap window the webhook accepts either secret, while registration emits only the new secret.
4. Verify registration and live acceptance:

   ```bash
   cd worker
   npx wrangler tail stablecoin-api --format pretty
   ```

   Then send a benign Telegram command and confirm normal `telegram-webhook` handling. Invalid-secret probes should still return `200 ok` without side effects.
5. After Telegram has used the new secret for at least one successful webhook delivery, remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` and redeploy.

## Bot Token

1. Create the replacement token in BotFather. Do not revoke the old token until the new Worker is ready.
2. Set `TELEGRAM_BOT_TOKEN_PREVIOUS` to the current token as an operator marker, then set `TELEGRAM_BOT_TOKEN` to the new token.
3. Deploy the Worker. This invalidates existing Mini App `initData`; users with an open Mini App may need to relaunch it before mutations work.
4. Verify:

   ```bash
   cd worker
   npx wrangler tail stablecoin-api --format pretty
   curl -sS https://api.pharos.watch/api/status | jq '.telegramBot'
   ```

   Confirm the five-minute Telegram slot can send, the registration reconciliation succeeds, and `POST /api/telegram-mini-app/session` accepts fresh Mini App launches.
5. Revoke the old token in BotFather only after verification. Remove `TELEGRAM_BOT_TOKEN_PREVIOUS` in a follow-up deploy.

## Rollback

If sends, registration, or Mini App auth fail after token rotation, restore the previous `TELEGRAM_BOT_TOKEN` and redeploy. Existing Mini App sessions signed by the failed new token will become invalid after rollback; ask operators to relaunch the Mini App for validation.
