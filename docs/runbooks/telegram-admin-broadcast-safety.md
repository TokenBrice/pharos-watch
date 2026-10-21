# Runbook: Telegram Admin Broadcast Safety

## Symptom

An operator needs to send a maintenance, recovery, or product notice through `POST /api/admin-telegram-broadcast`.

Admin broadcasts are lower priority than risk alerts. They enqueue into `telegram_pending_alerts` as `source_type = 'admin_broadcast'` with low priority, use a 45-minute TTL, consume the same bounded pending-drain path (`TELEGRAM_PENDING_DRAIN_BUDGET` in `shared/lib/telegram-delivery-policy.ts`), and remain held while admin delivery is operator-paused or the bot-wide transport circuit is open.

## Preflight Checklist

1. **Check backlog health.** `/api/status` -> `telegramBot.pendingDeliveries` should be low and decreasing. Read full run metadata from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` (`cron.runs[0].metadata`). Do not broadcast if `oldestPendingDeliveryAgeSec > 900`, `cron.runs[0].metadata.estimatedDrainTimeSec > 1800`, `cron.runs[0].metadata.pendingNearTtlCount > 0`, `pendingDeliveryBacklog.expired > 0`, or `retryErrorClassCounts.rate_limit` dominates.
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

   Long notices use independently closed/reopened HTML chunks, preserving nested formatting, link/blockquote attributes, entities and text across newlines. The limit includes those tag envelopes; an indivisible envelope that cannot fit is rejected rather than stripped. Review the exact current preview and every silent-canary chunk before fleet enqueue; a split-policy update does not rewrite or replay notices already queued.

   In the operator broadcast panel, live send stays disabled until a successful preview covers the exact current `messageHtml` and audience. Editing either requires a new preview. If a preview response is lost, **Retry same intent** replays the original request body and idempotency key; a successful retry confirms only that original draft, not edits made while its outcome was unknown. Reconcile that intent, then use **Preview (dry run)** to review the edited draft before sending live.

3. **Estimate drain time.** Read the dry-run `targetMessageCount` and `deliveryEstimate`. Proceed only when `hasMaterialTtlReserve` is true: estimated fleet drain must leave at least the hard 15-minute reserve inside the 45-minute TTL. Dry runs return the estimate with `200`; live requests return `409` when the reserve is unavailable. No acknowledgement flag bypasses it.
4. **Choose the smallest scope.** Prefer `deliverable-watchers`. Use `global-subscribers` only for global-alert policy notices, and `all` only when intentionally targeting every subscriber row. Use `retired-launch-opt-ins` only for the one-time launch-retirement notice (`TELEGRAM_LAUNCH_RETIREMENT_NOTICE_HTML`).
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

1. Watch `telegramBot.pendingDeliveries`, `oldestPendingDeliveryAgeSec`, `retryErrorClassCounts`, and the detail payload's `cron.runs[0].metadata.estimatedDrainTimeSec` / `cron.runs[0].metadata.pendingNearTtlCount` (`GET /api/status-cron-detail?job=dispatch-telegram-alerts`) for at least two five-minute runs.
2. If rate limits appear, stop additional broadcasts and follow [rate-limit storm](./telegram-no-delivery.md#rate-limit-storm).
3. If pending age approaches 45 minutes, follow [backlog and expiration](./telegram-no-delivery.md#backlog-and-expiration).

## Cross-References

- [`docs/api-reference-admin.md`](../api-reference-admin.md) section `POST /api/admin-telegram-broadcast`.
- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue.
- [Delivery backlog](./telegram-no-delivery.md#backlog-and-expiration).
- [Rate-limit storm](./telegram-no-delivery.md#rate-limit-storm).
