# Runbook: Telegram Rate-Limit Storm

## Symptom

The pending delivery queue is growing run-over-run, and a large share of the dispatcher's retry classes is `rate_limit` (HTTP 429).

Detection signals:

- `/api/status` -> `telegramBot.pendingDeliveries` trends upward across consecutive runs.
- `telegramBot.retryErrorClassCounts.rate_limit` dominates.
- Watchdog alert from P0-O4: `pendingDeliveries > 500` sustained for >20 min triggers an operator alert on the standard `sendAlert()` rail.
- `oldestPendingDeliveryAgeSec` approaching `PENDING_TTL_SEC` (3600).

## Quick Diagnostic Checklist

1. **Is it global or per-chat?** With per-chat rate-limit isolation (P0-R3), one chat's 429 no longer cascades to others. Inspect `telegramBot.retryErrorClassCounts` together with `pendingDeliveryBacklog.deferred` — heavy `deferred` against a small set of chats means per-chat backoff is doing its job.
2. **Telegram Bot API global limit hit?** Sustained 429 across many distinct chats indicates global throttling rather than per-chat backoff. Cross-reference [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for the 6-connection-per-trigger cap; the dispatcher batches at 4 to stay under it.
3. **Single chat starving the queue?** A chat with 100+ subscriptions can dominate the per-run cap (200). The per-chat `not_before_at` backoff prevents starvation, but inspect via the admin chat endpoint:

   ```bash
   curl -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        https://ops-api.pharos.watch/api/admin-telegram-chat/<chatId>
   ```
4. **Watchdog firing?** Confirm whether the watchdog alert has already been raised (P0-O4). If so, an operator notification is in flight.

## Remediation

1. **Wait one drain cycle.** Each dispatch run drains up to 25% of its budget from the pending queue. If `pendingDeliveries` is decreasing run-over-run, no action.
2. **Clear pending queue for a specific chat.** Use the admin pending endpoint, filtered. This is an idempotent admin mutation; include Cloudflare Access service-token headers, `X-Pharos-Admin: 1`, and an `Idempotency-Key`.

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: clear-telegram-pending-<chatId>-$(date +%s)" \
        "https://ops-api.pharos.watch/api/telegram-pending?chat_id=<chatId>"
   ```

   Expected response: `{ "ok": true, "deleted": <number> }`. Repeating the same filtered clear after rows are gone is safe and returns `deleted: 0`.
3. **Clear stale rows past TTL.** Filtered by age:

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: clear-telegram-pending-older-than-3600-$(date +%s)" \
        "https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=3600"
   ```

   The endpoint accepts exactly one query filter: `chat_id` or `older_than_sec`. It refuses unfiltered requests and requests with both filters by design.
4. **Investigate root cause.** If 429 is sustained without an obvious driver, check Cloudflare logs for outbound Telegram POSTs and confirm no client is replaying historical events through a non-production dispatcher.
5. **Last resort: pause the dispatcher.** Open the `telegram_api` circuit breaker via the admin reset-circuit-breaker endpoint (used inverted to skip fan-out) only after coordinating with operators — this stops all alert delivery, not just retries.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue — retry/TTL contract and dedupe-key semantics.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — connection-budget operating assumption and rate-limit isolation note.
- [`docs/architecture.md`](../architecture.md) — cron topology.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — when no messages are going out at all (a storm can present as no delivery).
