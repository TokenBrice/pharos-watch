# Incident Response: Telegram Webhook Secret Rotation

## When to Rotate

- Routine rotation cadence (operator policy).
- Suspected exposure of `TELEGRAM_WEBHOOK_SECRET` (logs, screenshots, third-party access).
- After staff offboarding with access to Worker secrets.

The secret is only ever used to authenticate inbound `POST /api/telegram-webhook` via `X-Telegram-Bot-Api-Secret-Token`. It is not used by outbound Bot API calls — token rotation is a separate procedure ([`telegram-token-rotation.md`](./telegram-token-rotation.md)).

## Overlap Window

Receiver behavior accepts either `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` whenever both are configured. Webhook registration and reconciliation always send only the current secret. The 24-hour overlap is an operator-enforced policy — there is no timestamp check in the Worker. See [`docs/telegram-alerts.md`](../telegram-alerts.md) section Webhook Secret Rotation.

## Procedure

1. **Generate the new secret.** 32+ random bytes, URL-safe.
2. **Stage `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`.** Set it to the current live value:

   ```bash
   cd worker
   wrangler secret put TELEGRAM_WEBHOOK_SECRET_PREVIOUS
   # paste the existing live value when prompted
   ```
3. **Set the new current secret.**

   ```bash
   wrangler secret put TELEGRAM_WEBHOOK_SECRET
   # paste the new value when prompted
   ```
4. **Trigger reconciliation.** The dedicated 5-minute Telegram lane reconciles the webhook automatically via `worker/src/lib/telegram-webhook-registration.ts`. Wait one cron slot (max 5 min), or force it manually:

   ```bash
   scripts/register-telegram-webhook.sh
   ```

   Reconciliation sends only the new current `TELEGRAM_WEBHOOK_SECRET` to Telegram's `setWebhook`.
5. **Verify Telegram is using the new secret.** Trigger a benign command in a test chat (e.g. `/help`) and confirm the reply lands. Webhook ingress logs should show successful secret validation against the current value.
6. **Wait out the overlap.** Keep `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` configured for up to 24 hours as a safety net against in-flight retries Telegram may still be sending with the old secret.
7. **Remove the previous secret.**

   ```bash
   wrangler secret delete TELEGRAM_WEBHOOK_SECRET_PREVIOUS
   ```

## Verification Steps

- `/api/status` does not regress (no spike in webhook-validation failures).
- `/help` in a test chat returns the help message.
- Cloudflare logs show no recent rejections on `POST /api/telegram-webhook` for valid Telegram updates.
- Webhook registration response includes `"ok": true` from Telegram's `setWebhook`.

## Rollback

If after step 4 the bot stops responding to commands:

1. Re-set `TELEGRAM_WEBHOOK_SECRET` to the prior value (still preserved in `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`).
2. Re-run `scripts/register-telegram-webhook.sh`.
3. Investigate the discrepancy before re-attempting rotation.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Webhook Secret Rotation — canonical contract.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — secret-validation cost on the webhook path.
- [`docs/architecture.md`](../architecture.md) — Worker secret bindings.
- [`telegram-token-rotation.md`](./telegram-token-rotation.md) — for rotating the bot token itself.
- [`../runbooks/telegram-no-delivery.md`](../runbooks/telegram-no-delivery.md) — if delivery silently stops mid-rotation.
