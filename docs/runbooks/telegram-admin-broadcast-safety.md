# Runbook: Telegram Admin Broadcast Safety

## Symptom

An operator needs to send a maintenance, recovery, or product notice through `POST /api/admin-telegram-broadcast`.

Admin broadcasts are lower priority than risk alerts. They enqueue into `telegram_pending_alerts` as `source_type = 'admin_broadcast'` with low priority, use a 45-minute TTL, consume the same 1,800-pending-chunks-per-run drain path, and remain held while admin delivery is operator-paused or the bot-wide transport circuit is open.

## Preflight Checklist

1. **Check backlog health.** `/api/status` -> `telegramBot.pendingDeliveries` should be low and decreasing. Do not broadcast if `oldestPendingDeliveryAgeSec > 900`, `crons["dispatch-telegram-alerts"].lastRun.metadata.estimatedDrainTimeSec > 1800`, `crons["dispatch-telegram-alerts"].lastRun.metadata.pendingNearTtlCount > 0`, `pendingDeliveryBacklog.expired > 0`, or `retryErrorClassCounts.rate_limit` dominates.
2. **Run a dry run.**

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: telegram-broadcast-dry-run-$(date +%s)" \
        -H "Content-Type: application/json" \
        --data '{"messageHtml":"<b>Test</b>","scope":"deliverable-watchers","dryRun":true}' \
        https://ops-api.pharos.watch/api/admin-telegram-broadcast
   ```

   Dry-run and live requests both preflight `messageHtml` before target selection. Unsupported Telegram HTML tags/attributes/entities, malformed tags, or unbalanced tags return `422` with an error position and write an admin-audit error. The accepted subset is `a[href]`, `b`/`strong`, `i`/`em`, `u`/`ins`, `s`/`strike`/`del`, `code`, `pre`, `tg-spoiler`, and `blockquote` with optional `expandable`; keep operator notices inside that subset.

3. **Estimate drain time.** Read the dry-run `targetMessageCount` and `deliveryEstimate`. Proceed only when `hasMaterialTtlReserve` is true: estimated fleet drain must leave at least the hard 15-minute reserve inside the 45-minute TTL. The API returns `409` when that reserve is unavailable; no acknowledgement flag can bypass it.
4. **Choose the smallest scope.** Prefer `deliverable-watchers`. Use `global-subscribers` only for global-alert policy notices, and `all` only when intentionally targeting every subscriber row.
5. **Avoid market-event windows.** Do not broadcast during an active depeg, DEWS burst, safety-grade publication issue, or Telegram 429 storm.

## Live Send

Use a stable idempotency key that describes the incident or notice:

```bash
curl -X POST \
     -H "CF-Access-Client-Id: $CF_ID" \
     -H "CF-Access-Client-Secret: $CF_SECRET" \
     -H "X-Pharos-Admin: 1" \
     -H "Idempotency-Key: telegram-broadcast-<incident-or-date>" \
     -H "Content-Type: application/json" \
     --data '{"messageHtml":"<b>Notice</b> ...","scope":"deliverable-watchers","dryRun":false,"canaryChatId":"<private-chat-id>"}' \
     https://ops-api.pharos.watch/api/admin-telegram-broadcast
```

Use a private operator chat that is safe to receive the real notice. Live execution sends every chunk to that chat silently with previews disabled before enqueueing any fleet row, and excludes it from fleet fan-out when it is also in scope. If the canary fails, `fleetEnqueued` remains zero. If the live request returns `409`, rerun the dry run, wait for backlog to drain, narrow the scope, or clear the admin pause/transport incident through the appropriate incident procedure.

## Post-Send Monitoring

1. Watch `telegramBot.pendingDeliveries`, `oldestPendingDeliveryAgeSec`, `crons["dispatch-telegram-alerts"].lastRun.metadata.estimatedDrainTimeSec`, `crons["dispatch-telegram-alerts"].lastRun.metadata.pendingNearTtlCount`, and `retryErrorClassCounts` for at least two five-minute runs.
2. If rate limits appear, stop additional broadcasts and follow [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
3. If pending age approaches 45 minutes, follow [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md).

## Cross-References

- [`docs/api-reference.md`](../api-reference.md) section `POST /api/admin-telegram-broadcast`.
- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue.
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md).
- [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
