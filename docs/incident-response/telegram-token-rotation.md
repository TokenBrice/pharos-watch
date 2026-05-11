# Incident Response: Telegram Bot Token Rotation

## When to Rotate

- Suspected exposure of `TELEGRAM_BOT_TOKEN` (committed accidentally, logged, shared).
- Compromised BotFather account suspected; rotate the token via BotFather first.
- Routine rotation cadence (operator policy).

The bot token authenticates every outbound Bot API call: webhook replies, digest posting, subscriber alert fan-out, and cemetery/tracking appendix posts. Rotating it without overlap will strand in-flight messages, including pending queue rows.

## Overlap Window

The Worker accepts `TELEGRAM_BOT_TOKEN_PREVIOUS` as an optional rotation marker validated only for config consistency. Outbound sends and webhook registration always use the current `TELEGRAM_BOT_TOKEN`. The overlap is operator-enforced — keep the prior token usable on BotFather's side until the pending queue has fully drained.

### Gotcha: Pending Queue Stranding

`telegram_pending_alerts` rows are pre-formatted HTML payloads queued for delivery on subsequent dispatch runs. They have a 1-hour TTL. If the old token is invalidated at BotFather (or the new token replaces the old at BotFather without grace) before the queue drains, in-flight pending rows will fail with `401 unauthorized` and be retried with the new token automatically — but any send attempted before the new token is staged in the Worker will return `permanent_failure`.

**Coordinate the rotation so the new token is staged in the Worker before the old token is revoked at BotFather.**

## Procedure

1. **Generate a new token via BotFather.** Use `/revoke` only after step 5 completes.
2. **Stage `TELEGRAM_BOT_TOKEN_PREVIOUS`.** Record the current live value for traceability:

   ```bash
   cd worker
   wrangler secret put TELEGRAM_BOT_TOKEN_PREVIOUS
   # paste the existing live value when prompted
   ```
3. **Set the new current token.**

   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   # paste the new BotFather token when prompted
   ```
4. **Wait one dispatch slot.** The 5-minute Telegram lane will start using the new token on the next run. Confirm via `/api/status` -> `telegramBot` that `messagesSent` continues to advance.
5. **Drain the pending queue.** Inspect `pendingDeliveries` and `oldestPendingDeliveryAgeSec`. Wait until both reach zero before revoking the old token at BotFather. If the queue is stuck, follow [`../runbooks/telegram-rate-limit-storm.md`](../runbooks/telegram-rate-limit-storm.md).
6. **Revoke the old token at BotFather.** Only after step 5.
7. **Remove the previous token from the Worker.**

   ```bash
   wrangler secret delete TELEGRAM_BOT_TOKEN_PREVIOUS
   ```

## Verification Steps

- `/api/status` -> `telegramBot.messagesSent` continues to advance after step 4.
- Test command in a sandbox chat (`/help`) replies successfully.
- `retryErrorClassCounts.unauthorized` does not spike.
- Webhook registration reconciliation succeeds on the next 5-minute slot (logged by `worker/src/lib/telegram-webhook-registration.ts`).

## Rollback

If outbound sends start failing with `401 unauthorized` after step 3:

1. Re-set `TELEGRAM_BOT_TOKEN` to the prior value (preserved in `TELEGRAM_BOT_TOKEN_PREVIOUS`).
2. Confirm dispatch resumes within one 5-minute slot.
3. Do not revoke the old token at BotFather until the discrepancy is understood.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Secrets and Bindings — token binding contract.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — Bot API outbound budget.
- [`docs/architecture.md`](../architecture.md) — Worker secret bindings.
- [`telegram-secret-rotation.md`](./telegram-secret-rotation.md) — for rotating the webhook validation secret.
- [`../runbooks/telegram-no-delivery.md`](../runbooks/telegram-no-delivery.md) — if delivery silently stops mid-rotation.
- [`../runbooks/telegram-rate-limit-storm.md`](../runbooks/telegram-rate-limit-storm.md) — for draining the pending queue.
